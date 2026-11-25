// Test server: serves docs/ and, under /__gh/, the mock GitHub API (same origin, so the page's CSP allows it).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'docs');
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
export function serve({ port = 0, gh = null } = {}) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      if (gh && req.url.startsWith('/__gh/')) return gh.handle(req, res, req.url.slice('/__gh'.length));
      try {
        let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (rel.endsWith('/')) rel += 'index.html';
        const file = path.normalize(path.join(root, rel));
        if (!file.startsWith(root)) throw new Error('outside');
        if (!(await stat(file)).isFile()) throw new Error('not a file');
        res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(await readFile(file));
      } catch { res.writeHead(404).end('Not found'); }
    }).listen(port, '127.0.0.1', () => resolve({ srv, port: srv.address().port, close: () => srv.close() }));
  });
}
