'use strict';
/**
 * Synchronous Postgres client with the subset of the better-sqlite3 API that LifegenTracker uses:
 *   db.prepare(sql).get/all/run(params)   db.exec(sql)   db.transaction(fn)   db.pragma(str)   db.close()
 * Queries run on a worker thread that owns the single connection; the main thread waits with
 * Atomics.wait(). This keeps every route, service and test exactly as written for SQLite while the
 * data lives in Supabase / any Postgres. One connection per process is all this app needs.
 */
const { Worker, MessageChannel, receiveMessageOnPort } = require('worker_threads');
const { translate, translateScript } = require('./sqlite-to-pg');
require('pg'); // static require so serverless bundlers (Vercel/nft) always ship the driver for the worker

const QUERY_TIMEOUT_MS = 25000;

// Worker source is embedded (not loaded by path) so the single-file build and Vercel's bundler both work.
const WORKER_SOURCE = `
const { workerData } = require('worker_threads');
const { Client, types } = require(workerData.pgPath);
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));   // int8 (COUNT, SUM) → number, like SQLite
types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // numeric
types.setTypeParser(700, parseFloat); types.setTypeParser(701, parseFloat);
const signal = new Int32Array(workerData.signal);
const port = workerData.port;
let client = null;
async function connect() {
  const url = workerData.url;
  const local = /localhost|127\\.0\\.0\\.1|host=\\/|sslmode=disable/.test(url);
  const c = new Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, keepAlive: true });
  await c.connect();
  c.on('error', () => { if (client === c) client = null; }); // dropped connection → reconnect on next query
  try { await c.query('SET statement_timeout = 20000'); } catch (e) { /* pooler may not allow it */ }
  client = c;
}
function reply(id, msg) {
  port.postMessage({ id, ...msg });
  Atomics.store(signal, 0, 1);
  Atomics.notify(signal, 0);
}
const CONN_ERR = /ECONNRESET|EPIPE|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|terminat|not queryable|Connection ended/i;
port.on('message', async (req) => {
  try {
    if (!client) await connect();
    if (req.op === 'query') {
      const r = await client.query({ text: req.text, values: req.values });
      reply(req.id, { ok: true, rows: r.rows, rowCount: r.rowCount });
    } else if (req.op === 'exec') {
      await client.query(req.text); // simple protocol: several statements, no params
      reply(req.id, { ok: true });
    } else if (req.op === 'close') {
      if (client) await client.end().catch(() => {});
      reply(req.id, { ok: true });
      process.exit(0);
    } else reply(req.id, { ok: false, error: { message: 'unknown op ' + req.op } });
  } catch (e) {
    if (CONN_ERR.test(String(e.message)) || /^(08|57P)/.test(String(e.code || ''))) { try { client && client.end().catch(() => {}); } catch {} client = null; }
    reply(req.id, { ok: false, error: { message: e.message, code: e.code, constraint: e.constraint, detail: e.detail, table: e.table } });
  }
});
`;

class PgSyncDatabase {
  constructor(url) {
    this.url = url;
    this.dialect = 'pg';
    this.open = true;
    this._txDepth = 0;
    this._deferFk = false;
    this._idTables = null;
    const { port1, port2 } = new MessageChannel();
    this._port = port1;
    this._seq = 0;
    this._signal = new Int32Array(new SharedArrayBuffer(4));
    this._worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { url, signal: this._signal.buffer, port: port2, pgPath: require.resolve('pg') },
      transferList: [port2],
    });
    this._worker.unref();
    this._worker.on('error', (e) => { this._workerError = e; });
    this._worker.on('exit', () => { if (this.open) this._workerError = new Error('Database worker exited'); });
    this._bootstrap();
  }

  // ---- low level -----------------------------------------------------------
  _call(msg) {
    if (!this.open) throw new Error('The database connection is not open');
    if (this._workerError) throw this._workerError;
    const id = ++this._seq;
    const deadline = Date.now() + QUERY_TIMEOUT_MS;
    Atomics.store(this._signal, 0, 0);
    this._port.postMessage({ id, ...msg });
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('Database query timed out');
      Atomics.wait(this._signal, 0, 0, left);
      Atomics.store(this._signal, 0, 0);
      let got, res = null;
      while ((got = receiveMessageOnPort(this._port))) if (got.message.id === id) res = got.message; // older ids = stale replies from a timed-out call
      if (res) {
        if (!res.ok) throw this._mapError(res.error, msg.text);
        return res;
      }
    }
  }

  _mapError(e, sql) {
    const err = new Error(e.message + (e.constraint ? ` (${e.constraint})` : '') + (e.detail ? ` — ${e.detail}` : ''));
    // Make the app's SQLite-style checks work: isSqliteUnique(err, 'email_normalized')
    if (e.code === '23505') err.code = 'SQLITE_CONSTRAINT_UNIQUE';
    else if (e.code === '23503') err.code = 'SQLITE_CONSTRAINT_FOREIGNKEY';
    else if (e.code === '23514') err.code = 'SQLITE_CONSTRAINT_CHECK';
    else if (e.code === '23502') err.code = 'SQLITE_CONSTRAINT_NOTNULL';
    else err.code = e.code || 'PG_ERROR';
    err.pgCode = e.code; err.constraint = e.constraint; err.sql = sql;
    return err;
  }

  _query(text, values) { return this._call({ op: 'query', text, values }); }

  _bootstrap() {
    // SUM(boolean) works like SQLite's SUM(expr = value); created once per database.
    this._call({ op: 'exec', text: `
      CREATE OR REPLACE FUNCTION lg_bool_sum(bigint, boolean) RETURNS bigint LANGUAGE sql IMMUTABLE
        AS 'SELECT $1 + CASE WHEN $2 THEN 1 ELSE 0 END';
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_aggregate a JOIN pg_proc p ON p.oid = a.aggfnoid WHERE p.proname = 'sum' AND p.proargtypes::text = (SELECT oid FROM pg_type WHERE typname = 'bool')::text) THEN
          CREATE AGGREGATE sum(boolean) (SFUNC = lg_bool_sum, STYPE = bigint, INITCOND = '0');
        END IF;
      END $$;` });
  }

  _tablesWithId() {
    if (!this._idTables) {
      const r = this._query("SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id'", []);
      this._idTables = new Set(r.rows.map((x) => x.table_name));
    }
    return this._idTables;
  }

  // ---- better-sqlite3 surface ---------------------------------------------
  prepare(sql) {
    if (/^\s*PRAGMA\s+table_info\((\w+)\)/i.test(sql)) {
      const table = /table_info\((\w+)\)/i.exec(sql)[1];
      return { all: () => this._query('SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position', [table]).rows, get: () => null, run: () => ({ changes: 0 }) };
    }
    const t = translate(sql);
    const bind = (args) => {
      if (t.names.length) {
        const obj = args[0] || {};
        return t.names.map((n) => norm(obj[n]));
      }
      if (args.length === 1 && Array.isArray(args[0])) return args[0].map(norm);
      if (args.length === 1 && args[0] && typeof args[0] === 'object') return []; // named-param object, statement needs none
      return args.map(norm);
    };
    const self = this;
    return {
      get(...args) { return self._query(t.text, bind(args)).rows[0]; },
      all(...args) { return self._query(t.text, bind(args)).rows; },
      run(...args) {
        let text = t.text;
        if (t.kind === 'CREATE' || t.kind === 'ALTER' || t.kind === 'DROP') self._idTables = null;
        if (t.kind === 'INSERT' && !/RETURNING/i.test(text) && t.table && self._tablesWithId().has(t.table)) text += ' RETURNING id';
        const r = self._query(text, bind(args));
        return { changes: r.rowCount, lastInsertRowid: r.rows && r.rows[0] ? r.rows[0].id : undefined };
      },
      pluck() { const s = this; return { get: (...a) => { const row = s.get(...a); return row ? Object.values(row)[0] : undefined; }, all: (...a) => s.all(...a).map((row) => Object.values(row)[0]) }; },
    };
  }

  exec(sql) {
    this._idTables = null; // may contain DDL
    this._call({ op: 'exec', text: translateScript(sql) });
  }

  pragma(str) {
    const s = String(str).trim().toLowerCase();
    if (s === 'foreign_key_check') return [];
    if (s.startsWith('foreign_keys')) { if (s.includes('=')) this._deferFk = /off|0|false/.test(s); return [{ foreign_keys: this._deferFk ? 0 : 1 }]; }
    return []; // journal_mode / synchronous etc. have no Postgres meaning
  }

  transaction(fn) {
    const self = this;
    const wrapped = function (...args) {
      const nested = self._txDepth > 0;
      const sp = `lg_sp_${self._txDepth}`;
      if (nested) self._query(`SAVEPOINT ${sp}`, []); else { self._query('BEGIN', []); if (self._deferFk) self._query('SET CONSTRAINTS ALL DEFERRED', []); }
      self._txDepth += 1;
      try {
        const out = fn(...args);
        self._txDepth -= 1;
        if (nested) self._query(`RELEASE SAVEPOINT ${sp}`, []); else self._query('COMMIT', []);
        return out;
      } catch (e) {
        self._txDepth -= 1;
        try { if (nested) self._query(`ROLLBACK TO SAVEPOINT ${sp}`, []); else self._query('ROLLBACK', []); } catch { /* connection error — surface original */ }
        throw e;
      }
    };
    wrapped.deferred = wrapped; wrapped.immediate = wrapped; wrapped.exclusive = wrapped;
    return wrapped;
  }

  /** After a restore with explicit ids, move identity sequences past the data (Postgres only). */
  resyncSequences() {
    const r = this._query("SELECT table_name FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'id' AND is_identity = 'YES'", []);
    for (const t of r.rows.map((x) => x.table_name)) {
      this._query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT MAX(id) FROM ${t}), 0) + 1, false)`, []);
    }
  }

  backup() { return Promise.reject(new Error('not implemented')); }

  close() {
    if (!this.open) return;
    try { this._call({ op: 'close' }); } catch { /* ignore */ }
    this.open = false;
    this._worker.terminate().catch(() => {});
  }
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

module.exports = PgSyncDatabase;
