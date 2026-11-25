// store.js — keep a game's signed log in a git repo, so it outlives every tab and can be played at any pace.
//
// One JSON file per game, committed through GitHub's REST "contents" API: one commit per event (a move,
// an offer, a reply…). The repo is storage and transport, never an authority: what a page loads from it is
// replayed and signature-checked exactly like a log received from a peer, so the host (or anyone with
// write access) cannot forge or alter a move. They can delete or roll back the file; the page then keeps
// its own longer copy and writes it back.
//
// Two file forms:
//   encrypted (default)  {format, v, readable:false, iv, data}  AES-GCM, key = HKDF(invite secret). Only
//                        people with the link can read the game. Commit messages say only "event 12".
//   readable             {format, v, readable:true, pgn, events}  plain moves, one event per line, and commit
//                        messages like "12... Nf6 (Bob)": the repo's history reads as the game.
//
// Concurrency: every write carries the sha it was based on. If someone else committed first, GitHub refuses
// (409/422); the caller loads the newer file, settles the two logs (log.js `choose`) and writes again.

import { b64u } from './log.js';

const FORMAT = 'chess-webCLI/game';
const STORE_LABEL = 'chess-webCLI/v1/store';
const FILE_LABEL = 'chess-webCLI/v1/file';
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = { enc: (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); }, dec: (str) => Uint8Array.from(atob(String(str).replace(/\s/g, '')), (c) => c.charCodeAt(0)) };

export const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
export const PATH_RE = /^[A-Za-z0-9._/-]{1,200}\.json$/;
export const BRANCH_RE = /^[A-Za-z0-9._/-]{1,100}$/;

export class StoreError extends Error {
  constructor(message, { status = 0, conflict = false } = {}) { super(message); this.status = status; this.conflict = conflict; }
}

// A file name derived from the secret, so the path in the repo says nothing about the room.
export async function defaultPath(secret) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array([...enc.encode(FILE_LABEL), ...secret])));
  return `chess-webCLI/${[...h.slice(0, 8)].map((x) => x.toString(16).padStart(2, '0')).join('')}.json`;
}

async function fileKey(secret) {
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(STORE_LABEL) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// One event per line, so a readable file diffs move by move in git.
function pretty(obj, events) {
  const head = JSON.stringify({ ...obj, events: '__EV__' }, null, 2);
  const body = events.length ? '[\n' + events.map((e) => '    ' + JSON.stringify(e)).join(',\n') + '\n  ]' : '[]';
  return head.replace('"__EV__"', body) + '\n';
}

export async function encodeFile(events, { secret, readable, pgn = '' }) {
  if (readable) return pretty({ format: FORMAT, v: 1, readable: true, pgn }, events);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await fileKey(secret), enc.encode(JSON.stringify(events))));
  return JSON.stringify({ format: FORMAT, v: 1, readable: false, iv: b64u.enc(iv), data: b64u.enc(data) }, null, 2) + '\n';
}

export async function decodeFile(text, { secret }) {
  let f;
  try { f = JSON.parse(text); } catch { throw new StoreError('The game file in the repo is not JSON.'); }
  if (f?.format !== FORMAT) throw new StoreError('That file is not a chess-webCLI game.');
  if (f.v !== 1) throw new StoreError(`The game file is version ${f.v}; this page reads version 1.`);
  if (f.readable) {
    if (!Array.isArray(f.events)) throw new StoreError('The game file has no events.');
    return { events: f.events, readable: true };
  }
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64u.dec(f.iv) }, await fileKey(secret), b64u.dec(f.data));
    const events = JSON.parse(dec.decode(plain));
    if (!Array.isArray(events)) throw new Error('no events');
    return { events, readable: false };
  } catch { throw new StoreError('The game file could not be decrypted with this link. It belongs to another game, or the link is wrong.'); }
}

export class GitStore {
  // repo "owner/name"; token optional for reading a public repo, needed to write.
  constructor({ repo, branch = 'main', path, token = '', secret, readable = false, api = 'https://api.github.com', fetchFn = (...a) => globalThis.fetch(...a) }) {
    if (!REPO_RE.test(repo || '')) throw new StoreError('The repo must look like owner/name.');
    if (!PATH_RE.test(path || '') || path.includes('..') || path.startsWith('/')) throw new StoreError('The file path must be a relative path ending in .json.');
    if (!BRANCH_RE.test(branch)) throw new StoreError('That branch name is not valid.');
    Object.assign(this, { repo, branch, path, token, secret, readable, api: api.replace(/\/$/, ''), fetchFn });
    this.sha = null; this.etag = null; this.lastText = null; this.requests = 0;
  }
  get webUrl() { return `https://github.com/${this.repo}/blob/${encodeURIComponent(this.branch)}/${this.path}`; }
  get historyUrl() { return `https://github.com/${this.repo}/commits/${encodeURIComponent(this.branch)}/${this.path}`; }
  url() { return `${this.api}/repos/${this.repo}/contents/${this.path.split('/').map(encodeURIComponent).join('/')}`; }
  headers(extra = {}) {
    const h = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }
  async request(url, init) {
    this.requests++;
    let res;
    try { res = await this.fetchFn(url, { cache: 'no-store', referrerPolicy: 'no-referrer', credentials: 'omit', ...init }); }
    catch (e) { throw new StoreError(`Could not reach ${new URL(url).host} (${e.message}).`); }
    return res;
  }
  static async explain(res) {
    let msg = '';
    try { msg = (await res.json())?.message || ''; } catch {}
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 401) return 'The token was refused (401). Check it is still valid.';
    if (res.status === 403 && remaining === '0') return 'GitHub\'s rate limit is used up for now. Without a token it is 60 requests an hour; with one, 5,000.';
    if (res.status === 403) return `GitHub refused (403): ${msg || 'the token lacks permission'}. The token needs "Contents: read and write" on this repo.`;
    if (res.status === 404) return 'Repo, branch or file not found (404). For a private repo the token must have access to it.';
    return `GitHub answered ${res.status}${msg ? ': ' + msg : ''}.`;
  }

  // -> { events, changed } ; events = [] when the file does not exist yet.
  async load() {
    const res = await this.request(`${this.url()}?ref=${encodeURIComponent(this.branch)}`, { headers: this.headers(this.etag ? { 'If-None-Match': this.etag } : {}) });
    if (res.status === 304) return { events: null, changed: false };
    if (res.status === 404) {
      // a missing file is a new game; a missing repo or branch is an error worth saying
      const probe = await this.request(`${this.api}/repos/${this.repo}`, { headers: this.headers() });
      if (!probe.ok) throw new StoreError(await GitStore.explain(probe), { status: probe.status });
      this.sha = null; this.etag = null;
      return { events: [], changed: true };
    }
    if (!res.ok) throw new StoreError(await GitStore.explain(res), { status: res.status });
    const j = await res.json();
    this.sha = j.sha; this.etag = res.headers.get('etag');
    const text = new TextDecoder().decode(b64.dec(j.content || ''));
    this.lastText = text;
    const { events, readable } = await decodeFile(text, { secret: this.secret });
    this.readable = readable;
    return { events, changed: true };
  }

  // Commit the whole log. Throws StoreError{conflict:true} if the file moved on since our last load.
  async save(events, message, { pgn = '' } = {}) {
    if (!this.token) throw new StoreError('A token is needed to commit to the repo.');
    const text = await encodeFile(events, { secret: this.secret, readable: this.readable, pgn });
    const body = { message: String(message).slice(0, 200), content: b64.enc(enc.encode(text)), branch: this.branch };
    if (this.sha) body.sha = this.sha;
    const res = await this.request(this.url(), { method: 'PUT', headers: this.headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) {
      let msg = ''; try { msg = (await res.clone().json())?.message || ''; } catch {}
      if (res.status === 409 || /sha/i.test(msg)) throw new StoreError('Someone committed first.', { status: res.status, conflict: true });
      throw new StoreError(await GitStore.explain(res), { status: res.status });
    }
    if (!res.ok) throw new StoreError(await GitStore.explain(res), { status: res.status });
    const j = await res.json();
    this.sha = j.content?.sha || null; this.etag = null; this.lastText = text;
    return { sha: this.sha, commit: j.commit?.sha || null, url: j.commit?.html_url || null };
  }
}
