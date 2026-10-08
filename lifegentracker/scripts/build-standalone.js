#!/usr/bin/env node
'use strict';
/**
 * Builds standalone/index.html — the complete LifegenTracker app in ONE HTML file
 * that runs without any server. Double-click to open; data lives in the browser.
 *
 *   node scripts/build-standalone.js
 *
 * How: the CSS is inlined; every ES module (views, ui, charts, …) is embedded as a
 * data: URL and wired together with an import map; public/js/api.js is swapped for
 * standalone/local-api.js (localStorage engine) and the Settings view for
 * standalone/settings-local.js (backup / restore).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const JS = path.join(ROOT, 'public', 'js');
const OUT = path.join(ROOT, 'standalone', 'index.html');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]));
const toPosix = (p) => p.split(path.sep).join('/');

// Module id = path relative to public/js, e.g. "views/people.js"
const modules = {};
for (const abs of walk(JS)) {
  if (!abs.endsWith('.js')) continue;
  const id = toPosix(path.relative(JS, abs));
  modules[id] = fs.readFileSync(abs, 'utf8');
}
// Standalone replacements
modules['api.js'] = fs.readFileSync(path.join(ROOT, 'standalone', 'local-api.js'), 'utf8');
modules['views/settings.js'] = fs.readFileSync(path.join(ROOT, 'standalone', 'settings-local.js'), 'utf8');

// Rewrite relative import specifiers to bare module ids resolved by the import map.
const resolveSpec = (fromId, spec) => toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(fromId), spec)));
const importMap = { imports: {} };
for (const [id, src] of Object.entries(modules)) {
  const rewritten = src.replace(/(from\s*|import\s*\(\s*|import\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (m, lead, q, spec) => {
    const target = resolveSpec(id, spec);
    if (!modules[target]) throw new Error(`${id}: cannot resolve import ${spec}`);
    return `${lead}${q}lg:${target}${q}`;
  });
  importMap.imports[`lg:${id}`] = 'data:text/javascript;base64,' + Buffer.from(rewritten, 'utf8').toString('base64');
}

const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'styles.css'), 'utf8');
const favicon = fs.readFileSync(path.join(ROOT, 'public', 'favicon.svg'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const stamp = new Date().toISOString();

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#ffffff" />
<title>LifegenTracker</title>
<!--
  LifegenTracker ${pkg.version} — standalone single-file build (generated ${stamp})
  Lifegiver Church of Faith · Lifegen / 3rd Service attendance

  No server, no installation: open this file in Chrome, Edge, Safari or Firefox.
  All records are stored in this browser (localStorage). Use Settings → Backup regularly.
  Generated from the LifegenTracker source by scripts/build-standalone.js — edit the source, not this file.
-->
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(favicon)}" />
<style>
${css}
</style>
<script type="importmap">${JSON.stringify(importMap)}</script>
</head>
<body>
<a class="skip-link" href="#main" id="skipLink">Skip to content</a>
<div id="app"><div class="loading" style="min-height:100vh">Loading…</div></div>
<div id="modalRoot"></div>
<div id="toastRoot" class="toasts" aria-live="polite"></div>
<noscript><p style="padding:24px;font-family:sans-serif">LifegenTracker needs JavaScript enabled.</p></noscript>
<script type="module">
  import 'lg:app.js';
</script>
<script>
  // Friendly message if the browser is too old for import maps.
  if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('importmap')) {
    document.getElementById('app').innerHTML = '<div style="padding:32px;font-family:sans-serif;max-width:520px;margin:auto"><h2>Please update your browser</h2><p>LifegenTracker needs a recent browser (Chrome/Edge 89+, Safari 16.4+, Firefox 108+).</p></div>';
  }
</script>
</body>
</html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`Built ${toPosix(path.relative(ROOT, OUT))} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB, ${Object.keys(modules).length} modules).`);
