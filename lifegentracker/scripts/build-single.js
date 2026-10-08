#!/usr/bin/env node
'use strict';
/**
 * Bundles the whole LifegenTracker app (server, routes, SQL migrations, and the
 * complete front-end) into ONE JavaScript file: single-file/lifegentracker.js
 *
 *   node scripts/build-single.js
 *
 * The generated file only needs Node.js and the two npm packages that cannot be
 * embedded (express + the native SQLite driver):
 *
 *   npm install express better-sqlite3 qrcode
 *   node lifegentracker.js
 *
 * How it works: every source file is stored as a string inside the bundle; a tiny
 * module loader replaces `require('./...')` for internal files, a virtual `fs`
 * serves the SQL migrations, and `express.static` is swapped for an in-memory
 * static handler that serves the embedded public/ files.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'single-file');
const OUT = path.join(OUT_DIR, 'lifegentracker.js');

const TEXT_EXT = new Set(['.js', '.html', '.css', '.svg', '.sql', '.json', '.txt', '.md']);
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join('/');

// 1. Collect files -----------------------------------------------------------
const moduleFiles = ['server.js', 'scripts/reset-password.js', ...walk(path.join(ROOT, 'src')).map(rel).filter((f) => f.endsWith('.js'))];
const assetFiles = [...walk(path.join(ROOT, 'public')).map(rel), ...walk(path.join(ROOT, 'src/db/migrations')).map(rel)];

const assets = {};
for (const f of assetFiles) {
  const ext = path.extname(f).toLowerCase();
  const buf = fs.readFileSync(path.join(ROOT, f));
  assets[f] = TEXT_EXT.has(ext) ? { enc: 'utf8', data: buf.toString('utf8') } : { enc: 'base64', data: buf.toString('base64') };
}

const modules = {};
for (const f of moduleFiles) {
  let src = fs.readFileSync(path.join(ROOT, f), 'utf8').replace(/^#!.*\n/, '');
  if (f === 'server.js') {
    // SPA fallback: serve the embedded index.html instead of a file on disk.
    src = src.replace("res.sendFile(path.join(PUBLIC_DIR, 'index.html'));", "res.type('html').send(__asset('public/index.html'));");
    src = src.replace("res.sendFile(path.join(PUBLIC_DIR, 'register.html'));", "res.type('html').send(__asset('public/register.html'));");
    // Inside the bundle server.js is not the main module, but the single file must still listen.
    src = src.replace("if (require.main === module || process.env.LIFEGEN_FORCE_LISTEN === '1') {", "if (true) {");
  }
  modules[f] = src;
}

// 2. Emit bundle ----------------------------------------------------------------
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const stamp = new Date().toISOString();

let out = `#!/usr/bin/env node
'use strict';
/*
 * LifegenTracker ${pkg.version} — single-file build (generated ${stamp})
 * Lifegiver Church of Faith · Lifegen / 3rd Service attendance
 *
 * Run:
 *   npm install express better-sqlite3 qrcode
 *   node lifegentracker.js                      # http://localhost:3000
 *
 * Options (environment variables):
 *   PORT=3000  HOST=0.0.0.0  LIFEGEN_AUTH=on|off  LIFEGEN_DATA_DIR=./data  LIFEGEN_DB_FILE=./data/lifegen.db
 *
 * Admin lockout: node lifegentracker.js reset-password <username> <new-password>
 *
 * This file is generated from the LifegenTracker source tree by scripts/build-single.js.
 * Edit the source tree, not this file.
 */
const __realFs = require('fs');
const __path = require('path');
const __realExpress = require('express');

const __VROOT = '/__lifegentracker__';
const __ASSETS = ${JSON.stringify(assets)};
const __SOURCES = {
${Object.entries(modules).map(([f, src]) => `  ${JSON.stringify(f)}: ${JSON.stringify(src)},`).join('\n')}
};

// Default data directory: next to this file (overridable with LIFEGEN_DATA_DIR / LIFEGEN_DB_FILE).
if (!process.env.LIFEGEN_DATA_DIR && !process.env.LIFEGEN_DB_FILE) process.env.LIFEGEN_DATA_DIR = __path.join(__path.dirname(__filename), 'data');

function __asset(key) {
  const a = __ASSETS[key];
  if (!a) return undefined;
  return a.enc === 'utf8' ? a.data : Buffer.from(a.data, 'base64');
}
const __toKey = (p) => { p = String(p).split(__path.sep).join('/'); return p.startsWith(__VROOT + '/') ? p.slice(__VROOT.length + 1) : null; };

// Virtual fs: embedded files first, real disk otherwise.
const __fs = new Proxy(__realFs, {
  get(target, prop) {
    if (prop === 'readFileSync') return (p, opt) => { const k = __toKey(p); if (k && __ASSETS[k]) { const v = __asset(k); return typeof opt === 'string' || (opt && opt.encoding) ? (Buffer.isBuffer(v) ? v.toString(typeof opt === 'string' ? opt : opt.encoding) : v) : (Buffer.isBuffer(v) ? v : Buffer.from(v)); } return target.readFileSync(p, opt); };
    if (prop === 'readdirSync') return (p, opt) => { const k = __toKey(p); if (k !== null) { const prefix = k + '/'; return Object.keys(__ASSETS).filter((f) => f.startsWith(prefix) && !f.slice(prefix.length).includes('/')).map((f) => f.slice(prefix.length)); } return target.readdirSync(p, opt); };
    if (prop === 'existsSync') return (p) => { const k = __toKey(p); if (k !== null) return k in __ASSETS || Object.keys(__ASSETS).some((f) => f.startsWith(k + '/')); return target.existsSync(p); };
    return target[prop];
  },
});

// In-memory static file handler for the embedded public/ folder.
const __MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
function __virtualStatic(root, opts = {}) {
  const base = __toKey(root) || 'public';
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let p = decodeURIComponent(req.path);
    if (p.endsWith('/')) p += opts.index || 'index.html';
    const key = base + p;
    const body = __asset(key);
    if (body === undefined) return next();
    res.setHeader('Content-Type', __MIME[__path.extname(key).toLowerCase()] || 'application/octet-stream');
    res.send(body);
  };
}
const __express = function (...a) { return __realExpress(...a); };
Object.assign(__express, __realExpress);
__express.static = __virtualStatic;

// Tiny CommonJS loader for the embedded modules.
const __cache = {};
function __resolve(from, req) {
  if (!req.startsWith('.') && !req.startsWith('/')) return null;
  const baseDir = __path.posix.dirname(from);
  const target = __path.posix.normalize(__path.posix.join(baseDir, req));
  for (const c of [target, target + '.js', target + '/index.js']) if (c in __SOURCES) return c;
  return null;
}
function __load(key) {
  if (__cache[key]) return __cache[key].exports;
  const module = { exports: {} };
  __cache[key] = module;
  const dirname = __VROOT + '/' + __path.posix.dirname(key);
  const filename = __VROOT + '/' + key;
  const localRequire = (req) => {
    if (req === 'fs' || req === 'node:fs') return __fs;
    if (req === 'express') return __express;
    const k = __resolve(key, req);
    if (k) return __load(k);
    return require(req);
  };
  localRequire.resolve = require.resolve;
  const fn = new Function('module', 'exports', 'require', '__filename', '__dirname', '__asset', __SOURCES[key]);
  fn(module, module.exports, localRequire, filename, dirname, __asset);
  return module.exports;
}

// Entry point ---------------------------------------------------------------
if (process.argv[2] === 'reset-password') {
  process.argv.splice(2, 1);
  __load('scripts/reset-password.js');
} else {
  __load('server.js');
}
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, out);
fs.writeFileSync(
  path.join(OUT_DIR, 'package.json'),
  JSON.stringify({ name: 'lifegentracker-single', version: pkg.version, private: true, description: 'LifegenTracker single-file build', main: 'lifegentracker.js', scripts: { start: 'node lifegentracker.js' }, engines: pkg.engines, dependencies: { express: pkg.dependencies.express, 'better-sqlite3': pkg.dependencies['better-sqlite3'], qrcode: pkg.dependencies.qrcode, libsql: pkg.dependencies.libsql, pg: pkg.dependencies.pg } }, null, 2) + '\n'
);
fs.writeFileSync(
  path.join(OUT_DIR, 'README.md'),
  `# LifegenTracker — single-file build

Everything (server, database migrations, and the whole web app) is inside **lifegentracker.js**.

## Run it

1. Install Node.js 18 or newer — https://nodejs.org
2. Put \`lifegentracker.js\` and \`package.json\` in a folder, open a terminal there and run:

   \`\`\`bash
   npm install
   node lifegentracker.js
   \`\`\`

3. Open http://localhost:3000

The database is created automatically at \`./data/lifegen.db\` next to the file — back up that one file.

## Options

| Variable | Default | Meaning |
|---|---|---|
| \`PORT\` | 3000 | Port to listen on |
| \`LIFEGEN_AUTH\` | on | \`off\` = no sign-in, everyone is Admin (demo only) |
| \`LIFEGEN_DATA_DIR\` | ./data | Where the database lives |

Forgot the admin password: \`node lifegentracker.js reset-password <username> <new-password>\`

Generated ${stamp} by scripts/build-single.js — regenerate after changing the source.
`
);

const size = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`Built ${rel(OUT)} (${size} KB) from ${moduleFiles.length} modules + ${assetFiles.length} assets.`);
