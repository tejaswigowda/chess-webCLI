// engine.js — the deterministic local opponent and hint engine.
//
// Alpha-beta with iterative deepening, quiescence on captures, MVV-LVA move ordering and piece-square
// tables. No neural network, no opening book, no download. It is bounded three ways (depth, node count
// and wall-clock time), and every answer reports which bound stopped it, so "it thought for 2 s and
// searched 180,000 positions to depth 4" is something you can see, not a claim.
//
// The same position, level and seed always give the same move (the "noise" on low levels comes from
// a seeded generator, not Math.random), so a game against it can be replayed exactly.

import { Chess } from './chess.js';

export const LEVELS = {
  1: { depth: 1, ms: 300, nodes: 20000, noise: 220, label: 'Beginner' },
  2: { depth: 2, ms: 500, nodes: 60000, noise: 120, label: 'Casual' },
  3: { depth: 3, ms: 1000, nodes: 200000, noise: 40, label: 'Club' },
  4: { depth: 4, ms: 2000, nodes: 600000, noise: 0, label: 'Strong club' },
  5: { depth: 6, ms: 4000, nodes: 2000000, noise: 0, label: 'Strongest (slow)' },
};

const VAL = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };
// Piece-square tables from White's point of view, a8 first (the "simplified evaluation function").
const PST = {
  p: [0,0,0,0,0,0,0,0, 50,50,50,50,50,50,50,50, 10,10,20,30,30,20,10,10, 5,5,10,25,25,10,5,5, 0,0,0,20,20,0,0,0, 5,-5,-10,0,0,-10,-5,5, 5,10,10,-20,-20,10,10,5, 0,0,0,0,0,0,0,0],
  n: [-50,-40,-30,-30,-30,-30,-40,-50, -40,-20,0,0,0,0,-20,-40, -30,0,10,15,15,10,0,-30, -30,5,15,20,20,15,5,-30, -30,0,15,20,20,15,0,-30, -30,5,10,15,15,10,5,-30, -40,-20,0,5,5,0,-20,-40, -50,-40,-30,-30,-30,-30,-40,-50],
  b: [-20,-10,-10,-10,-10,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,10,10,5,0,-10, -10,5,5,10,10,5,5,-10, -10,0,10,10,10,10,0,-10, -10,10,10,10,10,10,10,-10, -10,5,0,0,0,0,5,-10, -20,-10,-10,-10,-10,-10,-10,-20],
  r: [0,0,0,0,0,0,0,0, 5,10,10,10,10,10,10,5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, -5,0,0,0,0,0,0,-5, 0,0,0,5,5,0,0,0],
  q: [-20,-10,-10,-5,-5,-10,-10,-20, -10,0,0,0,0,0,0,-10, -10,0,5,5,5,5,0,-10, -5,0,5,5,5,5,0,-5, 0,0,5,5,5,5,0,-5, -10,5,5,5,5,5,0,-10, -10,0,5,0,0,0,0,-10, -20,-10,-10,-5,-5,-10,-10,-20],
  k: [-30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -30,-40,-40,-50,-50,-40,-40,-30, -20,-30,-30,-40,-40,-30,-30,-20, -10,-20,-20,-20,-20,-20,-20,-10, 20,20,0,0,0,0,20,20, 20,30,10,0,0,10,30,20],
  ke: [-50,-40,-30,-20,-20,-30,-40,-50, -30,-20,-10,0,0,-10,-20,-30, -30,-10,20,30,30,20,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,30,40,40,30,-10,-30, -30,-10,20,30,30,20,-10,-30, -30,-30,0,0,0,0,-30,-30, -50,-30,-30,-30,-30,-30,-30,-50],
};
const MATE = 100000;

// Static evaluation, centipawns, from the side to move's point of view.
export function evaluate(g) {
  let mg = 0, nonPawn = 0;
  const b = g.b;
  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (p && p.toLowerCase() !== 'k' && p.toLowerCase() !== 'p') nonPawn += VAL[p.toLowerCase()];
  }
  const endgame = nonPawn <= 2600;
  for (let sq = 0; sq < 120; sq++) {
    if (sq & 0x88) { sq += 7; continue; }
    const p = b[sq];
    if (!p) continue;
    const t = p.toLowerCase();
    const white = p !== t;
    const idx = (sq >> 4) * 8 + (sq & 7);
    const pidx = white ? idx : (7 - (sq >> 4)) * 8 + (sq & 7);
    const table = t === 'k' && endgame ? PST.ke : PST[t];
    const v = VAL[t] + table[pidx];
    mg += white ? v : -v;
  }
  return g.turn === 'w' ? mg : -mg;
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const order = (moves, pvKey) => {
  const score = (m) => {
    let s = 0;
    if (pvKey && m.from === pvKey.from && m.to === pvKey.to && m.promotion === pvKey.promotion) s += 1e6;
    if (m.captured) s += 10 * VAL[m.captured.toLowerCase()] - VAL[m.piece.toLowerCase()] + 1000;
    if (m.promotion) s += VAL[m.promotion.toLowerCase()];
    return s;
  };
  return moves.map((m) => [score(m), m]).sort((a, b) => b[0] - a[0]).map((x) => x[1]);
};

// search(fen, { level, seed, history }) -> { uci, san, score, depth, nodes, ms, stoppedBy, pv }
// `history` is a list of earlier position keys, so the engine does not walk into a repetition it could avoid.
export function search(fen, opts = {}) {
  const L = { ...LEVELS[opts.level || 3], ...(opts.limits || {}) };
  const g = new Chess(fen);
  const t0 = Date.now();
  let nodes = 0, stopped = null;
  const out = () => stopped || (nodes >= L.nodes ? (stopped = 'nodes') : Date.now() - t0 >= L.ms ? (stopped = 'time') : null);

  const qsearch = (alpha, beta, ply) => {
    nodes++;
    if ((nodes & 1023) === 0 && out()) return 0;
    const stand = evaluate(g);
    if (stand >= beta) return beta;
    if (stand > alpha) alpha = stand;
    if (ply > 8) return alpha;
    const caps = order(g._legal().filter((m) => m.captured || m.promotion));
    for (const m of caps) {
      g._make(m);
      const s = -qsearch(-beta, -alpha, ply + 1);
      g._unmake();
      if (stopped) return 0;
      if (s >= beta) return beta;
      if (s > alpha) alpha = s;
    }
    return alpha;
  };

  const negamax = (depth, alpha, beta, ply) => {
    nodes++;
    if ((nodes & 1023) === 0 && out()) return 0;
    if (g.half >= 100) return 0;
    const moves = g._legal();
    if (!moves.length) return g.inCheck() ? -MATE + ply : 0;
    if (depth <= 0) return qsearch(alpha, beta, 0);
    let best = -Infinity;
    for (const m of order(moves)) {
      g._make(m);
      const s = -negamax(depth - 1 + (g.inCheck() && ply < 6 ? 1 : 0), -beta, -alpha, ply + 1);
      g._unmake();
      if (stopped) return 0;
      if (s > best) best = s;
      if (s > alpha) alpha = s;
      if (alpha >= beta) break;
    }
    return best;
  };

  const rootMoves = g._legal();
  if (!rootMoves.length) return { uci: null, san: null, score: g.inCheck() ? -MATE : 0, depth: 0, nodes: 0, ms: 0, stoppedBy: 'no legal moves' };
  const rng = mulberry32(hashStr(fen + '|' + (opts.seed ?? 0)));
  const avoid = new Set(opts.history || []);
  let best = null, bestScore = -Infinity, reached = 0, scores = [];
  for (let d = 1; d <= L.depth; d++) {
    let alpha = -Infinity;
    const iter = [];
    for (const m of order(rootMoves, best)) {
      g._make(m);
      // Levels with noise need exact scores for every root move, so they search each with a full window.
      let s = -negamax(d - 1, -Infinity, L.noise ? Infinity : -alpha, 1);
      // avoid repeating a position when we are better, accept it when worse
      if (avoid.has(g._repKey()) && s > 0) s = Math.min(s, 0) - 1;
      g._unmake();
      if (stopped) break;
      iter.push([s, m]);
      if (s > alpha) alpha = s;
    }
    if (stopped) break; // an unfinished iteration is discarded; the last complete one stands
    iter.sort((a, b) => b[0] - a[0]);
    scores = iter;
    best = iter[0][1]; bestScore = iter[0][0]; reached = d;
    if (Math.abs(bestScore) > MATE - 100) break; // forced mate found
  }
  // Weaker levels: pick among moves within `noise` centipawns of the best, deterministically.
  if (L.noise && scores.length > 1 && Math.abs(bestScore) < MATE - 100) {
    const pool = scores.filter(([s]) => s >= bestScore - L.noise);
    const pick = pool[Math.floor(rng() * pool.length)];
    best = pick[1]; bestScore = pick[0];
  }
  const dec = g._decorate(best, rootMoves);
  return {
    uci: dec.uci, san: dec.san, score: bestScore, depth: reached, nodes, ms: Date.now() - t0,
    stoppedBy: stopped || (reached >= L.depth ? 'depth' : 'mate found'),
    mateIn: Math.abs(bestScore) > MATE - 100 ? Math.sign(bestScore) * Math.ceil((MATE - Math.abs(bestScore)) / 2) : null,
  };
}

export const formatScore = (r, turn) => {
  if (r.mateIn) return `mate in ${Math.abs(r.mateIn)} for ${(r.mateIn > 0) === (turn === 'w') ? 'White' : 'Black'}`;
  const white = turn === 'w' ? r.score : -r.score;
  return `${white >= 0 ? '+' : ''}${(white / 100).toFixed(2)} (White's view)`;
};
