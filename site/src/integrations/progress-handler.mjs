// Shared handler for GET/PUT of the progress API.
// Progress lives outside the repo so nobody has to commit it; the location comes
// from PROGRESS_FILE (see .env.example and src/config/server.mjs).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROGRESS_FILE_HEADER } from '../config/app.mjs';
import { config } from '../config/server.mjs';

/** Path for display: home directory shortened to ~ */
const displayPath = (file) => (file.startsWith(os.homedir() + path.sep) ? '~' + file.slice(os.homedir().length) : file);

/** Host name without the port: "127.0.0.1:4321" → "127.0.0.1", "[::1]:4321" → "[::1]". */
const hostName = (value = '') => value.replace(/:\d+$/, '').toLowerCase();

/**
 * Only the study site itself may use the API: the Host header must be a known local name
 * (blocks DNS rebinding), and a browser Origin, when sent, must be the same host (blocks
 * other pages in the same browser).
 */
function isTrusted(req, allowedHosts) {
  const host = hostName(req.headers.host);
  if (!allowedHosts.has(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host.toLowerCase() === req.headers.host.toLowerCase();
  } catch {
    return false;
  }
}

export function progressHandler(file = config.progressFile, maxBytes = config.progressMaxBytes, allowedHosts = config.allowedHosts) {
  return (req, res) => {
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader(PROGRESS_FILE_HEADER, encodeURIComponent(displayPath(file)));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(body);
    };
    if (!isTrusted(req, allowedHosts)) return send(403, '{"error":"forbidden"}');
    if (req.method === 'GET') {
      return send(200, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}');
    }
    if (req.method !== 'PUT') return send(405, '{"error":"method not allowed"}');
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
        if (!isObject(data) || !isObject(data.chapters)) throw new Error('bad shape');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
        fs.renameSync(tmp, file);
        send(200, '{"ok":true}');
      } catch (e) {
        send(400, JSON.stringify({ error: String(e.message || e) }));
      }
    });
  };
}
