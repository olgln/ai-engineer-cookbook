// Serves the built site (dist/) locally with full-text search and the progress API.
// With --watch (used by `npm start`) it also rebuilds the site when the book or the site sources change,
// swaps the new build in only if it succeeded, and tells open pages to reload.
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BOOK_DIR, DIST_DIR, GENERATED_PATHS, LOCALES, NEXT_DIST_DIR, OLD_DIST_DIR, PROGRESS_API_PATH,
  REBUILD_DEBOUNCE_MS, RELOAD_EVENTS_PATH, RELOAD_SCRIPT_PATH, SECURITY_HEADERS,
} from '../src/config/app.mjs';
import { config } from '../src/config/server.mjs';
import { progressHandler } from './serve/progress-handler.mjs';
import { staticHandler } from './serve/static-server.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(SITE, '..');
const DIST = path.join(SITE, DIST_DIR);
const WATCH = process.argv.includes('--watch');
const api = progressHandler();
const files = staticHandler({ root: DIST, reloadScript: WATCH ? RELOAD_SCRIPT_PATH : undefined });

// ---------- live reload ----------
const clients = new Set();
const RELOAD_SCRIPT = `new EventSource(${JSON.stringify(RELOAD_EVENTS_PATH)}).onmessage = () => location.reload();\n`;

function reloadEvents(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(': connected\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function reloadScript(res) {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
  res.end(RELOAD_SCRIPT);
}

const notifyReload = () => { for (const res of clients) res.write('data: reload\n\n'); };

http
  .createServer((req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === PROGRESS_API_PATH) return api(req, res);
    if (WATCH && pathname === RELOAD_EVENTS_PATH) return reloadEvents(req, res);
    if (WATCH && pathname === RELOAD_SCRIPT_PATH) return reloadScript(res);
    files(req, res);
  })
  .listen(config.port, config.host, () => {
    console.log(`Study site: http://${config.host}:${config.port}/  (Ctrl+C to stop)`);
    if (WATCH) startWatching();
  });

// ---------- rebuild on change ----------
const GENERATED = GENERATED_PATHS.map((p) => path.join(SITE, p));
const isGenerated = (file) => GENERATED.some((g) => file === g || file.startsWith(g + path.sep));

/** Watched places: a directory, whether to descend into it, and which changed files count. */
const WATCHED = [
  { dir: path.join(ROOT, BOOK_DIR), recursive: true, accept: (f) => f.endsWith('.md') },
  // the plan of every language (README.md, README.en.md)
  { dir: ROOT, recursive: false, accept: (f) => LOCALES.some((l) => l.planFile === path.basename(f)) },
  { dir: path.join(SITE, 'src'), recursive: true, accept: (f) => !isGenerated(f) },
  { dir: SITE, recursive: false, accept: (f) => /^(astro|ec)\.config\.mjs$/.test(path.basename(f)) },
];

let timer = null;
let building = false;
let pending = false;

function startWatching() {
  for (const { dir, recursive, accept } of WATCHED) {
    fs.watch(dir, { recursive }, (_event, name) => {
      if (name && accept(path.join(dir, name.toString()))) schedule();
    });
  }
  console.log('Watching the book and the site sources: the site rebuilds after each save.');
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(rebuild, REBUILD_DEBOUNCE_MS);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    spawn(cmd, args, { cwd: SITE, stdio: 'inherit' })
      .on('error', () => resolve(false))
      .on('exit', (code) => resolve(code === 0));
  });
}

async function rebuild() {
  if (building) {
    pending = true;
    return;
  }
  building = true;
  const started = Date.now();
  console.log('\nChange detected, rebuilding…');
  const next = path.join(SITE, NEXT_DIST_DIR);
  const old = path.join(SITE, OLD_DIST_DIR);
  fs.rmSync(next, { recursive: true, force: true });
  if (await run('npm', ['run', 'build', '--', '--outDir', NEXT_DIST_DIR])) {
    fs.rmSync(old, { recursive: true, force: true });
    if (fs.existsSync(DIST)) fs.renameSync(DIST, old);
    fs.renameSync(next, DIST);
    fs.rmSync(old, { recursive: true, force: true });
    console.log(`Rebuilt in ${((Date.now() - started) / 1000).toFixed(1)}s, reloading open pages.`);
    notifyReload();
  } else {
    console.error('Build failed: still serving the previous version. Fix the error and save again.');
  }
  building = false;
  if (pending) {
    pending = false;
    rebuild();
  }
}
