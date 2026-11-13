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

export function progressHandler(file = config.progressFile, maxBytes = config.progressMaxBytes) {
  return (req, res) => {
    const send = (code, body) => {
      res.statusCode = code;
      res.setHeader(PROGRESS_FILE_HEADER, encodeURIComponent(displayPath(file)));
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(body);
    };
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
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.chapters !== 'object') throw new Error('bad shape');
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
