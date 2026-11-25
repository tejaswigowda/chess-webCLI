// log.js — the game as an append-only, signed event log.
//
// There is no server and no host, so "what is the position?" is answered by replaying a log that every
// peer holds a copy of. Each event is signed by the seat that wrote it (ECDSA P-256, WebCrypto) and
// chained to the previous one by hash. Every peer replays every log it receives through the rules
// engine and checks every signature, so:
//   • nobody can make a move for a seat they do not hold (no key, no valid signature);
//   • nobody can make an illegal move (the replay refuses it);
//   • nobody can take back, agree a draw or start a rematch for the other player (the reply that
//     carries consent must be signed by the player who consents);
//   • two peers holding different logs can tell exactly where they part, and settle it the same way.
//
// Event types and their signer:
//   init   {color, pub, name, tc, fen}  the room creator, who takes `color`. Anchored by the invite link.
//   seat   {color, pub, name}           the creator, seating the first other person in the open colour.
//   claim  {color, pub, name}           the claimant itself, for the open seat, only in a game whose init
//                                       says claim:true (games kept in a git repo, where the creator may be
//                                       offline when the opponent arrives). The first claim in the log wins.
//   move   {by, uci, clk}               the seat to move. clk = mover's own remaining ms (self-reported).
//   offer  {by, kind}                   draw | takeback | rematch
//   reply  {by, kind, accept}           the other seat
//   resign {by}
//   flag   {by, color}                  a seat says `color` ran out of time
//
// Every event also carries i (its index), prev (hash of the previous event, or the room id for i = 0)
// and sig. `by` is a colour in the current game (colours swap on a rematch).
//
// Games that may run for days carry `at` (ms since 1970, the writer's own clock) on every event, and
// may use correspondence time: tc = {days} per move. `at` must never go backwards along the log, and a
// flag for a days-per-move game is valid only if its `at` is past the deadline. Like the live clocks,
// these times are self-reported; the receiving page also refuses an event dated in its future.

import { Chess, START_FEN } from './chess.js';

export const PROTO = 1;
const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;
export const b64u = {
  enc(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { const p = str.replace(/-/g, '+').replace(/_/g, '/'); const bin = atob(p + '='.repeat((4 - (p.length % 4)) % 4)); return Uint8Array.from(bin, (c) => c.charCodeAt(0)); },
};
const sha = async (bytes) => new Uint8Array(await subtle.digest('SHA-256', bytes));

// Stable JSON: keys sorted at every level, so the same event always hashes the same.
export function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}
const unsigned = (ev) => { const { sig, ...rest } = ev; return rest; };
export const eventHash = async (ev) => b64u.enc((await sha(enc.encode(canon(ev)))).slice(0, 18));
export const keyIdOf = async (pubB64) => b64u.enc((await sha(b64u.dec(pubB64))).slice(0, 16));

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

// A seat key lives only in this tab's sessionStorage (see the page), so a reload keeps your seat and
// closing the tab gives it up.
export async function newSeatKey() {
  const kp = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const pub = b64u.enc(raw);
  return { priv: kp.privateKey, pub, keyId: await keyIdOf(pub), jwk: await subtle.exportKey('jwk', kp.privateKey) };
}
export async function importSeatKey(saved) {
  const priv = await subtle.importKey('jwk', saved.jwk, ECDSA, true, ['sign']);
  return { priv, pub: saved.pub, keyId: await keyIdOf(saved.pub), jwk: saved.jwk };
}
const pubCache = new Map();
async function pubKey(pubB64) {
  if (!pubCache.has(pubB64)) pubCache.set(pubB64, subtle.importKey('raw', b64u.dec(pubB64), ECDSA, false, ['verify']));
  return pubCache.get(pubB64);
}
export async function signEvent(key, ev) {
  const sig = new Uint8Array(await subtle.sign(SIGN, key.priv, enc.encode(canon(unsigned(ev)))));
  return { ...ev, sig: b64u.enc(sig) };
}
const verified = new Set();
async function verifyEvent(pubB64, ev) {
  const id = pubB64 + '|' + ev.sig + '|' + canon(unsigned(ev));
  if (verified.has(id)) return true;
  if (typeof ev.sig !== 'string') return false;
  let ok = false;
  try { ok = await subtle.verify(SIGN, await pubKey(pubB64), b64u.dec(ev.sig), enc.encode(canon(unsigned(ev)))); } catch { ok = false; }
  if (ok) verified.add(id);
  return ok;
}

const other = (c) => (c === 'w' ? 'b' : 'w');
const onlyKing = (g, color) => g.board().flat().every((p) => !p || (color === 'w' ? p !== p.toUpperCase() || p === 'K' : p !== p.toLowerCase() || p === 'k'));

// Replay a log. Returns the derived state, or { ok:false, error, at } naming the first bad event.
// opts.room: the room id (prev of event 0). opts.anchor: the creator key id from the invite link.
// opts.trust: skip signature checks (only for the on-device modes, where every event is our own).
export async function replay(events, { room = 'local', anchor = null, trust = false } = {}) {
  const st = {
    ok: true, error: null, at: -1, events,
    tc: null, creator: null, claim: false, timed: false, lastAt: 0, turnStart: null, deadline: null, seats: { w: null, b: null }, game: null, startFen: START_FEN,
    result: null, pending: null, clocks: { w: null, b: null }, clockLog: [], moveIdx: [], gameNo: 1, games: [], tip: room,
  };
  const fail = (i, error) => ({ ...st, ok: false, error, at: i });
  let prev = room;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') return fail(i, 'not an event');
    if (ev.i !== i) return fail(i, 'wrong index');
    if (ev.prev !== prev) return fail(i, 'does not chain to the previous event');
    // who must have signed it
    let signer = null;
    if (ev.t === 'init') {
      if (i !== 0) return fail(i, 'init must be first');
      if (ev.v !== PROTO) return fail(i, `this game uses protocol ${ev.v}; this page speaks ${PROTO}`);
      if (!['w', 'b'].includes(ev.color) || typeof ev.pub !== 'string') return fail(i, 'bad init');
      if (anchor && (await keyIdOf(ev.pub)) !== anchor) return fail(i, 'the creator key does not match the invite link');
      signer = ev.pub;
    } else {
      if (i === 0) return fail(i, 'the first event must be init');
      if (ev.t === 'seat') signer = st.creator.pub;
      else if (ev.t === 'claim') signer = typeof ev.pub === 'string' ? ev.pub : null;
      else {
        if (!['w', 'b'].includes(ev.by) || !st.seats[ev.by]) return fail(i, 'signed by an empty seat');
        signer = st.seats[ev.by].pub;
      }
    }
    if (!signer) return fail(i, 'no signer');
    if (!trust && !(await verifyEvent(signer, ev))) return fail(i, 'bad signature');
    if (st.timed && i > 0) {
      if (!Number.isFinite(ev.at)) return fail(i, 'missing time');
      if (ev.at < st.lastAt) return fail(i, 'dated before the event it follows');
      st.lastAt = ev.at;
    }

    const g = st.game;
    switch (ev.t) {
      case 'init': {
        const fen = ev.fen || START_FEN;
        if (Chess.validateFen(fen)) return fail(i, 'bad starting position');
        st.startFen = fen;
        st.game = new Chess(fen);
        if (ev.tc && Number.isFinite(ev.tc.days)) {
          if (ev.tc.days < 1 || ev.tc.days > 30) return fail(i, 'days per move must be 1 to 30');
          st.tc = { days: Math.round(ev.tc.days) };
        } else st.tc = ev.tc && Number.isFinite(ev.tc.base) && ev.tc.base > 0 ? { base: Math.min(ev.tc.base, 3 * 3600e3), inc: Math.max(0, Math.min(ev.tc.inc || 0, 180e3)) } : null;
        st.claim = ev.claim === true;
        st.timed = Number.isFinite(ev.at);
        if (st.timed) st.lastAt = ev.at;
        else if (st.tc?.days) return fail(i, 'a days-per-move game needs times on its events');
        st.creator = { pub: ev.pub, keyId: await keyIdOf(ev.pub), name: String(ev.name || '').slice(0, 24) };
        st.seats[ev.color] = { pub: ev.pub, keyId: st.creator.keyId, name: st.creator.name, creator: true };
        if (st.tc?.base) st.clocks = { w: st.tc.base, b: st.tc.base };
        break;
      }
      case 'claim':
        if (!st.claim) return fail(i, 'seats in this game are given by the creator, not claimed');
        // falls through
      case 'seat': {
        if (!['w', 'b'].includes(ev.color) || st.seats[ev.color]) return fail(i, 'that seat is not open');
        if (typeof ev.pub !== 'string' || ev.pub === st.creator.pub) return fail(i, 'bad seat key');
        st.seats[ev.color] = { pub: ev.pub, keyId: await keyIdOf(ev.pub), name: String(ev.name || '').slice(0, 24), claimed: ev.t === 'claim' };
        if (st.seats.w && st.seats.b) startTurn(ev);
        break;
      }
      case 'move': {
        if (st.result) return fail(i, 'the game is over');
        if (!st.seats.w || !st.seats.b) return fail(i, 'both seats must be taken first');
        if (ev.by !== g.turn) return fail(i, 'not that side\'s turn');
        const m = g.move(String(ev.uci || ''));
        if (!m) return fail(i, `illegal move ${String(ev.uci).slice(0, 8)}`);
        st.moveIdx.push(i);
        startTurn(ev);
        if (st.tc?.base) {
          const cap = (st.clocks[ev.by] ?? st.tc.base) + st.tc.inc;
          const clk = Number.isFinite(ev.clk) ? Math.max(0, Math.min(ev.clk, cap)) : st.clocks[ev.by];
          st.clocks[ev.by] = clk;
        }
        st.clockLog.push({ ...st.clocks });
        if (st.pending && !(st.pending.kind === 'draw' && st.pending.by === ev.by)) st.pending = null;
        const s = g.status();
        if (s.over) st.result = { result: s.result, reason: s.reason };
        break;
      }
      case 'offer': {
        if (!['draw', 'takeback', 'rematch'].includes(ev.kind)) return fail(i, 'unknown offer');
        if (ev.kind === 'rematch' ? !st.result : !!st.result) return fail(i, ev.kind === 'rematch' ? 'a rematch is offered after the game' : 'the game is over');
        if (ev.kind === 'takeback') {
          const mine = g.history().filter((m) => m.color === ev.by).length;
          if (!mine) return fail(i, 'nothing of yours to take back');
        }
        st.pending = { kind: ev.kind, by: ev.by, ply: g.ply(), at: i };
        break;
      }
      case 'reply': {
        const p = st.pending;
        if (!p || p.kind !== ev.kind || p.by === ev.by) return fail(i, 'nothing to reply to');
        st.pending = null;
        if (!ev.accept) break;
        if (p.kind === 'draw') st.result = { result: '1/2-1/2', reason: 'agreement' };
        if (p.kind === 'takeback') {
          const n = g.turn === p.by ? 2 : 1; // undo back to before the requester's last move
          for (let k = 0; k < n; k++) { g.undo(); st.moveIdx.pop(); st.clockLog.pop(); }
          if (st.tc?.base) st.clocks = st.clockLog.length ? { ...st.clockLog[st.clockLog.length - 1] } : { w: st.tc.base, b: st.tc.base };
          startTurn(ev);
        }
        if (p.kind === 'rematch') {
          st.games.push({ pgn: pgnOf(st), result: st.result });
          st.seats = { w: st.seats.b, b: st.seats.w };
          st.game = new Chess(START_FEN); st.startFen = START_FEN;
          st.result = null; st.moveIdx = []; st.clockLog = []; st.gameNo++;
          if (st.tc?.base) st.clocks = { w: st.tc.base, b: st.tc.base };
          startTurn(ev);
        }
        break;
      }
      case 'resign': {
        if (st.result) return fail(i, 'the game is over');
        st.result = { result: ev.by === 'w' ? '0-1' : '1-0', reason: `${ev.by === 'w' ? 'White' : 'Black'} resigned` };
        st.pending = null;
        break;
      }
      case 'flag': {
        if (st.result || !st.tc) return fail(i, 'no clock is running');
        if (!['w', 'b'].includes(ev.color)) return fail(i, 'bad flag');
        if (st.tc.days) {
          if (ev.color !== g.turn) return fail(i, 'only the side to move can run out of time');
          if (!(st.deadline && ev.at >= st.deadline)) return fail(i, 'the deadline has not passed');
        }
        const winner = other(ev.color);
        st.clocks[ev.color] = 0;
        st.result = onlyKing(g, winner)
          ? { result: '1/2-1/2', reason: `${ev.color === 'w' ? 'White' : 'Black'} ran out of time, but the other side cannot mate` }
          : { result: winner === 'w' ? '1-0' : '0-1', reason: `${ev.color === 'w' ? 'White' : 'Black'} ran out of time` };
        st.pending = null;
        break;
      }
      default: return fail(i, `unknown event type ${String(ev.t).slice(0, 12)}`);
    }
    if (st.result) st.deadline = null;
    prev = await eventHash(ev);
  }
  st.tip = prev;
  return st;

  // days-per-move: the side to move's time starts at this event
  function startTurn(ev) {
    if (!st.timed) return;
    st.turnStart = ev.at;
    st.deadline = st.tc?.days && st.seats.w && st.seats.b ? ev.at + st.tc.days * 864e5 : null;
  }
}

export function pgnOf(st) {
  const w = st.seats.w?.name || 'White', b = st.seats.b?.name || 'Black';
  const headers = { Event: `chess-webCLI game ${st.gameNo}`, White: w, Black: b };
  if (st.tc?.days) headers.TimeControl = `1/${st.tc.days * 86400}`;
  else if (st.tc) headers.TimeControl = `${Math.round(st.tc.base / 1000)}+${Math.round(st.tc.inc / 1000)}`;
  if (st.result) headers.Termination = st.result.reason;
  return st.game.pgn(headers, st.result ? st.result.result : '*');
}

// Build the next event (unsigned) on top of a replayed state.
export const nextEvent = (st, body) => ({ ...body, i: st.events.length, prev: st.tip });

// Settle two valid logs of the same room. Returns 'ours' | 'theirs' and why.
export async function choose(ours, theirs) {
  const n = Math.min(ours.length, theirs.length);
  let k = 0;
  for (; k < n; k++) if ((await eventHash(ours[k])) !== (await eventHash(theirs[k]))) break;
  if (k === n) return theirs.length > ours.length ? { pick: 'theirs', why: 'ahead', k } : { pick: 'ours', why: theirs.length === ours.length ? 'same' : 'behind', k };
  // A real fork: two events were written at once (say, a resignation and a move). Every peer keeps the
  // branch whose first differing event has the lower hash, so all of them end up on the same one.
  const a = await eventHash(ours[k]), b = await eventHash(theirs[k]);
  return { pick: b < a ? 'theirs' : 'ours', why: 'fork', k };
}
