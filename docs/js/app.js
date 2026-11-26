// chess-webCLI — the page.
//
// Modes:
//   engine    you against the local search engine (engine.js, in a worker). Zero egress.
//   local     pass and play on one device. Zero egress.
//   analysis  a free board: any side moves, load FEN/PGN, ask the engine. Zero egress.
//   room      two players and any number of watchers, directly between browsers (Trystero over
//             Nostr relays for introductions, WebRTC data channels for the moves).
//
// In every mode the game is the same thing: an event log (log.js) replayed through the rules engine
// (chess.js). In a room every event is signed by the seat that wrote it and every peer checks it.

import { Chess, START_FEN } from './chess.js';
import { parseIntent, describeMove, describePosition, COMMANDS } from './intent.js';
import { LEVELS, formatScore } from './engine.js';
import { BoundedAI, MODELS, MODEL_HOSTS, MAX_ATTEMPTS } from './ai.js';
import { PROTO, b64u, replay, nextEvent, signEvent, newSeatKey, importSeatKey, keyIdOf, choose, pgnOf, eventHash } from './log.js';
import { GitStore, StoreError, defaultPath, REPO_RE, PATH_RE, BRANCH_RE } from './store.js';
import { parseRunParams, makeTextArtifact } from './webcli.js';

const VERSION = '0.2.0';
const APP_ID = 'chess-webCLI';
const TOPIC_LABEL = 'chess-webCLI/v1/topic';
const SDP_LABEL = 'chess-webCLI/v1/sdp';
const HELLO_LABEL = 'chess-webCLI/v1/hello';
// The same five public relays rtc-webCLI pins. Replace them here if they stop passing messages.
const RELAYS = ['wss://no.str.cr', 'wss://relay.wavlake.com', 'wss://nostr.hifish.org', 'wss://relay.notoshi.win', 'wss://relay.dwadziesciajeden.pl'];
const DEFAULT_STUN = 'stun:stun.cloudflare.com:3478';
const MAX_LOG = 4000;
const FLAG_GRACE_MS = 1500;
const FUTURE_SLACK_MS = 10 * 60e3;      // an event dated further ahead than this, by our clock, is refused
const GIT_POLL_MS = { token: 20e3, anon: 60e3 };
const GIT_API = 'https://api.github.com';
const PINS = /*PINS*/{"trystero-nostr.js":{"version":"0.27.0","sha256":"e38ca0a153946e0d209d895948a7dc6e1dcb7003ea6ae495d75cec42041f1c54","package":"@trystero-p2p/nostr"},"qrcode.js":{"version":"1.5.2","sha256":"065509cfd450f89dbffccc8e37d16f5cb03099aef7c36ab2a23d27611bd97b03","package":"qrcode-generator"},"web-llm.js":{"version":"0.2.79","sha256":"adf78adb083a12022ca09ad1612594b4c3b44f37ab9689b82671a2344f0cd606","package":"@mlc-ai/web-llm"}}/*END-PINS*/;

// ---------------------------------------------------------------------------- small helpers
const $ = (s) => document.querySelector(s);
const enc = new TextEncoder();
const hex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const concat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const short = (id) => String(id || '').slice(0, 4);
const other = (c) => (c === 'w' ? 'b' : 'w');
const colorName = (c) => (c === 'w' ? 'White' : 'Black');
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) e.append(kid);
  return e;
};
const APP_DIR = (() => {
  const p = location.pathname;
  if (p.endsWith('/')) return p;
  const last = p.split('/').pop();
  return last.includes('.') ? p.slice(0, p.length - last.length) : p + '/';
})();
const GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const glyph = (p) => GLYPH[p.toLowerCase()] + '︎';

// ---------------------------------------------------------------------------- board themes
// Colours only: the highlight overlays are translucent and work on all of them.
const BOARD_THEMES = {
  slate: { label: 'Slate', light: '#c9d3e6', dark: '#5d6f99' },
  walnut: { label: 'Walnut', light: '#f0d9b5', dark: '#b58863' },
  forest: { label: 'Forest', light: '#eaeed2', dark: '#769656' },
  ice: { label: 'Ice', light: '#dee3e6', dark: '#8ca2ad' },
  plum: { label: 'Plum', light: '#e3d3e0', dark: '#8c6e8a' },
  coal: { label: 'Coal', light: '#9aa3b5', dark: '#434a63' },
};
function applyBoardTheme(name) {
  const key = BOARD_THEMES[name] ? name : 'slate';
  const t = BOARD_THEMES[key];
  document.documentElement.style.setProperty('--light', t.light);
  document.documentElement.style.setProperty('--dark', t.dark);
  settings.board = key; saveSettings();
  return t;
}

// ---------------------------------------------------------------------------- icons
const ICONS = {
  flip: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  undo: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  draw: '<line x1="5" y1="9" x2="19" y2="9"/><line x1="5" y1="15" x2="19" y2="15"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  bulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.1V17h6v-.2c0-.8.4-1.6 1-2.1A7 7 0 0 0 12 2z"/>',
  again: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  first: '<polyline points="11 17 6 12 11 7"/><polyline points="18 17 13 12 18 7"/>',
  prev: '<polyline points="15 18 9 12 15 6"/>',
  next: '<polyline points="9 18 15 12 9 6"/>',
  last: '<polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  theme: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/>',
};
function setIcon(btn, name) {
  if (btn.querySelector('svg.i')) return;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('class', 'i'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  btn.prepend(svg);
}
const CONTROL_ICONS = { btnFlip: 'flip', btnUndo: 'undo', btnDraw: 'draw', btnResign: 'flag', btnHint: 'bulb', btnAgain: 'again', btnTheme: 'theme', btnFirst: 'first', btnPrev: 'prev', btnNext: 'next', btnLast: 'last', btnLeave: 'out' };
for (const [id, ic] of Object.entries(CONTROL_ICONS)) setIcon($('#' + id), ic);

// ---------------------------------------------------------------------------- settings (this tab only)
const SKEY = 'chess.settings';
const settings = (() => { try { return JSON.parse(sessionStorage.getItem(SKEY) || '{}'); } catch { return {}; } })();
const saveSettings = () => sessionStorage.setItem(SKEY, JSON.stringify(settings));
const customRelays = () => String(settings.relays || '').split(',').map((s) => s.trim()).filter((u) => /^wss:\/\//.test(u) || /^ws:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(u));
const activeRelays = () => (customRelays().length ? customRelays() : RELAYS);

// ---------------------------------------------------------------------------- egress record
// Every WebSocket the page opens, and every resource it fetches, is recorded so /egress can compare
// what was declared with what was actually used.
const SEEN = new Set();
const RealWS = window.WebSocket;
window.WebSocket = function (url, p) { try { SEEN.add('wss ' + new URL(url).host); } catch {} return new RealWS(url, p); };
window.WebSocket.prototype = RealWS.prototype;
Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
const observedHosts = () => {
  const hs = new Set(SEEN);
  for (const e of performance.getEntriesByType('resource')) { try { const u = new URL(e.name); if (u.protocol.startsWith('http')) hs.add('https ' + u.host); } catch {} }
  return [...hs].sort();
};

// ---------------------------------------------------------------------------- verified library loading
const libCache = {};
async function loadVerified(file) {
  if (libCache[file]) return libCache[file];
  const pin = PINS[file];
  if (!pin) throw new Error(`No pinned hash for ${file}.`);
  const res = await fetch(new URL('lib/' + file, location.origin + APP_DIR), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Could not load lib/${file} (${res.status}).`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const got = hex(await sha256(buf));
  if (got !== pin.sha256) throw new Error(`lib/${file} does not match its pinned SHA-256 (got ${got}). Refusing to run it.`);
  const url = URL.createObjectURL(new Blob([buf], { type: 'text/javascript' }));
  try { libCache[file] = await import(url); } finally { URL.revokeObjectURL(url); }
  return libCache[file];
}

// ---------------------------------------------------------------------------- state
const S = {
  mode: null,          // 'engine' | 'local' | 'analysis' | 'room'
  log: [], st: null,   // the event log and its replayed state
  key: null,           // my seat key (rooms)
  engineColor: null, level: 3, thinking: false,
  review: null,        // ply being reviewed, or null for live
  flipped: false, sel: null, hint: null,
  proposal: null,
  clockAt: Date.now(), flagSent: false,
  // room
  secret: null, roomId: null, anchor: null, room: null, selfId: null, actions: {}, peers: new Map(), q: Promise.resolve(),
  chat: [], unread: 0, tab: 'moves', lastWarn: '',
  // git-backed games
  git: null, gitInfo: null, gitBusy: false, gitStatus: '', gitLastSync: 0, gitPoll: null, gitError: '',
};
const ai = new BoundedAI({ loadLib: () => loadVerified('web-llm.js') });

const LOCAL_PUB = { w: b64u.enc(enc.encode('this-device-white')), b: b64u.enc(enc.encode('this-device-black')) };
const replayOpts = () => (S.mode === 'room' ? { room: S.roomId, anchor: S.anchor } : { room: 'local', trust: true });
const game = () => S.st?.game;
const mySeat = () => {
  if (!S.st) return null;
  if (S.mode === 'room') {
    if (!S.key) return null;
    for (const c of ['w', 'b']) if (S.st.seats[c]?.keyId === S.key.keyId) return c;
    return null;
  }
  if (S.mode === 'engine') return other(S.engineColor);
  return game()?.turn; // local and analysis: whoever is to move
};
const isCreator = () => S.mode === 'room' && S.key && S.st?.creator?.keyId === S.key.keyId;
const live = () => S.st && !S.st.result;
const bothSeated = () => S.st && S.st.seats.w && S.st.seats.b;
const canMoveNow = () => {
  if (!S.st || S.review !== null || S.thinking) return false;
  if (S.mode === 'analysis') return true;
  if (!live() || !bothSeated()) return false;
  return mySeat() === game().turn;
};
// The engine is never offered to a seated player during a live room game.
const assistAllowed = () => !(S.mode === 'room' && mySeat() && live());

// ---------------------------------------------------------------------------- console
const outEl = $('#consoleOut');
function log(text, cls = '') {
  const line = el('div', { class: cls, text: String(text) });
  outEl.append(line);
  while (outEl.childNodes.length > 600) outEl.firstChild.remove();
  outEl.scrollTop = outEl.scrollHeight;
  if (cls === 'err') console.warn('[chess-webCLI]', text); else console.log('[chess-webCLI]', text);
}

// ---------------------------------------------------------------------------- applying the log
async function setLog(events, st, source = 'local') {
  const before = S.st;
  const prevMoves = before ? before.moveIdx.length : 0;
  const prevGame = before ? before.gameNo : 0;
  S.log = events; S.st = st;
  if (st.gameNo !== prevGame || st.moveIdx.length !== prevMoves) { S.clockAt = Date.now(); S.flagSent = false; S.hint = null; S.sel = null; }
  if (S.review !== null && S.review > st.game.ply()) S.review = null;
  // sound for a new move
  if (before && st.gameNo === prevGame && st.moveIdx.length === prevMoves + 1) {
    const last = st.game.history().at(-1);
    sound(last.san.includes('#') || last.san.includes('+') ? 'check' : last.captured ? 'capture' : 'move');
    if (source !== 'local') S.review = null;
  }
  if (before && !before.result && st.result) { sound('end'); log(`Game over: ${st.result.result}, ${st.result.reason}.`, 'ok'); systemChat(`Game over: ${st.result.result} (${st.result.reason}).`); }
  if (before?.pending?.at !== st.pending?.at && st.pending && S.mode === 'room') {
    const who = st.seats[st.pending.by]?.name || colorName(st.pending.by);
    if (st.pending.by !== mySeat()) { sound('offer'); log(`${who} offers ${st.pending.kind === 'rematch' ? 'a rematch' : st.pending.kind === 'draw' ? 'a draw' : 'to take back a move'}.`, 'cmd'); }
  }
  // face your own colour when you first get a seat, and again when a rematch swaps colours
  if (S.mode === 'room' && mySeat() && (!S.autoFlipped || (before && st.gameNo !== prevGame))) { S.autoFlipped = true; S.flipped = mySeat() === 'b'; }
  persist();
  render();
  maybeEngineMove();
}

async function commit(body) {
  if (!S.st) return false;
  if (S.st.timed) body = { ...body, at: Math.max(Date.now(), S.st.lastAt) };
  let ev = nextEvent(S.st, body);
  if (S.mode === 'room') {
    if (!S.key) { log('You hold no seat in this room.', 'err'); return false; }
    ev = await signEvent(S.key, ev);
  }
  const events = [...S.log, ev];
  const st = await replay(events, replayOpts());
  if (!st.ok) { log(`Not done: ${st.error}.`, 'err'); return false; }
  await setLog(events, st, 'local');
  if (S.mode === 'room') broadcast('ev', { ev });
  if (S.git) gitPush();
  return true;
}

function persist() {
  try {
    if (S.mode === 'room' && S.roomId) {
      sessionStorage.setItem('chess.log.' + S.roomId, JSON.stringify(S.log));
      if (S.gitInfo && mySeat()) { keepSeatKey(); localStorage.setItem('chess.glog.' + S.roomId, JSON.stringify(S.log)); touchGame(); }
    }
    else if (S.mode) sessionStorage.setItem('chess.local', JSON.stringify({ mode: S.mode, log: S.log, engineColor: S.engineColor, level: S.level }));
  } catch {}
}

// ---------------------------------------------------------------------------- starting games on this device
async function startLocal(mode, { color = 'w', level = 3, fen = null, log: saved = null } = {}) {
  await leaveRoom();
  S.mode = mode; S.level = level; S.review = null; S.flipped = false; S.hint = null; S.proposal = null;
  S.engineColor = mode === 'engine' ? other(color) : null;
  let events = saved;
  if (!events) {
    const init = nextEvent({ events: [], tip: 'local' }, { t: 'init', v: PROTO, color: 'w', pub: LOCAL_PUB.w, name: mode === 'engine' ? (color === 'w' ? myName() : engineName()) : 'White', tc: null, fen });
    const st0 = await replay([init], { room: 'local', trust: true });
    if (!st0.ok) { log(`Could not start: ${st0.error}`, 'err'); return; }
    const seat = nextEvent(st0, { t: 'seat', color: 'b', pub: LOCAL_PUB.b, name: mode === 'engine' ? (color === 'b' ? myName() : engineName()) : 'Black' });
    events = [init, seat];
  }
  const st = await replay(events, { room: 'local', trust: true });
  if (!st.ok) { log(`Could not start: ${st.error}`, 'err'); return; }
  S.flipped = mode === 'engine' && color === 'b';
  showGame();
  S.st = null;
  await setLog(events, st);
  const what = { engine: `You play ${colorName(color)} against the local engine, level ${level} (${LEVELS[level].label}).`, local: 'Pass and play: White and Black take turns on this device.', analysis: 'Analysis board: either side can move. Load a FEN or PGN from the Moves tab.' }[mode];
  log(`${what} Nothing in this mode leaves the device.`, 'ok');
}
const engineName = () => `Computer (level ${S.level})`;
const myName = () => (settings.name || '').trim().slice(0, 24) || (S.selfId ? friendlyName(S.selfId) : 'You');

// ---------------------------------------------------------------------------- engine worker
let worker = null, workerSeq = 0;
const pendingSearch = new Map();
function engineSearch(fen, level, extra = {}) {
  if (!worker) {
    worker = new Worker(new URL('engine-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const p = pendingSearch.get(e.data.id); if (p) { pendingSearch.delete(e.data.id); e.data.ok ? p.res(e.data.result) : p.rej(new Error(e.data.error)); } };
    worker.onerror = (e) => { for (const p of pendingSearch.values()) p.rej(new Error(e.message || 'engine worker failed')); pendingSearch.clear(); worker = null; };
  }
  const id = ++workerSeq;
  return new Promise((res, rej) => { pendingSearch.set(id, { res, rej }); worker.postMessage({ id, fen, level, ...extra }); });
}
const repHistory = () => {
  // position keys seen so far in this game, so the engine avoids repeating when ahead
  const g = new Chess(S.st.startFen), keys = [];
  for (const m of S.st.game.history()) { g.move(m.uci); keys.push(g._repKey()); }
  return keys;
};
async function maybeEngineMove() {
  if (S.mode !== 'engine' || !live() || S.thinking || S.review !== null) return;
  if (game().turn !== S.engineColor) return;
  S.thinking = true; renderStatus();
  const gNo = S.st.gameNo, ply = game().ply();
  try {
    const r = await engineSearch(game().fen(), S.level, { seed: ply, history: repHistory() });
    await new Promise((ok) => setTimeout(ok, Math.max(0, 350 - r.ms))); // never reply faster than a blink
    S.thinking = false;
    if (S.mode !== 'engine' || S.st.gameNo !== gNo || game().ply() !== ply || !r.uci) { render(); return; }
    log(`Engine: ${r.san} (depth ${r.depth}, ${r.nodes.toLocaleString()} positions, ${r.ms} ms, stopped by ${r.stoppedBy}).`, 'dim');
    await commit({ t: 'move', by: S.engineColor, uci: r.uci });
  } catch (e) { S.thinking = false; log(`Engine error: ${e.message}`, 'err'); render(); }
}
async function hint() {
  if (!S.st) return;
  if (!assistAllowed()) { log('Hints are off for players during a live room game. The engine is available to watchers, and to you after the game.', 'err'); return; }
  const g = boardGame();
  if (g.status().over) { log('The game is over; there is nothing to hint.'); return; }
  log('Engine is thinking (level 4)…', 'dim');
  const r = await engineSearch(g.fen(), 4, { seed: 0 });
  if (!r.uci) return;
  S.hint = { from: r.uci.slice(0, 2), to: r.uci.slice(2, 4) };
  log(`Hint: ${r.san} — ${describeMove(g.find(r.uci))}. Evaluation ${formatScore(r, g.turn)}; depth ${r.depth}, ${r.nodes.toLocaleString()} positions in ${r.ms} ms.`, 'ok');
  renderBoard();
}

// ---------------------------------------------------------------------------- rooms
async function deriveRoom(secret) {
  const topic = await sha256(concat(enc.encode(TOPIC_LABEL), secret));
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const pw = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(SDP_LABEL) }, key, 256));
  return { roomId: hex(topic), password: b64u.enc(pw) };
}
// Invite fragment: #k=<128-bit secret>&s=<creator key id>[&g=<owner/repo>[&b=<branch>][&p=<path>]].
// None of it is ever sent to a server. g/b/p say where a git-backed game lives (p only when not the default).
const B64_22 = /^[A-Za-z0-9_-]{22}$/;
function parseInvite(hash = location.hash) {
  if (!hash.startsWith('#k=')) return null;
  const q = new URLSearchParams(hash.slice(1));
  const k = q.get('k'), sKey = q.get('s');
  if (!B64_22.test(k || '') || !B64_22.test(sKey || '')) return null;
  for (const key of q.keys()) if (!['k', 's', 'g', 'b', 'p'].includes(key)) return null;
  let secret;
  try { secret = b64u.dec(k); } catch { return null; }
  if (secret.length !== 16) return null;
  const inv = { secret, anchor: sKey, git: null };
  if (q.has('g')) {
    const repo = q.get('g'), branch = q.get('b') || 'main', path = q.get('p') || null;
    if (!REPO_RE.test(repo) || !BRANCH_RE.test(branch) || (path && (!PATH_RE.test(path) || path.includes('..')))) return null;
    inv.git = { repo, branch, path };
  }
  return inv;
}
const fragmentFor = (secret, anchor, git) => {
  let f = `#k=${b64u.enc(secret)}&s=${anchor}`;
  if (git) { f += `&g=${git.repo}`; if (git.branch && git.branch !== 'main') f += `&b=${encodeURIComponent(git.branch)}`; if (git.customPath) f += `&p=${encodeURIComponent(git.path)}`; }
  return f;
};
const inviteUrl = () => `${location.origin}${APP_DIR}${fragmentFor(S.secret, S.anchor, S.gitInfo)}`;

// A live room's seat key lives in this tab only. A git-backed game's key is kept on this device
// (localStorage) until you remove the game, because the game may take weeks.
async function keyFor(roomId, { create = true, keep = false } = {}) {
  const k = 'chess.key.' + roomId, gk = 'chess.gkey.' + roomId;
  for (const [store, key] of [[localStorage, gk], [sessionStorage, k]]) {
    try { const saved = JSON.parse(store.getItem(key) || 'null'); if (saved) { const imported = await importSeatKey(saved); if (keep) localStorage.setItem(gk, JSON.stringify(saved)); return imported; } } catch {}
  }
  if (!create) return null;
  const key = await newSeatKey();
  (keep ? localStorage : sessionStorage).setItem(keep ? gk : k, JSON.stringify({ jwk: key.jwk, pub: key.pub }));
  return key;
}

async function createRoom() {
  const useGit = $('#useGit').checked;
  const tcv = $('#selTc').value;
  if (tcv.startsWith('d') && !useGit) { showFatal('Days-per-move games are kept in a git repo, so nobody has to stay online. Tick "Keep this game in a git repo" and fill it in, or pick a live clock.'); return; }
  let git = null;
  if (useGit) {
    git = { repo: $('#gitRepo').value.trim(), branch: $('#gitBranch').value.trim() || 'main', readable: $('#gitReadable').checked };
    if (!REPO_RE.test(git.repo)) { showFatal('The repo must look like owner/name, for example you/chess-games.'); return; }
    if (!BRANCH_RE.test(git.branch)) { showFatal('That branch name is not valid.'); return; }
    if (!$('#gitToken').value.trim()) { showFatal('A GitHub token is needed to commit the game. Make a fine-grained token with "Contents: read and write" on that one repo.'); return; }
    saveToken(git.repo, $('#gitToken').value.trim(), $('#gitRemember').checked);
  }
  $('#fatal').classList.add('hidden');
  const secret = crypto.getRandomValues(new Uint8Array(16));
  const { roomId } = await deriveRoom(secret);
  const key = await keyFor(roomId, { keep: !!git });
  const colorPick = $('#selColor').value === 'r' ? (crypto.getRandomValues(new Uint8Array(1))[0] & 1 ? 'w' : 'b') : $('#selColor').value;
  const tc = !tcv ? null : tcv.startsWith('d') ? { days: Number(tcv.slice(1)) } : { base: Number(tcv.split('+')[0]) * 1000, inc: Number(tcv.split('+')[1]) * 1000 };
  settings.name = $('#name').value.trim().slice(0, 24); saveSettings();
  const body = { t: 'init', v: PROTO, color: colorPick, pub: key.pub, name: settings.name || 'Room creator', tc, fen: null };
  if (git) Object.assign(body, { claim: true, at: Date.now() });
  const init = await signEvent(key, nextEvent({ events: [], tip: roomId }, body));
  if (git) {
    git.path = await defaultPath(secret);
    const store = makeStore(git, secret);
    try {
      const r = await store.load();
      if (r.events?.length) throw new StoreError('A game file already exists at that path.');
      await store.save([init], commitMessage([init], init, git.readable), { pgn: '' });
    } catch (e) { showFatal(`Could not start the game in ${git.repo}: ${e.message}`); localStorage.removeItem('chess.gkey.' + roomId); return; }
    localStorage.setItem('chess.glog.' + roomId, JSON.stringify([init]));
    log(`Game file committed to ${git.repo} (${git.readable ? 'readable' : 'encrypted'}).`, 'ok');
  }
  sessionStorage.setItem('chess.log.' + roomId, JSON.stringify([init]));
  history.replaceState(null, '', `${APP_DIR}${fragmentFor(secret, key.keyId, git)}`);
  await joinRoom();
}

// ---------------------------------------------------------------------------- git-backed games
const tokenKey = (repo) => 'chess.token.' + repo.toLowerCase();
function saveToken(repo, token, remember) {
  sessionStorage.setItem(tokenKey(repo), token);
  if (remember) localStorage.setItem(tokenKey(repo), token); else localStorage.removeItem(tokenKey(repo));
}
const tokenFor = (repo) => sessionStorage.getItem(tokenKey(repo)) || localStorage.getItem(tokenKey(repo)) || '';
// Tests point the page at a stand-in API on the page's own origin; nothing else is accepted.
const gitApi = () => (settings.gitApi && new URL(settings.gitApi, location.href).origin === location.origin ? new URL(settings.gitApi, location.href).href : GIT_API);
function makeStore(git, secret) {
  return new GitStore({ repo: git.repo, branch: git.branch || 'main', path: git.path, token: tokenFor(git.repo), secret, readable: !!git.readable, api: gitApi() });
}
// Short, readable commit messages for a readable game; nothing about the game for an encrypted one.
function commitMessage(events, ev, readable) {
  if (!readable) return `chess-webCLI: event ${ev.i}`;
  const st = S.st;
  const name = (c) => st?.seats[c]?.name || colorName(c);
  switch (ev.t) {
    case 'init': return `Start: ${ev.name || 'creator'} plays ${colorName(ev.color)}${ev.tc?.days ? ` (${ev.tc.days} day${ev.tc.days > 1 ? 's' : ''} per move)` : ev.tc?.base ? ` (${ev.tc.base / 60000}+${ev.tc.inc / 1000})` : ''}`;
    case 'seat': case 'claim': return `${ev.name || 'Someone'} takes ${colorName(ev.color)}`;
    case 'move': {
      const h = st.game.history(), m = h.at(-1);
      const start = Number(st.startFen.split(' ')[5]), blackFirst = st.startFen.split(' ')[1] === 'b';
      const ply = h.length - 1 + (blackFirst ? 1 : 0);
      const num = start + Math.floor(ply / 2);
      return `${num}.${ply % 2 ? '..' : ''} ${m.san} (${name(ev.by)})${st.result ? ` — ${st.result.result}, ${st.result.reason}` : ''}`;
    }
    case 'offer': return `${name(ev.by)} offers ${ev.kind === 'draw' ? 'a draw' : ev.kind === 'rematch' ? 'a rematch' : 'a takeback'}`;
    case 'reply': return `${name(ev.by)} ${ev.accept ? 'accepts' : 'declines'} the ${ev.kind}${st.result ? ` — ${st.result.result}` : ''}`;
    case 'resign': return `${name(ev.by)} resigns — ${st.result?.result || ''}`;
    case 'flag': return `${colorName(ev.color)} ran out of time — ${st.result?.result || ''}`;
    default: return `event ${ev.i}`;
  }
}
// Write our log to the repo. On a conflict, load theirs, settle the two the same way peers do, and retry.
async function gitPush() {
  if (!S.git) return;
  if (!S.git.token) { S.gitStatus = 'Not saved to the repo: no token. Add one with /token.'; renderStatus(); return; }
  S.gitPushWanted = true;
  if (S.gitBusy) return;
  S.gitBusy = true;
  try {
    for (let attempt = 0; attempt < 4 && S.gitPushWanted; attempt++) {
      S.gitPushWanted = false;
      const events = S.log;
      try {
        await S.git.save(events, commitMessage(events, events.at(-1), S.git.readable), { pgn: S.st ? pgnOf(S.st) : '' });
        S.gitLastSync = Date.now(); S.gitError = ''; S.gitStatus = '';
        S.gitRemoteLen = events.length;
      } catch (e) {
        if (!e.conflict) throw e;
        const r = await S.git.load();
        if (r.events) await takeRemote(r.events); // sets gitPushWanted again if ours should still be written
      }
    }
  } catch (e) { S.gitError = e.message; log(`Not saved to ${S.git.repo}: ${e.message}`, 'err'); }
  finally { S.gitBusy = false; renderStatus(); }
}
// A log loaded from the repo: check it like any peer's log, then keep the right one.
async function takeRemote(events) {
  S.gitRemoteLen = events.length;
  if (!events.length) { if (S.log.length) S.gitPushWanted = true; return; }
  const st = await replay(events, replayOpts());
  if (!st.ok) { warnOnce(`The game file in ${S.git.repo} fails the checks (event ${st.at}: ${st.error}). It was ignored; your copy will be written back.`); S.gitPushWanted = true; return; }
  if (futureDated(events)) { warnOnce(`The game file in ${S.git.repo} has an event dated in the future by this device's clock. It was ignored.`); return; }
  if (!S.log.length) { await setLog(events, st, 'git'); return; }
  const c = await choose(S.log, events);
  if (c.pick === 'theirs') {
    if (c.why === 'fork') log(`Someone else's ${events[c.k].t} reached the repo at the same time as yours; every copy keeps theirs.`, 'err');
    await setLog(events, st, 'git');
    if (S.mode === 'room') broadcast('log', { events });
  } else if (c.why !== 'same') S.gitPushWanted = true;
}
async function gitSync({ quiet = true } = {}) {
  if (!S.git || S.gitBusy) return;
  S.gitBusy = true;
  try {
    const r = await S.git.load();
    S.gitLastSync = Date.now(); S.gitError = '';
    if (r.events) await takeRemote(r.events);
    if (!quiet) log(`Synced with ${S.git.repo}.`, 'ok');
  } catch (e) { S.gitError = e.message; if (!quiet) log(`Could not sync: ${e.message}`, 'err'); }
  finally { S.gitBusy = false; }
  if (S.gitPushWanted && S.git.token) gitPush();
  renderStatus();
}
function startGitPolling() {
  clearInterval(S.gitPoll);
  S.gitPoll = setInterval(() => { if (document.visibilityState === 'visible') gitSync(); }, S.git?.token ? GIT_POLL_MS.token : GIT_POLL_MS.anon);
}
const futureDated = (events) => events.some((e) => Number.isFinite(e.at) && e.at > Date.now() + FUTURE_SLACK_MS);
addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.git) gitSync(); });

// The list of git-backed games kept on this device.
const gamesIndex = () => { try { return JSON.parse(localStorage.getItem('chess.games') || '[]'); } catch { return []; } };
function summarize(st, myKeyId) {
  const me = st ? ['w', 'b'].find((c) => st.seats[c]?.keyId === myKeyId) || null : null;
  const seated = st && st.seats.w && st.seats.b;
  const title = st ? `${st.seats.w?.name || 'open seat'} – ${st.seats.b?.name || 'open seat'}` : 'Game';
  const state = !st ? '' : st.result ? `${st.result.result}, ${st.result.reason}` : !seated ? 'waiting for an opponent' : me && st.game.turn === me ? 'your move' : `${colorName(st.game.turn)} to move`;
  return { title, state, moves: st?.game.ply() || 0, deadline: st?.deadline || null, myTurn: !!(me && st && !st.result && seated && st.game.turn === me) };
}
// On the start screen: look at each kept game in its repo, so the list says whose move it is.
let gamesRefreshed = 0;
async function refreshGames() {
  if (Date.now() - gamesRefreshed < 30e3) return;
  gamesRefreshed = Date.now();
  for (const g of gamesIndex()) {
    try {
      const inv = parseInvite(g.frag);
      if (!inv?.git) continue;
      const { roomId } = await deriveRoom(inv.secret);
      const path = inv.git.path || await defaultPath(inv.secret);
      const store = makeStore({ ...inv.git, path }, inv.secret);
      const r = await store.load();
      if (!r.events?.length || futureDated(r.events)) continue;
      const st = await replay(r.events, { room: roomId, anchor: inv.anchor });
      if (!st.ok) continue;
      const saved = JSON.parse(localStorage.getItem('chess.gkey.' + roomId) || 'null');
      const myKeyId = saved ? await keyIdOf(saved.pub) : null;
      const list = gamesIndex();
      const i = list.findIndex((x) => x.roomId === g.roomId);
      if (i < 0) continue;
      list[i] = { ...list[i], ...summarize(st, myKeyId), checked: Date.now() };
      localStorage.setItem('chess.games', JSON.stringify(list));
      localStorage.setItem('chess.glog.' + roomId, JSON.stringify(r.events));
    } catch { /* offline, no token or no access: keep what we knew */ }
  }
  if (!S.mode) renderGames();
}
function touchGame() {
  if (!S.gitInfo || !S.roomId) return;
  const list = gamesIndex().filter((g) => g.roomId !== S.roomId);
  list.unshift({ roomId: S.roomId, frag: fragmentFor(S.secret, S.anchor, S.gitInfo), repo: S.gitInfo.repo, ...summarize(S.st, S.key?.keyId), updated: Date.now() });
  localStorage.setItem('chess.games', JSON.stringify(list.slice(0, 100)));
}
// A seat in a git-backed game may be needed for weeks: move its key from the tab to the device.
function keepSeatKey() {
  const gk = 'chess.gkey.' + S.roomId;
  if (localStorage.getItem(gk) || !S.key) return;
  localStorage.setItem(gk, JSON.stringify({ jwk: S.key.jwk, pub: S.key.pub }));
}
function forgetGame(roomId) {
  localStorage.setItem('chess.games', JSON.stringify(gamesIndex().filter((g) => g.roomId !== roomId)));
  for (const k of ['chess.gkey.', 'chess.glog.', 'chess.key.', 'chess.log.']) { localStorage.removeItem(k + roomId); sessionStorage.removeItem(k + roomId); }
}
function renderGames() {
  const list = gamesIndex();
  $('#pane-games').classList.toggle('hidden', !list.length);
  const box = $('#gamesList'); box.textContent = '';
  for (const g of list) {
    const due = g.deadline && g.myTurn ? ` · reply by ${new Date(g.deadline).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : '';
    box.append(el('div', { class: 'grow' },
      el('div', { class: 't' }, el('b', { text: g.title }), el('span', { text: `${g.repo} · ${g.moves} moves · ${g.state}${due}` })),
      el('button', { class: g.myTurn ? 'primary' : '', type: 'button', text: g.myTurn ? 'Your move' : 'Open', title: 'Open this game', onclick: () => { history.replaceState(null, '', APP_DIR + g.frag); joinRoom().catch((e) => showFatal(e.message)); } }),
      el('button', { type: 'button', text: 'Remove', title: 'Forget this game on this device: its link and your seat key are deleted. The game stays in the repo, but you can no longer move in it.', onclick: async () => { if (await confirmBox('Remove this game from this device?', 'Its link and your seat key are deleted here. The game stays in the repo, but without the key you can no longer move in it.', 'Remove')) { forgetGame(g.roomId); renderGames(); } } })));
  }
}
async function askToken(repo) {
  const input = el('input', { type: 'password', autocomplete: 'off', placeholder: 'github_pat_…', id: 'askTok' });
  const keep = el('input', { type: 'checkbox', id: 'askKeep' });
  const v = await showScreen({ title: 'Your GitHub token', node: el('div', {},
    el('p', { class: 'dim', text: `To move in this game, this tab needs your token for ${repo} (Contents: read and write). Without it you can still follow the game.` }), input,
    el('label', { class: 'chk' }, keep, document.createTextNode(' Remember it on this device'))),
    actions: [{ label: 'Just watch', value: null }, { label: 'Use token', cls: 'primary', value: 'ok' }] });
  const token = input.value.trim();
  return v === 'ok' && token ? { token, remember: keep.checked } : null;
}
async function claimSeat() {
  if (!S.st?.claim) { log('Seats in this game are given by the room creator.', 'err'); return; }
  const open = !S.st.seats.w ? 'w' : !S.st.seats.b ? 'b' : null;
  if (!open) { log('Both seats are taken.', 'err'); return; }
  if (mySeat()) { log('You already play in this game.', 'err'); return; }
  if (S.git && !S.git.token) { log('Add a token with write access to the repo first (/token <token>), so your seat can be committed.', 'err'); return; }
  if (await commit({ t: 'claim', color: open, pub: S.key.pub, name: myName() })) { S.autoFlipped = false; render(); log(`You play ${colorName(open)}.`, 'ok'); }
}

async function joinRoom() {
  const inv = parseInvite();
  if (!inv) { showFatal('This invite link is incomplete. It should end in #k=…&s=…'); return; }
  await leaveLocal();
  settings.name = $('#name').value.trim().slice(0, 24) || settings.name || ''; saveSettings();
  S.secret = inv.secret; S.anchor = inv.anchor;
  const { roomId, password } = await deriveRoom(inv.secret);
  S.roomId = roomId;
  S.key = await keyFor(roomId); // kept on the device only once you hold a seat in a git-backed game
  clearInterval(S.gitPoll); S.git = null; S.gitInfo = null; S.gitError = ''; S.gitStatus = '';
  if (inv.git) {
    const t = $('#gitToken').value.trim();
    if (t) saveToken(inv.git.repo, t, $('#gitRemember').checked);
    const path = inv.git.path || await defaultPath(inv.secret);
    S.gitInfo = { repo: inv.git.repo, branch: inv.git.branch, path, customPath: !!inv.git.path };
    try { S.git = makeStore(S.gitInfo, inv.secret); } catch (e) { showFatal(e.message); return; }
  }
  S.mode = 'room'; S.autoFlipped = false; S.flipped = false; S.review = null; S.proposal = null; S.peers = new Map(); S.chat = []; S.unread = 0;
  // our own copy of the log, if this tab has been here before (a reload keeps it; Leave deletes it)
  let saved = [];
  try { saved = JSON.parse(sessionStorage.getItem('chess.log.' + roomId) || localStorage.getItem('chess.glog.' + roomId) || '[]'); } catch {}
  const st = saved.length ? await replay(saved, replayOpts()) : null;
  S.log = st?.ok ? saved : []; S.st = st?.ok ? st : null;
  showGame();
  $('#hdrRoom').classList.remove('hidden');
  $('#roomInfo').textContent = (S.gitInfo ? `git: ${S.gitInfo.repo} · ` : '') + (settings.lan ? 'LAN only' : `STUN: ${(settings.stun || DEFAULT_STUN).replace(/^stun:/, '')}`);
  render();
  if (S.git && !S.git.token && localStorage.getItem('chess.gkey.' + roomId)) {
    // you play in this game, but this tab has no token: ask once, rather than failing on your first move
    const tok = await askToken(S.gitInfo.repo);
    if (tok) { S.git.token = tok.token; saveToken(S.gitInfo.repo, tok.token, tok.remember); }
  }
  if (S.git) {
    log(`This game lives in ${S.git.repo}${S.git.token ? '' : ' (no token: you can follow it, but not move)'}. Loading it…`);
    await gitSync({ quiet: false });
    startGitPolling();
    touchGame();
  }

  let lib;
  try { lib = await loadVerified('trystero-nostr.js'); } catch (e) { showFatal(e.message); return; }
  const iceServers = settings.lan ? [] : [{ urls: settings.stun || DEFAULT_STUN }];
  S.egressConfig = { relayUrls: activeRelays(), iceServers };
  S.room = lib.joinRoom({
    appId: APP_ID, password, maxUsers: 24, identity: 'none',
    relayConfig: { urls: S.egressConfig.relayUrls, warnOnRelayFailure: false },
    rtcConfig: { iceServers: S.egressConfig.iceServers },
  }, roomId);
  S.room.getSelf().then((info) => { S.selfId = info.peerId; render(); });
  for (const name of ['hello', 'log', 'ev', 'need', 'chat', 'bye']) S.actions[name] = S.room.makeAction(name);
  S.actions.hello.onMessage((m, ctx) => enqueue(() => onHello(ctx.peerId, m)));
  S.actions.log.onMessage((m, ctx) => enqueue(() => onLogMsg(ctx.peerId, m)));
  S.actions.ev.onMessage((m, ctx) => enqueue(() => onEv(ctx.peerId, m)));
  S.actions.need.onMessage((m, ctx) => { if (S.log.length) send('log', { events: S.log }, ctx.peerId); });
  S.actions.chat.onMessage((m, ctx) => onChat(ctx.peerId, m));
  S.actions.bye.onMessage((m, ctx) => onPeerLeave(ctx.peerId));
  S.room.onPeerJoin(({ peerId }) => onPeerJoin(peerId));
  S.room.onPeerLeave(({ peerId }) => onPeerLeave(peerId));
  log(`Joined the room. ${S.st ? 'Your copy of the game was kept from before the reload.' : 'Waiting for someone else in the room to send the game.'} Type /help for commands.`);
  if (isCreator()) log('You created this room. Send the invite link; the first person to join takes the other colour.', 'ok');
}
const enqueue = (fn) => { S.q = S.q.then(fn).catch((e) => log(`Error: ${e.message}`, 'err')); return S.q; };
const send = (name, data, target) => S.actions[name]?.send(data, target ? { target } : undefined).catch(() => {});
const broadcast = (name, data) => send(name, data);

async function helloMsg(peerId) {
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, S.key.priv, enc.encode(`${HELLO_LABEL}|${S.roomId}|${peerId}`)));
  return { proto: PROTO, v: VERSION, name: myName(), pub: S.key.pub, proof: b64u.enc(sig) };
}
async function onPeerJoin(peerId) {
  S.peers.set(peerId, { id: peerId, name: friendlyName(peerId), joined: Date.now(), verified: false });
  log(`${short(peerId)} connected.`, 'dim');
  try { send('hello', await helloMsg(peerId), peerId); } catch {}
  if (S.log.length) send('log', { events: S.log }, peerId);
  render();
}
function onPeerLeave(peerId) {
  const p = S.peers.get(peerId);
  if (!p) return;
  S.peers.delete(peerId);
  log(`${p.name} left.`, 'dim');
  if (p.verified) systemChat(`${p.name} left.`);
  render();
}
async function onHello(peerId, m) {
  const p = S.peers.get(peerId) || { id: peerId, joined: Date.now() };
  if (m?.proto !== PROTO) { log(`${short(peerId)} runs protocol ${m?.proto} (version ${String(m?.v).slice(0, 12)}); this page speaks ${PROTO}. Moves between you would be refused, so it is ignored.`, 'err'); p.incompatible = true; S.peers.set(peerId, p); render(); return; }
  // The hello proves the peer holds the private key for `pub`, bound to its own connection.
  let ok = false;
  try {
    const pk = await crypto.subtle.importKey('raw', b64u.dec(m.pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    // signed over OUR id: the proof was made for this receiver and cannot be replayed to anyone else
    const me = S.selfId || (await S.room.getSelf()).peerId;
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pk, b64u.dec(m.proof), enc.encode(`${HELLO_LABEL}|${S.roomId}|${me}`));
  } catch { ok = false; }
  if (!ok) { log(`${short(peerId)} sent a hello that does not verify; ignoring it.`, 'err'); return; }
  Object.assign(p, { name: String(m.name || '').trim().slice(0, 24) || friendlyName(peerId), pub: m.pub, keyId: await keyIdOf(m.pub), verified: true });
  S.peers.set(peerId, p);
  systemChat(`${p.name} joined.`);
  await maybeSeat();
  render();
}
// The creator's browser seats the first verified newcomer in the open colour.
async function maybeSeat() {
  if (!isCreator() || !S.st || S.st.claim) return; // in a git-backed game the opponent claims the seat
  const open = !S.st.seats.w ? 'w' : !S.st.seats.b ? 'b' : null;
  if (!open) return;
  const seated = new Set(['w', 'b'].map((c) => S.st.seats[c]?.keyId).filter(Boolean));
  const next = [...S.peers.values()].filter((p) => p.verified && !seated.has(p.keyId)).sort((a, b) => a.joined - b.joined)[0];
  if (!next) return;
  if (await commit({ t: 'seat', color: open, pub: next.pub, name: next.name })) log(`${next.name} takes ${colorName(open)}. The game is on.`, 'ok');
}
async function onLogMsg(peerId, m) {
  const events = Array.isArray(m?.events) ? m.events.slice(0, MAX_LOG) : null;
  if (!events || !events.length) return;
  const st = await replay(events, replayOpts());
  if (!st.ok) { warnOnce(`${nameOf(peerId)} sent a game log that fails the checks (event ${st.at}: ${st.error}). It was ignored.`); return; }
  if (futureDated(events)) { warnOnce(`${nameOf(peerId)} sent events dated in the future by this device's clock. They were ignored.`); return; }
  if (!S.log.length) { await setLog(events, st, 'peer'); log(`Received the game from ${nameOf(peerId)} (${events.length} events, all signatures and moves checked).`, 'ok'); await maybeSeat(); return; }
  const c = await choose(S.log, events);
  if (c.pick === 'theirs') {
    if (c.why === 'fork') log(`Two events were written at the same moment (event ${c.k}). Every browser keeps the same one; yours is replaced by ${nameOf(peerId)}'s.`, 'err');
    await setLog(events, st, 'peer');
  } else if (c.why === 'behind' || (c.why === 'fork')) {
    send('log', { events: S.log }, peerId);
  }
  await maybeSeat();
}
async function onEv(peerId, m) {
  const ev = m?.ev;
  if (!ev || typeof ev !== 'object') return;
  if (ev.i === S.log.length && ev.prev === (S.st ? S.st.tip : S.roomId)) {
    const events = [...S.log, ev];
    const st = await replay(events, replayOpts());
    if (!st.ok) { warnOnce(`Refused an event from ${nameOf(peerId)}: ${st.error}.`); return; }
    if (futureDated([ev])) { warnOnce(`Refused an event from ${nameOf(peerId)}: it is dated in the future by this device's clock.`); return; }
    await setLog(events, st, 'peer');
    return;
  }
  if (ev.i >= S.log.length || !S.log.length) send('need', {}, peerId);
  else if ((await eventHash(S.log[ev.i])) !== (await eventHash(ev))) send('need', {}, peerId); // fork: get the whole log and settle it
}
function warnOnce(msg) { if (S.lastWarn !== msg) { S.lastWarn = msg; log(msg, 'err'); } }
const nameOf = (peerId) => S.peers.get(peerId)?.name || short(peerId);
function peerForSeat(c) {
  const k = S.st?.seats[c]?.keyId;
  if (!k) return null;
  if (S.key && k === S.key.keyId) return 'me';
  return [...S.peers.values()].find((p) => p.keyId === k) || null;
}

// chat
function onChat(peerId, m) {
  const text = String(m?.text || '').slice(0, 500);
  if (!text) return;
  S.chat.push({ name: nameOf(peerId), text, ts: Date.now() });
  if (S.tab !== 'chat') { S.unread++; sound('chat'); }
  renderChat();
}
function sendChat(text) {
  text = String(text || '').trim().slice(0, 500);
  if (!text) return;
  if (S.mode !== 'room') { log('Chat is for rooms.', 'err'); return; }
  const n = [...S.peers.values()].filter((p) => p.verified).length;
  S.chat.push({ own: true, name: 'You', text, ts: Date.now() });
  if (!n) S.chat.push({ sys: true, text: 'No one else is here yet, so nobody received this.' });
  broadcast('chat', { text });
  renderChat();
}
function systemChat(text) { if (S.mode === 'room') { S.chat.push({ sys: true, text }); renderChat(); } }

async function leaveRoom() {
  if (S.mode !== 'room') return;
  try { broadcast('bye', {}); } catch {}
  try { await S.room?.leave(); } catch {}
  if (S.roomId) { sessionStorage.removeItem('chess.log.' + S.roomId); sessionStorage.removeItem('chess.key.' + S.roomId); }
  clearInterval(S.gitPoll);
  Object.assign(S, { git: null, gitInfo: null, gitPoll: null, room: null, roomId: null, secret: null, anchor: null, key: null, peers: new Map(), actions: {}, chat: [], unread: 0, selfId: null });
  history.replaceState(null, '', APP_DIR);
  $('#hdrRoom').classList.add('hidden');
}
async function leaveLocal() { if (S.mode && S.mode !== 'room') sessionStorage.removeItem('chess.local'); }

async function leave() {
  if (S.mode === 'room' && mySeat() && live() && bothSeated() && !S.gitInfo) {
    if (!(await confirmBox('Leave the room?', 'Leaving deletes your seat key from this tab, so you cannot come back to this game and it cannot be finished. (Reloading the page instead keeps your seat.)', 'Leave'))) return;
  }
  await leaveRoom(); await leaveLocal();
  S.mode = null; S.log = []; S.st = null; S.proposal = null;
  $('#game').classList.add('hidden'); $('#landing').classList.remove('hidden'); $('#btnNew').classList.add('hidden');
  initLanding();
}

// Friendly two-word names, picked from the connection id.
const ADJ = ['Brave', 'Calm', 'Clever', 'Swift', 'Quiet', 'Bold', 'Lucky', 'Sunny', 'Witty', 'Gentle', 'Keen', 'Merry', 'Noble', 'Royal', 'Steady', 'Daring'];
const NOUN = ['Otter', 'Falcon', 'Badger', 'Lynx', 'Heron', 'Panda', 'Raven', 'Fox', 'Bison', 'Owl', 'Tiger', 'Koala', 'Wolf', 'Gecko', 'Moose', 'Crane'];
function friendlyName(id) { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `${ADJ[h % 16]} ${NOUN[(h >> 4) % 16]}`; }

// ---------------------------------------------------------------------------- actions (GUI and console share these)
async function playMove(m) {
  S.proposal = null;
  if (!m) return false;
  if (!canMoveNow()) { log(whyCannotMove(), 'err'); render(); return false; }
  const g = game();
  if (!g.find(m.uci)) { log(`${m.san} is not legal here.`, 'err'); return false; }
  if (S.mode === 'analysis') {
    // analysis: either side moves, signed as the side to move (trusted local log)
    return commit({ t: 'move', by: g.turn, uci: m.uci });
  }
  const body = { t: 'move', by: g.turn, uci: m.uci };
  if (S.st.tc) body.clk = Math.max(0, Math.round(remaining(g.turn) + S.st.tc.inc));
  return commit(body);
}
function whyCannotMove() {
  if (!S.st) return 'There is no game yet.';
  if (S.review !== null) return 'You are reviewing an earlier move. Press ⏭ (or End) to return to the game.';
  if (S.thinking) return 'The engine is thinking.';
  if (!live()) return 'The game is over.';
  if (!bothSeated()) return 'Waiting for the second player.';
  const me = mySeat();
  if (!me) return 'You are watching this game.';
  return `It is ${colorName(game().turn)}'s turn.`;
}
async function resign() {
  if (!live()) { log('The game is over.', 'err'); return; }
  const me = S.mode === 'local' ? game().turn : mySeat();
  if (!me) { log('Only a player can resign.', 'err'); return; }
  if (!(await confirmBox('Resign?', `${colorName(me)} resigns and the game ends.`, 'Resign'))) return;
  await commit({ t: 'resign', by: me });
}
async function offerOrAccept(kind) {
  if (!S.st) return;
  const me = mySeat();
  if (S.mode !== 'room') return localAction(kind);
  if (!me) { log('Only a player can do that.', 'err'); return; }
  const p = S.st.pending;
  if (p && p.kind === kind && p.by !== me) { await commit({ t: 'reply', by: me, kind, accept: true }); return; }
  if (p && p.kind === kind && p.by === me) { log('Your offer is already waiting for an answer.'); return; }
  if (await commit({ t: 'offer', by: me, kind })) log(`You offered ${kind === 'draw' ? 'a draw' : kind === 'rematch' ? 'a rematch' : 'to take back your last move'}. Waiting for an answer.`, 'cmd');
}
async function decline() {
  const p = S.st?.pending, me = mySeat();
  if (!p || p.by === me || !me) { log('There is nothing to decline.', 'err'); return; }
  await commit({ t: 'reply', by: me, kind: p.kind, accept: false });
}
// On this device a takeback, draw or rematch needs nobody's consent.
async function localAction(kind) {
  if (kind === 'takeback') {
    // drop trailing events back to before the last move you made (two plies against the engine)
    let events = [...S.log];
    const target = S.mode === 'engine' ? other(S.engineColor) : null;
    const removeMove = () => { while (events.length > 2 && events.at(-1).t !== 'move') events.pop(); if (events.length > 2) return events.pop(); return null; };
    if (S.st.result && events.at(-1).t !== 'move') events.pop();
    let removed = removeMove();
    if (!removed) { log('Nothing to take back.', 'err'); return; }
    if (target) { while (removed && removed.by !== target) removed = removeMove(); if (!removed) { log('Nothing to take back.', 'err'); return; } }
    const st = await replay(events, replayOpts());
    S.thinking = false;
    await setLog(events, st);
    return;
  }
  if (kind === 'draw') {
    if (!live()) return;
    if (!(await confirmBox('Agree a draw?', 'The game ends as a draw.', 'Draw'))) return;
    await commit({ t: 'offer', by: game().turn, kind: 'draw' });
    await commit({ t: 'reply', by: other(game().turn), kind: 'draw', accept: true });
    return;
  }
  if (kind === 'rematch') return newLocalGame(true);
}
async function newLocalGame(swap = false) {
  if (S.mode === 'room') return offerOrAccept('rematch');
  const color = S.mode === 'engine' ? (swap ? S.engineColor : other(S.engineColor)) : 'w';
  await startLocal(S.mode, { color, level: S.level });
}

// ---------------------------------------------------------------------------- typed input (moves, natural language, commands)
async function runInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return;
  if (text.startsWith('/')) return runCommand(text);
  log('> ' + text, 'cmd');
  if (!S.st) { log('There is no game yet.', 'err'); return; }
  const g = boardGame();
  const r = parseIntent(text, g);
  if (r.kind === 'command') return runCommand('/' + r.command);
  if (!canMoveNow()) { log(whyCannotMove(), 'err'); return; }
  if (r.kind === 'move') {
    if (/^([a-h][1-8]){2}[qrbn]?$|^[NBRQK]?[a-h]?[1-8]?x?[a-h][1-8](=?[QRBN])?[+#]?$|^O-O(-O)?[+#]?$/i.test(text)) return playMove(r.move); // plain notation on this device: play at once
    return propose([r.move], text, 'grammar');
  }
  if (r.kind === 'ambiguous' && !ai.ready) return propose(r.candidates, text, 'grammar');
  if (r.kind === 'none' && !ai.ready) { log(`${r.why}`, 'err'); return; }
  if (!ai.ready) { log('Not understood. Try notation (e4, Nf3, O-O, e2e4) or words like "knight to f3", "take the pawn", "castle kingside". Loading the on-device model (AI tab) lets it try freer wording.', 'err'); return; }
  // The model only sees what the grammar could not place, and only the closed list of options.
  log(`Asking the on-device model (${ai.modelId}). It may only pick from ${r.kind === 'ambiguous' ? r.candidates.length + ' candidate moves' : 'the legal moves and commands'}.`, 'ai');
  try {
    const a = await ai.interpret(text, g, r.kind === 'ambiguous' ? { candidates: r.candidates, commands: [] } : {});
    for (const t of a.trace) log(`  attempt ${t.attempt}: ${t.reply || '(no reply)'} → ${t.verdict}`, 'ai');
    renderAiTrace(text, a);
    if (a.kind === 'move') return propose([a.move], text, 'model');
    if (a.kind === 'command') { const ok = await confirmBox('Run this command?', `The model read "${text}" as /${a.command}.`, `Run /${a.command}`); if (ok) return runCommand('/' + a.command); return; }
    log(a.why || 'The model found nothing in the list that fits.', 'err');
    if (r.kind === 'ambiguous') propose(r.candidates, text, 'grammar');
  } catch (e) { log(`Model error: ${e.message}`, 'err'); }
}
// Show one or more moves to confirm. Nothing is played until you press it.
function propose(moves, text, source) {
  S.proposal = { moves, text, source };
  renderProposal();
  if (moves.length === 1) log(`${source === 'model' ? 'The model proposes' : 'Understood as'} ${moves[0].san}: ${describeMove(moves[0])}. Press Play (or Enter) to confirm.`, source === 'model' ? 'ai' : '');
  else log(`"${text}" fits ${moves.length} legal moves: ${moves.map((m) => m.san).join(', ')}. Pick one.`);
}

// ---------------------------------------------------------------------------- console commands
const HELP = [
  ['<move>', 'e4, Nf3, O-O, e7e8q, or words: "knight to f3", "take the queen", "castle long"'],
  ['/move <move>', 'the same, explicitly'],
  ['/flip', 'turn the board around'],
  ['/takeback', 'ask to take back your last move (on this device: just undo)'],
  ['/draw', 'offer a draw, or accept the one offered'],
  ['/accept · /decline', 'answer a pending offer (draw, takeback or rematch)'],
  ['/resign', 'resign (asks first)'],
  ['/rematch', 'a new game with colours swapped (in a room: an offer)'],
  ['/new', 'a new game in the same mode on this device'],
  ['/hint', 'ask the local engine (not for players during a live room game)'],
  ['/eval', 'the engine\'s evaluation of the board shown'],
  ['/level <1-5>', 'computer strength'],
  ['/describe', 'read out where every piece is'],
  ['/fen · /pgn', 'print (and copy) the position or the game'],
  ['/load <fen|pgn>', 'load a position or game (on-device modes)'],
  ['/first /prev /next /last', 'review the game; arrow keys do the same'],
  ['/seats · /peers', 'who plays which colour; who is connected'],
  ['/chat <text>', 'message the room'],
  ['/invite · /qr', 'copy the invite link; show it as a QR code'],
  ['/claim', 'take the open seat in a git-backed game'],
  ['/sync', 'load the latest from the game\'s git repo now'],
  ['/token <token> [remember]', 'set the GitHub token for this game\'s repo (remember = keep it on this device)'],
  ['/repo', 'where this game lives, and its commit history'],
  ['/games · /forget', 'git-backed games kept on this device; remove this one'],
  ['/ai load [model] · /ai unload · /ai status', 'the optional on-device language model'],
  ['/ai <words>', 'ask the model directly (it still only proposes a legal move)'],
  ['/board [theme]', 'board colours: slate, walnut, forest, ice, plum, coal'],
  ['/sounds on|off', 'move sounds (the speaker in the header does the same)'],
  ['/egress', 'every host this page is set to contact, and the ones it has contacted'],
  ['/about', 'version, pinned libraries, protocol'],
  ['/leave', 'back to the start screen'],
];
async function runCommand(line) {
  log(line, 'cmd');
  const [cmd0, ...rest] = line.slice(1).split(/\s+/);
  const cmd = cmd0.toLowerCase();
  const arg = rest.join(' ');
  switch (cmd) {
    case 'help': case '?': log(HELP.map(([a, b]) => `${a.padEnd(22)} ${b}`).join('\n')); log('Typed words go through a fixed grammar first. The model (if loaded) only sees what the grammar could not place, and can only pick from the legal moves.', 'dim'); break;
    case 'move': case 'm': { const g = boardGame(); const r = parseIntent(arg, g); if (r.kind === 'move') await playMove(r.move); else if (r.kind === 'ambiguous') propose(r.candidates, arg, 'grammar'); else log(r.why || 'Not a move.', 'err'); break; }
    case 'flip': S.flipped = !S.flipped; renderBoard(); renderBars(); break;
    case 'takeback': case 'undo': await offerOrAccept('takeback'); break;
    case 'draw': await offerOrAccept('draw'); break;
    case 'accept': { const p = S.st?.pending; if (!p) log('There is nothing to accept.', 'err'); else await offerOrAccept(p.kind); break; }
    case 'decline': await decline(); break;
    case 'resign': await resign(); break;
    case 'rematch': if (S.mode === 'room') await offerOrAccept('rematch'); else await newLocalGame(true); break;
    case 'new': if (S.mode === 'room') log('In a room, use /rematch after the game.', 'err'); else await newLocalGame(false); break;
    case 'hint': await hint(); break;
    case 'eval': {
      if (!assistAllowed()) { log('The engine is off for players during a live room game.', 'err'); break; }
      const g = boardGame(); const r = await engineSearch(g.fen(), 4, { seed: 0 });
      log(r.uci ? `Evaluation: ${formatScore(r, g.turn)}. Best: ${r.san}. Depth ${r.depth}, ${r.nodes.toLocaleString()} positions, ${r.ms} ms, stopped by ${r.stoppedBy}.` : 'No legal moves.');
      break;
    }
    case 'level': { const n = Number(arg); if (!LEVELS[n]) { log('Level 1 to 5.', 'err'); break; } S.level = n; $('#selLevel').value = String(n); log(`Engine level ${n}: ${LEVELS[n].label} (depth ≤ ${LEVELS[n].depth}, ≤ ${LEVELS[n].nodes.toLocaleString()} positions, ≤ ${LEVELS[n].ms} ms).`); if (S.mode === 'engine') { const c = other(S.engineColor); renameLocal(); void c; } break; }
    case 'describe': log(describePosition(boardGame())); break;
    case 'fen': { const f = boardGame().fen(); log(f); copy(f); break; }
    case 'pgn': { const p = S.st ? pgnOf(S.st) : ''; log(p); copy(p); break; }
    case 'load': await loadText(arg); break;
    case 'first': goReview('first'); break;
    case 'prev': goReview('prev'); break;
    case 'next': goReview('next'); break;
    case 'last': goReview('last'); break;
    case 'seats': for (const c of ['w', 'b']) { const s = S.st?.seats[c]; log(`${colorName(c)}: ${s ? `${s.name} (key ${s.keyId.slice(0, 8)})${s.creator ? ', room creator' : ''}${S.key && s.keyId === S.key.keyId ? ', you' : ''}` : 'open'}`); } break;
    case 'peers': if (S.mode !== 'room') { log('Not in a room.'); break; } log([...S.peers.values()].map((p) => `${short(p.id)}  ${p.name}${p.verified ? '' : ' (no hello yet)'}${p.incompatible ? ' (incompatible version)' : ''}${roleOf(p)}`).join('\n') || 'No one else is connected.'); break;
    case 'chat': sendChat(arg); break;
    case 'invite': if (S.mode === 'room') { copy(inviteUrl()); log(inviteUrl()); } else log('Not in a room.', 'err'); break;
    case 'qr': await showQr(); break;
    case 'ai': await aiCommand(arg); break;
    case 'claim': await claimSeat(); break;
    case 'sync': if (!S.git) log('This game is not kept in a git repo.', 'err'); else await gitSync({ quiet: false }); break;
    case 'token': {
      if (!S.gitInfo) { log('This game is not kept in a git repo.', 'err'); break; }
      const [tok, keep] = rest;
      if (!tok) { log(S.git.token ? 'A token is set for this repo.' : 'No token set. /token <token> [remember]'); break; }
      saveToken(S.gitInfo.repo, tok, keep === 'remember');
      S.git.token = tok; startGitPolling();
      log(`Token set for ${S.gitInfo.repo}${keep === 'remember' ? ', kept on this device' : ', for this tab only'}.`, 'ok');
      await gitSync({ quiet: false });
      break;
    }
    case 'repo': if (!S.git) log('This game is not kept in a git repo.'); else log(`${S.git.repo} · branch ${S.git.branch} · ${S.git.path} · ${S.git.readable ? 'readable' : 'encrypted'}\nFile: ${S.git.webUrl}\nHistory: ${S.git.historyUrl}\n${S.git.requests} API requests this session.`); break;
    case 'games': { const l = gamesIndex(); log(l.length ? l.map((g) => `${g.title} · ${g.repo} · ${g.moves} moves · ${g.state}`).join('\n') : 'No git-backed games on this device.'); break; }
    case 'forget': {
      if (!S.gitInfo) { log('Only git-backed games are kept on this device.', 'err'); break; }
      if (!(await confirmBox('Remove this game from this device?', 'Its link and your seat key are deleted here. The game stays in the repo, but you can no longer move in it.', 'Remove'))) break;
      const id = S.roomId; await leaveRoom(); forgetGame(id); S.mode = null; S.log = []; S.st = null;
      $('#game').classList.add('hidden'); $('#landing').classList.remove('hidden'); $('#btnNew').classList.add('hidden'); initLanding();
      break;
    }
    case 'board': {
      const k = arg.trim().toLowerCase();
      if (!k) { log(`Board themes: ${Object.entries(BOARD_THEMES).map(([n]) => n + ((settings.board || 'slate') === n ? ' (current)' : '')).join(', ')}. /board <name> to switch.`); break; }
      if (!BOARD_THEMES[k]) { log(`No board theme "${k}". Themes: ${Object.keys(BOARD_THEMES).join(', ')}.`, 'err'); break; }
      log(`Board: ${applyBoardTheme(k).label}.`, 'ok');
      break;
    }
    case 'sounds': settings.sounds = !/off|0|no/.test(arg); saveSettings(); updateMuteBtn(); if (settings.sounds !== false) sound('move'); log(`Sounds ${settings.sounds !== false ? 'on' : 'off'}.`); break;
    case 'egress': egressReport(); break;
    case 'about': log([`chess-webCLI ${VERSION}, protocol ${PROTO}.`, ...Object.entries(PINS).map(([f, p]) => `lib/${f}  ${p.package}@${p.version}  sha256:${p.sha256.slice(0, 16)}…  (verified when loaded)`), 'Rules: js/chess.js (perft-tested). Engine: js/engine.js. Grammar: js/intent.js. Model bounds: js/ai.js. Log: js/log.js.'].join('\n')); break;
    case 'leave': await leave(); break;
    default: log(`Unknown command /${cmd}. Type /help.`, 'err');
  }
}
const roleOf = (p) => { for (const c of ['w', 'b']) if (S.st?.seats[c]?.keyId === p.keyId) return ` — plays ${colorName(c)}`; return p.verified ? ' — watching' : ''; };
function renameLocal() { /* names in an on-device log are fixed at start; level shows in the status line */ render(); }

async function loadText(text) {
  text = String(text || '').trim();
  if (S.mode === 'room') { log('Loading positions is for on-device games. In a room the game is the signed log.', 'err'); return; }
  if (!text) { openLoadDialog(); return; }
  const isFen = !Chess.validateFen(text);
  if (isFen) { await startLocal(S.mode === 'engine' ? 'engine' : 'analysis', { color: S.mode === 'engine' ? other(S.engineColor) : 'w', level: S.level, fen: text }); log('Position loaded.', 'ok'); return; }
  const p = Chess.parsePgn(text);
  if (!p.ok) { log(`Could not load: ${p.error || Chess.validateFen(text)}`, 'err'); return; }
  // rebuild as an on-device log
  await startLocal('analysis', { fen: p.headers.FEN || null });
  for (const m of p.game.history()) await commit({ t: 'move', by: game().turn, uci: m.uci });
  log(`Loaded ${p.game.ply()} moves${p.headers.White ? ` (${p.headers.White} – ${p.headers.Black})` : ''} into the analysis board.`, 'ok');
}

// ---------------------------------------------------------------------------- the model (AI tab)
async function aiCommand(arg) {
  const [sub, ...r] = arg.split(/\s+/);
  if (sub === 'load') return loadModel(r[0] || $('#aiModel')?.value || MODELS[0].id);
  if (sub === 'unload') { await ai.unload(); log('Model unloaded. Its weights stay in the browser cache until you clear site data.'); renderAi(); return; }
  if (!sub || sub === 'status') { log(ai.ready ? `Model loaded: ${ai.modelId}. Bounds: closed list, ≤ ${MAX_ATTEMPTS} attempts, proposal only.` : `No model loaded. ${BoundedAI.webgpuAvailable() ? 'WebGPU is available.' : 'This browser has no WebGPU.'} Models: ${MODELS.map((m) => m.id).join(', ')}`); return; }
  if (!ai.ready) { log('No model loaded. /ai load', 'err'); return; }
  const g = boardGame();
  const a = await ai.interpret(arg, g);
  for (const t of a.trace) log(`  attempt ${t.attempt}: ${t.reply || '(no reply)'} → ${t.verdict}`, 'ai');
  renderAiTrace(arg, a);
  if (a.kind === 'move') propose([a.move], arg, 'model');
  else if (a.kind === 'command') log(`The model read that as /${a.command}. Type it to run it.`, 'ai');
  else log(a.why || 'The model found nothing that fits.', 'ai');
}
async function loadModel(id) {
  const m = MODELS.find((x) => x.id === id);
  if (!m) { log(`Unknown model. Choose one of: ${MODELS.map((x) => x.id).join(', ')}`, 'err'); return; }
  const ok = await confirmBox('Download the model?', `${m.label} is about ${m.size}. It downloads once from ${MODEL_HOSTS.join(' and ')}, is kept in this browser's cache, and then runs entirely on this device. Nothing you type is sent anywhere. Continue?`, 'Download and load');
  if (!ok) return;
  S.aiLoading = { text: 'Starting…', progress: 0 }; renderAi();
  try {
    await ai.load(id, (p) => { S.aiLoading = { text: p.text || '', progress: p.progress || 0 }; renderAi(); });
    S.aiLoading = null;
    log(`Model ready: ${id}. Typed words that the grammar cannot place now go to it.`, 'ok');
  } catch (e) { S.aiLoading = null; log(`Model not loaded: ${e.message}`, 'err'); }
  renderAi();
}

// ---------------------------------------------------------------------------- clocks
function remaining(c) {
  const st = S.st;
  if (!st?.tc) return Infinity;
  if (st.tc.days) {
    // days per move: the side to move has until the deadline; the other side shows its full allowance
    if (st.deadline && !st.result && game().turn === c) return st.deadline - Date.now();
    return st.tc.days * 864e5;
  }
  let t = st.clocks[c] ?? st.tc.base;
  const running = !st.result && st.moveIdx.length >= 1 && game().turn === c;
  if (running) t -= Date.now() - S.clockAt;
  return t;
}
const fmtClock = (ms) => {
  if (!Number.isFinite(ms)) return '';
  const neg = ms < 0; ms = Math.max(0, ms);
  if (ms >= 3600e3) { const d = Math.floor(ms / 864e5), h = Math.floor((ms % 864e5) / 3600e3), m = Math.floor((ms % 3600e3) / 60e3); return d ? `${d}d ${h}h` : `${h}h ${String(m).padStart(2, '0')}m`; }
  const s = ms / 1000;
  if (s < 10) return (neg ? '-' : '') + s.toFixed(1);
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
};
setInterval(async () => {
  if (!S.st?.tc || S.st.result) return;
  renderClocks();
  const turn = game().turn;
  const t = remaining(turn);
  if (S.flagSent || !Number.isFinite(t)) return;
  if (S.st.tc.days) {
    // correspondence: either player's page may record a deadline that has passed
    const me = mySeat();
    if (me && S.st.deadline && Date.now() >= S.st.deadline && bothSeated()) { S.flagSent = true; await commit({ t: 'flag', by: me, color: turn }); }
    return;
  }
  if (S.mode === 'room') {
    const me = mySeat();
    // your own browser reports your flag; your opponent's claims it after a short grace period
    if (me && ((turn === me && t <= 0) || (turn !== me && t <= -FLAG_GRACE_MS))) { S.flagSent = true; await commit({ t: 'flag', by: me, color: turn }); }
  } else if (S.mode === 'local' && t <= 0) { S.flagSent = true; await commit({ t: 'flag', by: turn, color: turn }); }
}, 200);

// ---------------------------------------------------------------------------- rendering
function showGame() {
  $('#landing').classList.add('hidden'); $('#game').classList.remove('hidden'); $('#btnNew').classList.remove('hidden');
}
// The game as shown: live, or the position at the reviewed ply.
function boardGame() {
  if (!S.st) return new Chess();
  if (S.review === null) return S.st.game;
  const g = new Chess(S.st.startFen);
  for (const m of S.st.game.history().slice(0, S.review)) g.move(m.uci);
  return g;
}
function render() { renderBoard(); renderBars(); renderStatus(); renderPeople(); renderMoves(); renderControls(); renderProposal(); renderChat(); renderAi(); updateTitle(); }

const boardEl = $('#board');
function renderBoard() {
  const g = boardGame();
  boardEl.textContent = '';
  const last = S.review === null ? g.lastMove() : (() => { const h = S.st?.game.history() || []; const m = h[S.review - 1]; return m ? { from: m.from, to: m.to } : null; })();
  const legalFrom = S.sel ? g.moves({ square: S.sel }) : [];
  const checkSq = g.inCheck() ? findKing(g, g.turn) : null;
  for (let rr = 0; rr < 8; rr++) {
    for (let ff = 0; ff < 8; ff++) {
      const r = S.flipped ? 7 - rr : rr, f = S.flipped ? 7 - ff : ff;
      const name = 'abcdefgh'[f] + (8 - r);
      const p = g.board()[r][f];
      const sq = el('div', { class: `sq ${(r + f) % 2 ? 'd' : 'l'}`, 'data-sq': name, role: 'gridcell', 'aria-label': `${name}${p ? ' ' + (p === p.toUpperCase() ? 'white ' : 'black ') + { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[p.toLowerCase()] : ''}` });
      if (last && (name === last.from || name === last.to)) sq.classList.add('last');
      if (S.sel === name) sq.classList.add('sel');
      if (S.hint && (S.hint.from === name || S.hint.to === name)) sq.classList.add('hint');
      if (checkSq === name) sq.classList.add('check');
      if (rr === 7) sq.append(el('span', { class: 'coord f', text: 'abcdefgh'[f] }));
      if (ff === 0) sq.append(el('span', { class: 'coord r', text: String(8 - r) }));
      if (p) sq.append(el('span', { class: `pc ${p === p.toUpperCase() ? 'w' : 'b'}`, text: glyph(p) }));
      const tgt = legalFrom.find((m) => m.to === name);
      if (tgt) sq.append(el('span', { class: tgt.captured ? 'ring' : 'dotm' }));
      boardEl.append(sq);
    }
  }
  renderBoardMsg(g);
}
function findKing(g, c) { const k = c === 'w' ? 'K' : 'k'; const b = g.board(); for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) if (b[r][f] === k) return 'abcdefgh'[f] + (8 - r); return null; }
function renderBoardMsg(g) {
  let msg = null;
  if (S.mode === 'room' && !S.st) msg = { big: 'Connecting…', sub: S.peers.size ? 'Waiting for the game from the others in the room.' : 'Waiting for someone else to join. Send the invite link.' };
  else if (S.mode === 'room' && !bothSeated() && S.st.claim) {
    const open = !S.st.seats.w ? 'w' : 'b';
    msg = mySeat()
      ? { big: 'Waiting for an opponent', sub: 'Send the invite link. Whoever opens it and presses "Take the seat" plays ' + colorName(open) + '. Neither of you needs to be online at the same time.', btn: { label: 'Copy invite link', fn: () => { copy(inviteUrl()); log('Invite link copied.'); } } }
      : { big: `${colorName(open)} is open`, sub: S.git && !S.git.token ? 'To play, add a GitHub token with write access to the repo (/token in the console), then take the seat.' : `Take it to play ${S.st.seats[other(open)]?.name || 'the room creator'}. You can move whenever it is your turn; the game waits in the repo.`, btn: { label: `Take the seat (${colorName(open)})`, fn: () => claimSeat() } };
  }
  else if (S.mode === 'room' && !bothSeated()) msg = { big: 'Waiting for an opponent', sub: isCreator() ? 'Send the invite link (the link icon at the top). The first person to join plays the other colour.' : 'The room creator\'s browser gives the open seat to the first person who joins. If you are watching, it already went to someone else.', btn: isCreator() ? { label: 'Copy invite link', fn: () => { copy(inviteUrl()); log('Invite link copied.'); } } : null };
  else if (S.st?.result && S.review === null) msg = { big: S.st.result.result === '1/2-1/2' ? 'Draw' : `${S.st.result.result === '1-0' ? 'White' : 'Black'} wins`, sub: S.st.result.reason[0].toUpperCase() + S.st.result.reason.slice(1) + '.' };
  const old = $('#boardMsg'); if (old) old.remove();
  if (!msg) return;
  const box = el('div', {}, el('div', { class: 'big', text: msg.big }), el('div', { class: 'dim', text: msg.sub }));
  if (msg.btn) box.append(el('div', { style: 'margin-top:10px' }, el('button', { class: 'primary', type: 'button', text: msg.btn.label, onclick: msg.btn.fn })));
  if (S.st?.result && S.review === null) box.append(el('div', { style: 'margin-top:10px;display:flex;gap:8px;justify-content:center' }, el('button', { type: 'button', text: 'Review', onclick: () => goReview('first') }), (S.mode !== 'room' || mySeat()) ? el('button', { class: 'primary', type: 'button', text: S.mode === 'room' ? 'Offer rematch' : 'New game', onclick: () => (S.mode === 'room' ? offerOrAccept('rematch') : newLocalGame(true)) }) : null));
  boardEl.append(el('div', { id: 'boardMsg' }, box));
}

function material(g) {
  const start = { p: 8, n: 2, b: 2, r: 2, q: 1 };
  const have = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 }, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } };
  for (const p of g.board().flat()) if (p && p.toLowerCase() !== 'k') have[p === p.toUpperCase() ? 'w' : 'b'][p.toLowerCase()]++;
  const val = { p: 1, n: 3, b: 3, r: 5, q: 9 };
  const score = (c) => Object.entries(have[c]).reduce((s, [t, n]) => s + val[t] * n, 0);
  // pieces each side has captured (missing from the other side, ignoring promotions)
  const took = (c) => 'qrbnp'.split('').map((t) => glyph(t).repeat(Math.max(0, start[t] - have[other(c)][t]))).join('');
  return { took, diff: score('w') - score('b') };
}
function renderBars() {
  const g = boardGame();
  const bottom = S.flipped ? 'b' : 'w', top = other(bottom);
  const mat = material(g);
  for (const [id, c] of [['#barTop', top], ['#barBot', bottom]]) {
    const bar = $(id);
    const seat = S.st?.seats[c];
    let name = seat?.name || colorName(c);
    let online = null;
    if (S.mode === 'room') {
      const p = peerForSeat(c);
      online = !!p; if (p === 'me') name += ' (you)';
      if (!seat) name = `${colorName(c)}: open`;
    }
    if (S.mode === 'engine' && c === S.engineColor) name = engineName() + (S.thinking ? ' · thinking…' : '');
    const who = bar.querySelector('.who');
    who.textContent = '';
    if (online !== null) who.append(el('span', { class: `dot ${online ? 'on' : ''}`, title: online ? 'Connected' : 'Not connected' }));
    who.append(document.createTextNode(`${c === 'w' ? '○' : '●'} ${name}`));
    const caps = bar.querySelector('.caps');
    caps.textContent = mat.took(c);
    const d = c === 'w' ? mat.diff : -mat.diff;
    if (d > 0) caps.append(el('b', { text: `+${d}` }));
  }
  renderClocks();
}
function renderClocks() {
  const bottom = S.flipped ? 'b' : 'w', top = other(bottom);
  for (const [id, c] of [['#barTop', top], ['#barBot', bottom]]) {
    const ck = $(id).querySelector('.clock');
    if (!S.st?.tc) { ck.classList.add('hidden'); continue; }
    ck.classList.remove('hidden');
    const t = remaining(c);
    ck.textContent = fmtClock(t);
    const days = !!S.st.tc.days;
    const running = !S.st.result && game().turn === c && (days ? !!S.st.deadline : S.st.moveIdx.length >= 1);
    const low = days ? 6 * 3600e3 : 20000;
    ck.classList.toggle('run', running && t >= low);
    ck.classList.toggle('low', running && t < low);
    ck.title = days ? (running ? `Must move by ${new Date(S.st.deadline).toLocaleString()}` : `${S.st.tc.days} day${S.st.tc.days > 1 ? 's' : ''} per move`) : '';
  }
}
function renderStatus() {
  const main = $('#status .main'), sub = $('#status .sub');
  if (!S.st) { main.textContent = S.mode === 'room' ? 'Connecting to the room…' : ''; sub.textContent = S.mode === 'room' ? relayLine() : ''; return; }
  const g = game();
  let m;
  if (S.st.result) m = `Game over: ${S.st.result.result} · ${S.st.result.reason}`;
  else if (!bothSeated()) m = 'Waiting for the second player';
  else if (S.thinking) m = 'The computer is thinking…';
  else {
    const me = mySeat();
    m = S.mode === 'room' ? (me ? (g.turn === me ? 'Your move' : `${S.st.seats[g.turn]?.name || colorName(g.turn)} to move`) : `${colorName(g.turn)} to move (you are watching)`) : `${colorName(g.turn)} to move`;
    if (g.inCheck()) m += ' · check';
  }
  if (S.review !== null) m = `Reviewing move ${S.review} of ${g.ply()} · ${m}`;
  main.textContent = m;
  const bits = [];
  bits.push({ engine: `On this device vs the engine, level ${S.level} (${LEVELS[S.level].label}) · nothing leaves the device`, local: 'Pass and play on this device · nothing leaves the device', analysis: 'Analysis board · nothing leaves the device', room: `Room · game ${S.st.gameNo}${S.st.tc?.days ? ` · ${S.st.tc.days} day${S.st.tc.days > 1 ? 's' : ''} per move` : S.st.tc ? ` · ${S.st.tc.base / 60000} + ${S.st.tc.inc / 1000}` : ' · no clock'}` }[S.mode]);
  if (S.st.tc?.days && S.st.deadline && !S.st.result) bits.push(`${colorName(game().turn)} must move by ${new Date(S.st.deadline).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`);
  if (S.st.pending) {
    const p = S.st.pending; const who = S.st.seats[p.by]?.name || colorName(p.by);
    bits.push(`${p.by === mySeat() ? 'You offered' : `${who} offers`} ${p.kind === 'draw' ? 'a draw' : p.kind === 'rematch' ? 'a rematch' : 'a takeback'}`);
  }
  if (S.mode === 'room') bits.push(assistAllowed() ? 'engine available to you' : 'engine off for players during the game');
  sub.textContent = bits.join(' · ');
  renderGitLine();
}
function renderGitLine() {
  let line = $('#gitLine');
  if (!S.git) { line?.remove(); return; }
  if (!line) { line = el('div', { id: 'gitLine', class: 'sub' }); $('#status').append(line); }
  line.textContent = '';
  const when = S.gitLastSync ? `synced ${Math.max(0, Math.round((Date.now() - S.gitLastSync) / 60e3))} min ago` : 'not synced yet';
  line.append(document.createTextNode(`Kept in `), el('a', { href: S.git.historyUrl, target: '_blank', rel: 'noopener noreferrer', text: S.git.repo, title: 'Open the game file\'s commit history on GitHub' }),
    document.createTextNode(` · ${S.git.readable ? 'readable' : 'encrypted'} · ${S.gitBusy ? 'syncing…' : when}${S.git.token ? '' : ' · no token (watching only)'}`));
  if (S.gitError || S.gitStatus) line.append(el('div', { style: 'color:var(--warn)', text: S.gitError || S.gitStatus }));
}
const relayLine = () => `Introductions via ${activeRelays().length} relays. If nobody arrives, check that the other person opened the same link.`;
function renderPeople() {
  const box = $('#people');
  box.textContent = '';
  if (S.mode !== 'room') { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.append(el('h3', { text: 'People' }));
  const seats = S.st?.seats || {};
  const meRow = el('div', { class: 'rrow' }, el('span', { class: 'nm', text: `You — ${myName()}` }), el('span', { class: 'chip acc', text: mySeat() ? `plays ${colorName(mySeat())}` : 'watching' }));
  if (isCreator()) meRow.append(el('span', { class: 'chip', text: 'room creator' }));
  box.append(meRow);
  for (const p of S.peers.values()) {
    const row = el('div', { class: 'rrow' }, el('span', { class: 'nm', text: p.name }));
    if (p.incompatible) row.append(el('span', { class: 'chip bad', text: 'incompatible version' }));
    else if (!p.verified) row.append(el('span', { class: 'chip warn', text: 'connecting' }));
    else {
      const c = ['w', 'b'].find((x) => seats[x]?.keyId === p.keyId);
      row.append(el('span', { class: `chip ${c ? 'ok' : ''}`, text: c ? `plays ${colorName(c)}` : 'watching' }));
      if (seats.w && seats.w.keyId === p.keyId && seats.w.creator || seats.b && seats.b.keyId === p.keyId && seats.b.creator) row.append(el('span', { class: 'chip', text: 'room creator' }));
    }
    box.append(row);
  }
  for (const c of ['w', 'b']) if (seats[c] && !peerForSeat(c)) box.append(el('div', { class: 'rrow dim', text: `${seats[c].name} (${colorName(c)}) is not connected right now.` }));
  if (!S.peers.size) box.append(el('div', { class: 'rrow dim', text: 'No one else is here yet.' }));
}
function renderMoves() {
  const out = $('#movesOut');
  out.textContent = '';
  if (!S.st) return;
  const hist = S.st.game.history();
  const blackFirst = S.st.startFen.split(' ')[1] === 'b';
  let num = Number(S.st.startFen.split(' ')[5]);
  const t = el('table');
  let row = null;
  const cur = S.review === null ? hist.length : S.review;
  hist.forEach((m, i) => {
    const white = blackFirst ? i % 2 === 1 : i % 2 === 0;
    if (white || !row) { row = el('tr', {}, el('td', { class: 'n', text: `${num}.` })); t.append(row); if (!white) row.append(el('td', { text: '…' })); }
    row.append(el('td', { class: `m ${cur === i + 1 ? 'cur' : ''}`, text: m.san, title: describeMove(m), onclick: () => { S.review = i + 1 === hist.length ? null : i + 1; S.sel = null; render(); } }));
    if (!white) num++;
  });
  if (!hist.length) out.append(el('div', { class: 'dim', text: 'No moves yet.' }));
  else out.append(t);
  if (S.st.result) out.append(el('div', { class: 'dim', style: 'margin-top:6px', text: `${S.st.result.result} — ${S.st.result.reason}` }));
  if (S.st.games.length) out.append(el('div', { class: 'dim', style: 'margin-top:10px', text: `Earlier games in this room: ${S.st.games.map((x, i) => `#${i + 1} ${x.result.result}`).join(', ')} (included in Save .pgn).` }));
  out.scrollTop = out.scrollHeight;
  $('#btnLoad').disabled = S.mode === 'room';
}
function renderControls() {
  const room = S.mode === 'room', me = mySeat(), p = S.st?.pending;
  const set = (id, { label, title, disabled = false, hidden = false, cls = '' }) => {
    const b = $('#' + id);
    if (label !== undefined) b.querySelector('.lbl').textContent = label;
    b.title = title; b.setAttribute('aria-label', title);
    b.disabled = disabled; b.classList.toggle('hidden', hidden);
    b.classList.toggle('on', cls === 'on');
  };
  const playing = !!S.st && live() && bothSeated() && (!room || !!me);
  const offered = (k) => p && p.kind === k && p.by !== me;
  set('btnFlip', { label: 'Flip', title: 'Flip the board' });
  set('btnUndo', { label: offered('takeback') ? 'Accept takeback' : 'Takeback', title: room ? (offered('takeback') ? 'Your opponent asks to take back a move. Press to agree.' : 'Ask your opponent to let you take back your last move') : 'Take back the last move', disabled: !S.st || S.mode === 'analysis' && !S.st.game.ply() || (room && (!playing || (!offered('takeback') && !S.st.game.history().some((m) => m.color === me)))), cls: offered('takeback') ? 'on' : '', hidden: S.mode === 'analysis' });
  set('btnDraw', { label: offered('draw') ? 'Accept draw' : 'Draw', title: room ? (offered('draw') ? 'Your opponent offers a draw. Press to accept.' : 'Offer a draw') : 'Agree a draw', disabled: !playing, cls: offered('draw') ? 'on' : '', hidden: S.mode === 'analysis' });
  set('btnResign', { label: 'Resign', title: 'Resign the game (asks first)', disabled: !playing, hidden: S.mode === 'analysis' });
  set('btnHint', { label: 'Hint', title: assistAllowed() ? 'Ask the local engine for a move (it runs on this device)' : 'Off for players during a live room game', disabled: !S.st || !assistAllowed() });
  set('btnAgain', { label: room ? (offered('rematch') ? 'Accept rematch' : 'Rematch') : 'New game', title: room ? 'Offer a new game with colours swapped' : 'Start a new game in this mode', disabled: room ? !(S.st?.result && me) : !S.st, cls: offered('rematch') ? 'on' : '' });
  set('btnTheme', { label: 'Board', title: 'Board colours (also /board)' });
  const n = S.st?.game.ply() || 0, cur = S.review === null ? n : S.review;
  set('btnFirst', { title: 'Go to the start (Home)', disabled: !n || cur === 0 });
  set('btnPrev', { title: 'Previous move (←)', disabled: !n || cur === 0 });
  set('btnNext', { title: 'Next move (→)', disabled: S.review === null });
  set('btnLast', { title: 'Back to the game (End)', disabled: S.review === null });
  set('btnLeave', { label: 'Leave', title: room ? 'Leave the room' : 'Back to the start screen' });
  $('#cmdIn').disabled = !S.st;
  $('#tabChat').classList.toggle('hidden', !room);
}
function renderProposal() {
  const box = $('#proposal');
  box.textContent = '';
  const pr = S.proposal;
  if (!pr) return;
  const row = el('div', { class: 'prow' });
  if (pr.moves.length === 1) {
    const m = pr.moves[0];
    row.append(el('span', { class: 't' }, el('b', { class: 'cand', text: m.san }), document.createTextNode(` — ${describeMove(m)}`), el('span', { class: 'dim', text: pr.source === 'model' ? '  (proposed by the on-device model)' : '' })));
    row.append(el('button', { class: 'primary', type: 'button', text: 'Play', title: 'Play this move', onclick: () => playMove(m) }));
  } else {
    row.append(el('span', { class: 't', text: `Which one? "${pr.text}" fits ${pr.moves.length} moves:` }));
    for (const m of pr.moves.slice(0, 16)) row.append(el('button', { class: 'cand', type: 'button', text: m.san, title: describeMove(m), onclick: () => playMove(m) }));
  }
  row.append(el('button', { type: 'button', text: 'Cancel', title: 'Do nothing', onclick: () => { S.proposal = null; renderProposal(); } }));
  box.append(row);
}
function renderChat() {
  const out = $('#chatOut');
  out.textContent = '';
  for (const m of S.chat) {
    if (m.sys) { out.append(el('div', { class: 'msg sys', text: m.text })); continue; }
    out.append(el('div', { class: `msg ${m.own ? 'own' : ''}` }, el('div', { class: 'hd' }, el('b', { text: m.name }), document.createTextNode(' · ' + new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))), el('div', { class: 'body', text: m.text })));
  }
  out.scrollTop = out.scrollHeight;
  const badge = $('#chatBadge');
  badge.textContent = String(S.unread); badge.classList.toggle('hidden', !S.unread);
  updateTitle();
}
function renderAi() {
  const box = $('#aiPane');
  box.textContent = '';
  box.append(el('p', { style: 'margin-top:0' }, el('b', { text: 'Optional, on-device, bounded. ' }), document.createTextNode('You never need it: notation and the plain-words grammar work without any model. A model only helps with freer wording ("get my horse out of danger").')));
  const gpu = BoundedAI.webgpuAvailable();
  if (!gpu) box.append(el('div', { class: 'banner warn', text: 'This browser has no WebGPU, so the model cannot run here. Chrome or Edge 113+ on a desktop usually has it.' }));
  const sel = el('select', { id: 'aiModel', title: 'Which model to load' }, ...MODELS.map((m) => el('option', { value: m.id, text: `${m.label} · ${m.size}${m.note ? ' · ' + m.note : ''}` })));
  if (ai.modelId) sel.value = ai.modelId;
  box.append(el('label', { class: 'dim', for: 'aiModel', text: 'Model (none of these has been evaluated on this task yet)' }), sel);
  const row = el('div', { style: 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap' });
  row.append(el('button', { class: 'primary', type: 'button', text: ai.ready ? 'Reload' : 'Load model', disabled: !gpu || !!S.aiLoading ? '' : null, title: 'Download the model once, then run it on this device', onclick: () => loadModel(sel.value) }));
  if (ai.ready) row.append(el('button', { type: 'button', text: 'Unload', title: 'Free the GPU memory', onclick: () => aiCommand('unload') }));
  box.append(row);
  if (S.aiLoading) box.append(el('div', { class: 'dim', style: 'margin-top:8px', text: S.aiLoading.text }), el('div', { class: 'meter' }, el('div', { style: `width:${Math.round(S.aiLoading.progress * 100)}%` })));
  box.append(el('p', { class: ai.ready ? 'chip ok' : 'chip', text: ai.ready ? `loaded: ${ai.modelId}` : 'no model loaded' }));
  box.append(el('h4', { text: 'What bounds it' }));
  box.append(el('ul', { class: 'plain dim' },
    el('li', { text: 'It sees the position and a closed list: the legal moves, a few commands, and "none". Decoding is constrained to that list, and the reply is checked again anyway.' }),
    el('li', { text: 'A move it picks is looked up in the rules engine once more before you see it.' }),
    el('li', { text: `At most ${MAX_ATTEMPTS} attempts, 40 tokens each, temperature 0.` }),
    el('li', { text: 'It proposes; you confirm. It never plays, chats, resigns or offers anything by itself.' }),
    el('li', { text: 'It is never asked which move is good and never shown an evaluation, so it is not a hint machine in a live game.' }),
    el('li', { text: `The weights come from ${MODEL_HOSTS.join(' and ')}, once, when you press Load. After that nothing is sent.` }),
  ));
  box.append(el('h4', { text: 'Last request' }), el('div', { id: 'aiTrace', class: 'mono dim', text: S.aiTraceText || '—' }));
}
function renderAiTrace(text, a) {
  S.aiTraceText = `"${text}"\n` + a.trace.map((t) => `attempt ${t.attempt}: ${t.reply || '(none)'} → ${t.verdict}`).join('\n') + `\nresult: ${a.kind}${a.move ? ' ' + a.move.san : ''}${a.command ? ' /' + a.command : ''}`;
  const n = $('#aiTrace'); if (n) n.textContent = S.aiTraceText;
}
function updateTitle() {
  const g = S.st?.game;
  let t = 'chess-webCLI';
  if (g) t = `${S.unread ? `(${S.unread}) ` : ''}${S.st.result ? S.st.result.result : (mySeat() && g.turn === mySeat() && S.mode === 'room' ? '● Your move' : colorName(g.turn) + ' to move')} · chess-webCLI`;
  document.title = t;
}

// ---------------------------------------------------------------------------- board interaction (click and drag)
let drag = null;
boardEl.addEventListener('pointerdown', (e) => {
  const sq = e.target.closest('.sq');
  if (!sq || e.button > 0) return;
  const name = sq.dataset.sq;
  const g = boardGame();
  const p = g.get(name);
  if (S.sel && S.sel !== name && g.moves({ square: S.sel }).some((m) => m.to === name)) { tryMove(S.sel, name); return; }
  if (p && canMoveNow() && (p === p.toUpperCase() ? 'w' : 'b') === g.turn) {
    S.sel = name; S.hint = null; renderBoard();
    sound('pickup');
    const pc = boardEl.querySelector(`[data-sq="${name}"] .pc`);
    if (pc) {
      // measure the fresh square: renderBoard() above replaced the one the event landed on
      const size = pc.closest('.sq').getBoundingClientRect().height;
      drag = { from: name, legal: new Set(g.moves({ square: name }).map((m) => m.to)), overEl: null, ghost: el('span', { id: 'drag', class: pc.className, text: pc.textContent, style: `font-size:${size * 0.82}px;left:${e.clientX}px;top:${e.clientY}px` }), moved: false, x: e.clientX, y: e.clientY };
      boardEl.setPointerCapture(e.pointerId);
    }
  } else if (S.sel) { S.sel = null; renderBoard(); }
  else if (p && !canMoveNow()) log(whyCannotMove(), 'dim');
});
boardEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) {
    drag.moved = true; document.body.append(drag.ghost);
    boardEl.classList.add('dragging');
    boardEl.querySelector(`[data-sq="${drag.from}"] .pc`)?.classList.add('ghost');
  }
  if (drag.moved) {
    drag.ghost.style.left = e.clientX + 'px'; drag.ghost.style.top = e.clientY + 'px';
    // outline the square under the pointer: bright when the drop is legal, faint when it is not
    const t = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.sq');
    if (t !== drag.overEl) {
      drag.overEl?.classList.remove('over', 'illegal');
      drag.overEl = t && t.dataset.sq !== drag.from ? t : null;
      if (drag.overEl) { drag.overEl.classList.add('over'); if (!drag.legal.has(drag.overEl.dataset.sq)) drag.overEl.classList.add('illegal'); }
    }
  }
});
const endDrag = (e) => {
  if (!drag) return;
  const d = drag; drag = null;
  d.ghost.remove();
  d.overEl?.classList.remove('over', 'illegal');
  boardEl.classList.remove('dragging');
  if (!d.moved) return;
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.sq');
  if (target && target.dataset.sq !== d.from) tryMove(d.from, target.dataset.sq);
  else renderBoard();
};
boardEl.addEventListener('pointerup', endDrag);
boardEl.addEventListener('pointercancel', () => { if (drag) { drag.ghost.remove(); drag.overEl?.classList.remove('over', 'illegal'); boardEl.classList.remove('dragging'); drag = null; renderBoard(); } });

async function tryMove(from, to) {
  S.sel = null;
  const g = boardGame();
  const cands = g.moves({ square: from }).filter((m) => m.to === to);
  if (!cands.length) { sound('illegal'); renderBoard(); return; }
  let m = cands[0];
  if (cands.length > 1) { const promo = await pickPromotion(g.turn); if (!promo) { renderBoard(); return; } m = cands.find((x) => x.promotion.toLowerCase() === promo); }
  await playMove(m);
}

// ---------------------------------------------------------------------------- review
function goReview(where) {
  if (!S.st) return;
  const n = S.st.game.ply();
  let cur = S.review === null ? n : S.review;
  if (where === 'first') cur = 0; else if (where === 'prev') cur = Math.max(0, cur - 1); else if (where === 'next') cur = Math.min(n, cur + 1); else cur = n;
  S.review = cur >= n ? null : cur; S.sel = null; S.proposal = null;
  render();
}
addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || $('#game').classList.contains('hidden') || !$('#overlay').classList.contains('hidden')) return;
  const k = { ArrowLeft: 'prev', ArrowRight: 'next', Home: 'first', End: 'last' }[e.key];
  if (k) { e.preventDefault(); goReview(k); }
  if (e.key === 'f' && !e.ctrlKey && !e.metaKey) runCommand('/flip');
  if (e.key === '/' ) { e.preventDefault(); $('#cmdIn').focus(); }
});

// ---------------------------------------------------------------------------- dialogs
function showScreen({ title, node, actions = [{ label: 'Close' }] }) {
  return new Promise((resolve) => {
    const card = $('#overlayCard');
    card.textContent = '';
    card.append(el('h2', { text: title }));
    if (typeof node === 'string') card.append(el('p', { text: node })); else if (node) card.append(node);
    const row = el('div', { class: 'actions' });
    for (const a of actions) row.append(el('button', { class: a.cls || '', type: 'button', text: a.label, title: a.title || a.label, onclick: () => { close(); resolve(a.value); } }));
    card.append(row);
    const close = () => { $('#overlay').classList.add('hidden'); removeEventListener('keydown', esc); };
    const esc = (e) => { if (e.key === 'Escape') { close(); resolve(undefined); } };
    addEventListener('keydown', esc);
    $('#overlay').classList.remove('hidden');
    row.querySelector('button.primary, button.danger')?.focus();
  });
}
const confirmBox = (title, text, yes) => showScreen({ title, node: text, actions: [{ label: 'Cancel', value: false }, { label: yes, value: true, cls: /resign|leave/i.test(yes) ? 'danger' : 'primary' }] }).then((v) => !!v);
function pickPromotion(color) {
  const node = el('div', { class: 'promo' });
  const p = showScreen({ title: 'Promote to', node, actions: [{ label: 'Cancel', value: null }] });
  for (const t of ['q', 'r', 'b', 'n']) node.append(el('button', { type: 'button', class: '', title: { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' }[t], onclick: () => { $('#overlay').classList.add('hidden'); res(t); } }, el('span', { class: `pc ${color}`, style: 'font-size:48px', text: glyph(t) })));
  let res;
  return new Promise((r) => { res = r; p.then((v) => r(v ?? null)); });
}
function openLoadDialog() {
  const ta = el('textarea', { rows: '8', placeholder: 'Paste a FEN (one line) or a PGN (headers and moves)' });
  showScreen({ title: 'Load a position or game', node: el('div', {}, el('p', { class: 'dim', text: 'A FEN starts a game from that position (against the engine, if you are playing it). A PGN opens in the analysis board.' }), ta), actions: [{ label: 'Cancel' }, { label: 'Load', cls: 'primary', value: 'go' }] }).then((v) => { if (v === 'go') loadText(ta.value); });
  setTimeout(() => ta.focus(), 50);
}
async function showQr() {
  if (S.mode !== 'room') { log('Not in a room.', 'err'); return; }
  const qrcode = (await loadVerified('qrcode.js')).default;
  const url = inviteUrl();
  const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
  const n = qr.getModuleCount(), scale = 6, quiet = 4;
  const canvas = el('canvas', { id: 'qrCanvas', width: String((n + quiet * 2) * scale), height: String((n + quiet * 2) * scale) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#000';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
  showScreen({ title: 'Invite QR', node: el('div', {}, canvas, el('p', { class: 'dim mono', text: url, style: 'word-break:break-all' }), el('p', { class: 'dim', text: 'Anyone who scans this can join: the first takes the open seat, everyone after watches.' })) });
}
function showFatal(text) { const f = $('#fatal'); f.textContent = text; f.classList.remove('hidden'); log(text, 'err'); }
// Board colours: swatches in a dialog; /board does the same from the console.
function showThemeDialog() {
  const grid = el('div', { class: 'themes' });
  const make = (k, t) => el('button', { type: 'button', class: 'theme' + ((settings.board || 'slate') === k ? ' cur' : ''), title: `Use the ${t.label} board colours`, onclick: () => { applyBoardTheme(k); for (const b of grid.children) b.classList.toggle('cur', b.dataset.k === k); log(`Board: ${t.label}.`, 'ok'); }, 'data-k': k },
    el('span', { class: 'swatch', 'aria-hidden': 'true' },
      el('i', { style: `background:${t.light}` }), el('i', { style: `background:${t.dark}` }),
      el('i', { style: `background:${t.dark}` }), el('i', { style: `background:${t.light}` })),
    el('span', { text: t.label }));
  for (const [k, t] of Object.entries(BOARD_THEMES)) grid.append(make(k, t));
  showScreen({ title: 'Board colours', node: el('div', {}, grid, el('p', { class: 'dim', style: 'margin:10px 0 0', text: 'Kept until this tab is closed. The console command is /board.' })), actions: [{ label: 'Done', cls: 'primary' }] });
}
// The speaker in the header mirrors /sounds.
function updateMuteBtn() {
  const on = settings.sounds !== false;
  const b = $('#btnMute');
  $('#icoSoundOn').classList.toggle('hidden', !on);
  $('#icoSoundOff').classList.toggle('hidden', on);
  b.setAttribute('aria-pressed', String(!on));
  const t = on ? 'Mute move sounds' : 'Sounds are muted. Press to turn them back on';
  if (b.dataset.tip) b.dataset.tip = t; else b.setAttribute('title', t);
  b.setAttribute('aria-label', t);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch { const ta = el('textarea', {}); ta.value = text; document.body.append(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove(); return false; }
}
function egressReport() {
  const lines = ['Declared, by mode:', '  page and lib/            ' + location.host,
    '  on-device games          nothing else',
    '  rooms: relays            ' + activeRelays().map((u) => u.replace(/^wss?:\/\//, '')).join(', '),
    '  rooms: STUN              ' + (settings.lan ? 'none (LAN only)' : (settings.stun || DEFAULT_STUN).replace(/^stun:/, '')),
    '  rooms: peers             each person in the room, directly (WebRTC data channel)',
    '  model (only on Load)     ' + MODEL_HOSTS.join(', '),
    '  git-backed games         ' + (S.git ? new URL(S.git.api).host + ` (repo ${S.git.repo})` : 'api.github.com, only for a game kept in a repo'),
    '', 'Contacted so far (from the page\'s own records):'];
  const decl = new Set([location.host, ...activeRelays().map((u) => new URL(u).host), ...(S.git ? [new URL(S.git.api).host] : [])]);
  const obs = observedHosts();
  if (!obs.length) lines.push('  nothing yet');
  for (const h of obs) {
    const host = h.split(' ')[1];
    const ok = decl.has(host) || (ai.ready || S.aiLoading) && /(^|\.)huggingface\.co$|(^|\.)hf\.co$|^raw\.githubusercontent\.com$/.test(host);
    lines.push(`  ${ok ? ' ' : '⚠'} ${h}`);
  }
  lines.push('', 'STUN and WebRTC peer traffic do not appear here; chrome://webrtc-internals shows them.');
  log(lines.join('\n'));
}

// ---------------------------------------------------------------------------- sounds (generated, no files)
let actx = null;
function sound(kind) {
  if (settings.sounds === false) return;
  try {
    actx = actx || new AudioContext();
    const now = actx.currentTime;
    // [frequency, start, duration, gain]; the quiet ones are UI feedback, the louder ones are game events
    const tones = {
      move: [[520, 0, 0.05]], capture: [[360, 0, 0.07], [260, 0.05, 0.08]], check: [[700, 0, 0.06], [880, 0.07, 0.08]],
      end: [[523, 0, 0.12], [659, 0.12, 0.12], [784, 0.24, 0.2]], offer: [[660, 0, 0.08], [660, 0.14, 0.08]], chat: [[880, 0, 0.05]],
      pickup: [[600, 0, 0.025, 0.05]], illegal: [[150, 0, 0.08, 0.1], [110, 0.04, 0.1, 0.08]],
    }[kind] || [];
    for (const [f, t, d, g = 0.12] of tones) {
      const o = actx.createOscillator(), gn = actx.createGain();
      o.frequency.value = f; o.type = 'triangle';
      gn.gain.setValueAtTime(0.0001, now + t); gn.gain.exponentialRampToValueAtTime(g, now + t + 0.01); gn.gain.exponentialRampToValueAtTime(0.0001, now + t + d);
      o.connect(gn).connect(actx.destination); o.start(now + t); o.stop(now + t + d + 0.02);
    }
  } catch {}
}

// ---------------------------------------------------------------------------- tooltips (hover, focus, long press)
const tip = $('#tip');
let tipT = null;
const showTip = (t) => {
  const text = t.getAttribute('title') || t.dataset.tip; if (!text) return;
  if (t.getAttribute('title')) { t.dataset.tip = text; t.removeAttribute('title'); }
  tip.textContent = t.dataset.tip;
  const r = t.getBoundingClientRect();
  tip.classList.add('show');
  const tr = tip.getBoundingClientRect();
  tip.style.left = Math.max(6, Math.min(innerWidth - tr.width - 6, r.left + r.width / 2 - tr.width / 2)) + 'px';
  tip.style.top = (r.top - tr.height - 8 < 4 ? r.bottom + 8 : r.top - tr.height - 8) + 'px';
};
const hideTip = (t) => { tip.classList.remove('show'); if (t?.dataset.tip) { t.setAttribute('title', t.dataset.tip); delete t.dataset.tip; } };
document.addEventListener('mouseover', (e) => { const t = e.target.closest('button[title], a[title], select[title], .header-icon'); if (t) { clearTimeout(tipT); tipT = setTimeout(() => showTip(t), 350); t.addEventListener('mouseleave', () => { clearTimeout(tipT); hideTip(t); }, { once: true }); } });
document.addEventListener('focusin', (e) => { const t = e.target.closest('button[title], a[title], select[title]'); if (t && e.target.matches(':focus-visible')) { showTip(t); t.addEventListener('blur', () => hideTip(t), { once: true }); } });

// ---------------------------------------------------------------------------- wiring
$('#btnCreate').onclick = () => createRoom().catch((e) => showFatal(e.message));
$('#btnJoin').onclick = () => joinRoom().catch((e) => showFatal(e.message));
$('#btnEngine').onclick = () => { const c = $('#selLocalColor').value === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : $('#selLocalColor').value; settings.name = $('#name').value.trim().slice(0, 24); saveSettings(); startLocal('engine', { color: c, level: Number($('#selLevel').value) }); };
$('#btnLocal').onclick = () => startLocal('local');
$('#btnAnalysis').onclick = () => startLocal('analysis');
$('#useGit').onchange = () => $('#gitBox').classList.toggle('hidden', !$('#useGit').checked);
$('#selTc').onchange = () => { if ($('#selTc').value.startsWith('d') && !$('#useGit').checked) { $('#useGit').checked = true; $('#gitBox').classList.remove('hidden'); } };
$('#btnSaveSettings').onclick = () => { settings.lan = $('#setLan').checked; settings.stun = $('#setStun').value.trim(); settings.relays = $('#setRelays').value.trim(); saveSettings(); $('#settingsNote').textContent = 'Saved for this tab.'; };
$('#btnFlip').onclick = () => runCommand('/flip');
$('#btnUndo').onclick = () => offerOrAccept('takeback');
$('#btnDraw').onclick = () => offerOrAccept('draw');
$('#btnResign').onclick = () => resign();
$('#btnHint').onclick = () => hint();
$('#btnAgain').onclick = () => (S.mode === 'room' ? offerOrAccept('rematch') : newLocalGame(true));
$('#btnFirst').onclick = () => goReview('first');
$('#btnPrev').onclick = () => goReview('prev');
$('#btnNext').onclick = () => goReview('next');
$('#btnLast').onclick = () => goReview('last');
$('#btnLeave').onclick = () => leave();
$('#btnNew').onclick = () => leave();
$('#brand').onclick = (e) => { if (S.mode) { e.preventDefault(); leave(); } };
$('#btnInvite').onclick = async () => { await copy(inviteUrl()); log('Invite link copied. The first person to open it takes the open seat; anyone after watches.', 'ok'); };
$('#btnQr').onclick = () => showQr();
$('#btnMute').onclick = () => runCommand('/sounds ' + (settings.sounds === false ? 'on' : 'off'));
$('#btnTheme').onclick = () => showThemeDialog();
$('#btnPgn').onclick = async () => { if (S.st) { await copy(pgnOf(S.st)); log('PGN copied.', 'ok'); } };
$('#btnFen').onclick = async () => { await copy(boardGame().fen()); log('FEN copied: ' + boardGame().fen(), 'ok'); };
$('#btnLoad').onclick = () => openLoadDialog();
$('#btnDownload').onclick = () => {
  if (!S.st) return;
  const text = [...S.st.games.map((x) => x.pgn), pgnOf(S.st)].join('\n');
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'application/x-chess-pgn' })), download: `chess-webCLI-${new Date().toISOString().slice(0, 10)}.pgn` });
  document.body.append(a); a.click(); a.remove();
};
const runCmdBar = () => { const v = $('#cmdIn').value; $('#cmdIn').value = ''; if (!v.trim() && S.proposal?.moves.length === 1) return playMove(S.proposal.moves[0]); runInput(v); };
$('#cmdGo').onclick = runCmdBar;
$('#cmdIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') runCmdBar(); if (e.key === 'Escape') { S.proposal = null; renderProposal(); } });
$('#consoleRun').onclick = () => { const v = $('#consoleIn').value; $('#consoleIn').value = ''; runInput(v); };
$('#consoleIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#consoleRun').click(); });
$('#chatSend').onclick = () => { sendChat($('#chatIn').value); $('#chatIn').value = ''; };
$('#chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#chatSend').click(); });
for (const [tab, pane] of [['Moves', 'moves'], ['Chat', 'chat'], ['Console', 'console'], ['Ai', 'ai']]) {
  $('#tab' + tab).onclick = () => {
    S.tab = pane;
    for (const t of ['Moves', 'Chat', 'Console', 'Ai']) { $('#tab' + t).classList.toggle('active', t === tab); $('#pane' + t).classList.toggle('hidden', t !== tab); }
    if (pane === 'chat') { S.unread = 0; renderChat(); }
    if (pane === 'console') $('#consoleIn').focus();
  };
}
for (const [n, l] of Object.entries(LEVELS)) $('#selLevel').append(el('option', { value: n, text: `${n} · ${l.label}` }));
$('#selLevel').value = '3';

function initLanding() {
  $('#fatal').classList.add('hidden');
  $('#name').value = settings.name || '';
  $('#setLan').checked = !!settings.lan; $('#setStun').value = settings.stun || DEFAULT_STUN; $('#setRelays').value = settings.relays || '';
  const inv = parseInvite();
  renderGames();
  if (!isUrlRun()) refreshGames();
  // git options: free to fill when creating; fixed by the link when joining a git-backed game
  const g = inv?.git;
  $('#gitSection').classList.toggle('hidden', !!inv && !g);
  $('#useGit').checked = !!g || $('#useGit').checked;
  $('#useGit').disabled = !!g;
  $('#gitBox').classList.toggle('hidden', !$('#useGit').checked);
  $('#gitRepoRow').classList.toggle('hidden', !!g);
  $('#gitReadableLabel').classList.toggle('hidden', !!g);
  $('#gitJoinNote').classList.toggle('hidden', !g);
  if (g) {
    $('#gitJoinNote').textContent = `This game lives in github.com/${g.repo}. To play, you need a GitHub token with write access to that repo (ask its owner to add you as a collaborator). To follow a public repo you need none.`;
    $('#gitToken').value = tokenFor(g.repo);
  }
  $('#invitedNote').classList.toggle('hidden', !inv);
  $('#btnJoin').classList.toggle('hidden', !inv);
  $('#createOpts').classList.toggle('hidden', !!inv);
  $('#btnCreate').classList.toggle('primary', !inv);
  $('#btnCreate').textContent = inv ? 'Create a new room instead' : 'Create a room';
  $('#offlineNote').classList.toggle('hidden', navigator.onLine);
  if (location.hash && !inv && !new URLSearchParams(location.hash.slice(1)).has('run')) showFatal('This invite link is incomplete or damaged. It should end in #k=…&s=… with 22 characters each.');
}
function isUrlRun() {
  return new URLSearchParams(location.search).has('run') || new URLSearchParams(location.hash.slice(1)).has('run');
}
addEventListener('online', () => $('#offlineNote').classList.add('hidden'));
addEventListener('offline', () => $('#offlineNote').classList.remove('hidden'));
addEventListener('hashchange', () => { if (!S.mode) initLanding(); });
addEventListener('beforeunload', (e) => { if (S.mode === 'room' && mySeat() && live() && bothSeated()) { e.preventDefault(); e.returnValue = ''; } });

// PWA
let installEvent = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; $('#btnInstall').classList.remove('hidden'); });
$('#btnInstall').onclick = async () => { if (!installEvent) return; installEvent.prompt(); await installEvent.userChoice; installEvent = null; $('#btnInstall').classList.add('hidden'); };
if ('serviceWorker' in navigator && window.isSecureContext && !new URLSearchParams(location.search).has('nosw')) {
  navigator.serviceWorker.register(new URL('service-worker.js', location.origin + APP_DIR), { scope: APP_DIR }).catch((e) => console.warn('chess-webCLI: offline support unavailable', e));
}

// Resume after a reload: an open room invite is joined only when the user presses Join; an on-device
// game in this tab is restored at once.
applyBoardTheme(settings.board);
updateMuteBtn();
initLanding();
async function runFromUrl() {
  let params;
  try {
    params = parseRunParams(location.search, location.hash);
    if (!params) return false;
    document.body.dataset.webcliStatus = 'loading';

    let startFen = null;
    let moves = [];
    if (params.pgn !== null) {
      const parsed = Chess.parsePgn(params.pgn);
      if (!parsed.ok) throw new Error(parsed.error || 'Invalid PGN.');
      startFen = parsed.headers.FEN || null;
      moves = parsed.game.history().map((move) => move.uci);
    } else if (params.fen !== null) {
      const error = Chess.validateFen(params.fen);
      if (error) throw new Error(error);
      startFen = params.fen;
    } else {
      throw new Error('run=analyze requires pgn or fen.');
    }

    document.body.dataset.webcliStatus = 'running';
    await startLocal('analysis', { fen: startFen });
    if (!S.st || S.mode !== 'analysis') throw new Error('Could not start the analysis board.');
    for (const uci of moves) {
      if (!(await commit({ t: 'move', by: game().turn, uci }))) throw new Error('Could not replay the supplied PGN.');
    }

    const text = params.format === 'FEN' ? game().fen() : pgnOf(S.st);
    const name = params.format === 'FEN' ? 'position.fen' : 'game.pgn';
    window.__webcli_result = {
      ok: true,
      op: 'analyze',
      artifact: makeTextArtifact(text, name, params.format === 'FEN' ? 'text/plain' : 'application/x-chess-pgn'),
      error: null,
      meta: { tool: 'chess', fen: game().fen(), ply: game().ply(), format: params.format },
    };
    document.body.dataset.webcliStatus = 'done';
    if (params.download) {
      const url = URL.createObjectURL(new Blob([text], { type: params.format === 'FEN' ? 'text/plain' : 'application/x-chess-pgn' }));
      const link = el('a', { href: url, download: name });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return true;
  } catch (error) {
    const message = error.message || String(error);
    window.__webcli_result = { ok: false, op: params?.run || null, artifact: null, error: message, meta: { tool: 'chess' } };
    document.body.dataset.webcliStatus = 'error';
    showFatal(message);
    return true;
  }
}
window.__webcli_result = null;
(async () => {
  if (isUrlRun()) {
    await runFromUrl();
    return;
  }
  const inv = parseInvite();
  if (inv) {
    const { roomId } = await deriveRoom(inv.secret);
    if (sessionStorage.getItem('chess.log.' + roomId)) { log('Rejoining the room you were in before the reload.'); await joinRoom(); }
    return;
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem('chess.local') || 'null');
    if (saved?.log?.length) await startLocal(saved.mode, { color: saved.mode === 'engine' ? other(saved.engineColor) : 'w', level: saved.level || 3, log: saved.log });
  } catch {}
})();

// A handle for tests and for poking from DevTools.
window.chess = { S, runInput, runCommand, playMove, replay: () => replay(S.log, replayOpts()), version: VERSION, ai };
