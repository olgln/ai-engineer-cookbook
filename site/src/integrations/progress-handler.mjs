// Shared handler for GET/PUT /api/progress, stores site/progress.json.
import fs from 'node:fs';

const MAX_BYTES = 2 * 1024 * 1024;

export function progressHandler(file) {
  return (req, res) => {
    const send = (code, body) => {
      res.statusCode = code;
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
      if (size > MAX_BYTES) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.chapters !== 'object') throw new Error('bad shape');
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
