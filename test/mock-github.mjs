// A small stand-in for GitHub's REST contents API, for tests: GET/PUT one file with sha checks, ETags
// (304), a repo probe, a token check on writes, and a record of every commit made.
import { createHash } from 'node:crypto';
export function mockGitHub({ repo = 'ann/chess-games', tokens = ['tok-ann', 'tok-bob'], publicRepo = true } = {}) {
  const files = new Map(); // path -> { text, sha }
  const commits = [];
  const sha = (t) => createHash('sha1').update(t).digest('hex');
  const json = (res, code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers }); res.end(JSON.stringify(obj)); };
  const authed = (req) => tokens.includes(String(req.headers.authorization || '').replace(/^Bearer /, ''));
  const who = (req) => String(req.headers.authorization || '').replace(/^Bearer tok-/, '');
  async function handle(req, res, rest) {
    const url = new URL(rest, 'http://x');
    const m = /^\/repos\/([^/]+\/[^/]+)(?:\/contents\/(.+))?$/.exec(url.pathname);
    if (!m || m[1] !== repo) return json(res, 404, { message: 'Not Found' });
    if (!publicRepo && !authed(req)) return json(res, 404, { message: 'Not Found' });
    if (!m[2]) return json(res, 200, { full_name: repo, private: !publicRepo });
    const path = decodeURIComponent(m[2]);
    if (req.method === 'GET') {
      const f = files.get(path);
      if (!f) return json(res, 404, { message: 'Not Found' });
      const etag = `"${f.sha}"`;
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag }); return res.end(); }
      return json(res, 200, { sha: f.sha, path, content: Buffer.from(f.text).toString('base64').replace(/(.{60})/g, '$1\n') }, { ETag: etag });
    }
    if (req.method === 'PUT') {
      if (!authed(req)) return json(res, 401, { message: 'Bad credentials' });
      let body = ''; for await (const c of req) body += c;
      const b = JSON.parse(body);
      const cur = files.get(path);
      if (cur && b.sha !== cur.sha) return json(res, 409, { message: `${path} does not match ${b.sha}` });
      if (!cur && b.sha) return json(res, 422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
      const text = Buffer.from(b.content, 'base64').toString('utf8');
      const s = sha(text);
      files.set(path, { text, sha: s });
      const c = { sha: sha(s + commits.length), message: b.message, author: who(req), path, text };
      commits.push(c);
      return json(res, cur ? 200 : 201, { content: { sha: s, path }, commit: { sha: c.sha, html_url: `https://github.com/${repo}/commit/${c.sha}` } });
    }
    json(res, 405, { message: 'Method not allowed' });
  }
  return { handle, files, commits, repo };
}
