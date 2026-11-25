// intent.js — the deterministic front door for typed or spoken instructions.
//
// Turns "knight to f3", "take the pawn", "castle short", "e2e4", "Nf3" or "resign" into one legal move,
// a short list of legal candidates, or one command. No model is involved: this is a closed grammar over
// the rules engine's legal-move list, so anything it returns is legal by construction.
//
// The optional on-device model (ai.js) is consulted only for what this parser returns as "unknown" or
// "ambiguous", and even then it may only pick from the same legal-move list and the same command list.

import { sqIndex } from './chess.js';

const PIECE_WORDS = {
  pawn: 'p', pawns: 'p', pon: 'p', peon: 'p',
  knight: 'n', knights: 'n', night: 'n', horse: 'n', horsey: 'n', nite: 'n',
  bishop: 'b', bishops: 'b',
  rook: 'r', rooks: 'r', tower: 'r',
  queen: 'q', queens: 'q', lady: 'q',
  king: 'k', kings: 'k',
};

// Commands the console and the model share. Each pattern is checked against the whole lower-cased phrase.
export const COMMANDS = [
  { command: 'resign', re: /^(i\s+)?(resign|give up|i quit|forfeit)(\s+the game)?$/ },
  { command: 'draw', re: /^((offer|propose)\s+(a\s+)?draw|draw\??|(i\s+)?accept(\s+the)?\s+draw|let'?s draw)$/ },
  { command: 'takeback', re: /^(take\s*back|undo|(request|ask for)\s+(a\s+)?take\s*back|undo (my|that|the last) move)$/ },
  { command: 'flip', re: /^(flip|rotate|turn)(\s+the)?(\s+board)?$/ },
  { command: 'hint', re: /^(hint|give me a hint|what should i (play|do)|best move\??|suggest(\s+a\s+move)?)$/ },
  { command: 'new', re: /^(new game|start (a\s+)?new game|restart)$/ },
  { command: 'rematch', re: /^(rematch|play again)$/ },
  { command: 'describe', re: /^(describe|read)(\s+the)?(\s+(board|position))?|where are (the|my) pieces\??$/ },
  { command: 'pgn', re: /^(show|copy|export)\s+(the\s+)?pgn$/ },
  { command: 'fen', re: /^(show|copy|export)\s+(the\s+)?fen$/ },
];

const SQUARE_RE = /\b([a-h])\s?([1-8])\b/g;

function words(text) { return text.toLowerCase().replace(/[^a-z0-9=\s-]/g, ' ').split(/\s+/).filter(Boolean); }

// Returns:
//   { kind: 'move', move }                one legal move
//   { kind: 'ambiguous', candidates }     several legal moves fit
//   { kind: 'none', why }                 the phrase is understood, but no legal move fits it
//   { kind: 'command', command }          one of COMMANDS
//   { kind: 'unknown' }                   nothing here the grammar understands (the model may try)
export function parseIntent(text, game) {
  const raw = String(text || '').trim();
  if (!raw) return { kind: 'unknown' };
  const low = raw.toLowerCase().replace(/[.!]+$/, '').trim();

  for (const c of COMMANDS) if (c.re.test(low)) return { kind: 'command', command: c.command };

  // 1. Exact notation: SAN or UCI, as typed.
  const direct = game.find(raw);
  if (direct) return { kind: 'move', move: direct };

  const legal = game.moves();
  const w = words(low);
  const has = (...xs) => xs.some((x) => w.includes(x));

  // 2. Castling
  if (has('castle', 'castles', 'castling', 'o-o', 'o-o-o', '0-0', '0-0-0')) {
    const k = legal.find((m) => m.flags.includes('castle-kingside'));
    const q = legal.find((m) => m.flags.includes('castle-queenside'));
    const wantK = has('kingside', 'king-side', 'short', 'o-o', '0-0') || /king\s*side/.test(low);
    const wantQ = has('queenside', 'queen-side', 'long', 'o-o-o', '0-0-0') || /queen\s*side/.test(low);
    if (wantK && !wantQ) return k ? { kind: 'move', move: k } : { kind: 'none', why: 'Castling kingside is not legal here.' };
    if (wantQ && !wantK) return q ? { kind: 'move', move: q } : { kind: 'none', why: 'Castling queenside is not legal here.' };
    const both = [k, q].filter(Boolean);
    if (both.length === 1) return { kind: 'move', move: both[0] };
    if (both.length === 2) return { kind: 'ambiguous', candidates: both };
    return { kind: 'none', why: 'Castling is not legal here.' };
  }

  // 3. Natural language over the legal list. Collect constraints, then filter.
  const squares = [...low.matchAll(SQUARE_RE)].map((m) => m[1] + m[2]);
  const capture = has('take', 'takes', 'taking', 'capture', 'captures', 'capturing', 'x', 'eat', 'eats', 'grab', 'kill');
  // Pieces in order of mention, with the word index, so "knight takes bishop" means mover=knight, victim=bishop.
  const mentions = [];
  w.forEach((t, i) => { if (PIECE_WORDS[t]) mentions.push({ type: PIECE_WORDS[t], i }); });
  const capIdx = w.findIndex((t) => ['take', 'takes', 'taking', 'capture', 'captures', 'capturing', 'x', 'eat', 'eats', 'grab', 'kill'].includes(t));
  let mover = null, victim = null;
  if (mentions.length) {
    if (capIdx >= 0) {
      const before = mentions.filter((m) => m.i < capIdx);
      const after = mentions.filter((m) => m.i > capIdx);
      mover = before.length ? before[before.length - 1].type : null;
      victim = after.length ? after[0].type : null;
    } else mover = mentions[0].type;
  }
  // "kingside knight" / "queen's rook" = the piece on that half of the board
  let half = null;
  const qual = w.findIndex((t) => /^(kingside|king-side|queenside|queen-side|king's|queen's|kings|queens)$/.test(t));
  if (qual >= 0 && w[qual + 1] && PIECE_WORDS[w[qual + 1]] && PIECE_WORDS[w[qual + 1]] !== 'k' && PIECE_WORDS[w[qual + 1]] !== 'q') {
    half = /^king/.test(w[qual]) ? 'k' : 'q';
    mover = PIECE_WORDS[w[qual + 1]];
  } else if (/king\s+side\s+(\w+)/.test(low) || /queen\s+side\s+(\w+)/.test(low)) {
    const m = /(king|queen)\s+side\s+(\w+)/.exec(low);
    if (PIECE_WORDS[m[2]]) { half = m[1][0]; mover = PIECE_WORDS[m[2]]; }
  }
  // promotion
  let promo = null;
  const pi = w.findIndex((t) => /^(promote|promotes|promoting|promotion|queening|queen)$/.test(t));
  if (/=([qrbn])\b/.test(low)) promo = /=([qrbn])/.exec(low)[1];
  else if (pi >= 0 && /^promot/.test(w[pi])) {
    const nxt = w.slice(pi + 1).find((t) => PIECE_WORDS[t]);
    promo = nxt ? PIECE_WORDS[nxt] : 'q';
    if (mover === promo && mentions.length === 1) mover = 'p';
  }
  // squares: "from e2 to e4", "e2 e4", "to e4", "on d5"
  let from = null, to = null;
  if (squares.length >= 2) { from = squares[0]; to = squares[1]; }
  else if (squares.length === 1) {
    const sqPos = w.findIndex((t, i) => (t + (w[i + 1] || '')).replace(/\s/g, '').startsWith(squares[0]) || t === squares[0]);
    if (w[sqPos - 1] === 'from') from = squares[0]; else to = squares[0];
  }

  const anyConstraint = mover || victim || capture || from || to || promo || half;
  if (!anyConstraint) return { kind: 'unknown' };

  let c = legal;
  if (mover) c = c.filter((m) => m.piece.toLowerCase() === mover);
  if (half) c = c.filter((m) => (half === 'k' ? (sqIndex(m.from) & 7) >= 4 : (sqIndex(m.from) & 7) <= 3));
  if (capture || victim) c = c.filter((m) => m.captured);
  if (victim) c = c.filter((m) => m.captured && m.captured.toLowerCase() === victim);
  if (from) c = c.filter((m) => m.from === from);
  if (to) c = c.filter((m) => m.to === to);
  if (promo) c = c.filter((m) => m.promotion && m.promotion.toLowerCase() === promo);
  // A bare promotion with no piece named defaults to a queen, as on a real board.
  if (!promo && c.length > 1 && c.every((m) => m.promotion) && new Set(c.map((m) => m.from + m.to)).size === 1) c = c.filter((m) => m.promotion.toLowerCase() === 'q');
  if ("out develop".split(' ').some((t) => w.includes(t)) && !to) {
    // "move my knight out" / "develop the bishop": off the back rank
    const back = game.turn === 'w' ? '1' : '8';
    c = c.filter((m) => m.from[1] === back && m.to[1] !== back);
  }

  if (c.length === 1) return { kind: 'move', move: c[0] };
  if (c.length > 1) return { kind: 'ambiguous', candidates: c };
  return { kind: 'none', why: 'No legal move matches that.' };
}

// Plain-language description of a move, for confirmations and screen readers.
const NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
export function describeMove(m) {
  if (!m) return '';
  if (m.flags.includes('castle-kingside')) return 'castle kingside';
  if (m.flags.includes('castle-queenside')) return 'castle queenside';
  let s = `${NAMES[m.piece.toLowerCase()]} ${m.from} to ${m.to}`;
  if (m.captured) s += `, taking the ${NAMES[m.captured.toLowerCase()]}${m.flags.includes('en-passant') ? ' en passant' : ''}`;
  if (m.promotion) s += `, promoting to a ${NAMES[m.promotion.toLowerCase()]}`;
  if (m.san.endsWith('#')) s += ', checkmate';
  else if (m.san.endsWith('+')) s += ', check';
  return s;
}

export function describePosition(game) {
  const out = { w: [], b: [] };
  const order = 'kqrbnp';
  const b = game.board();
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    const p = b[r][f];
    if (p) out[p === p.toUpperCase() ? 'w' : 'b'].push({ t: p.toLowerCase(), sq: 'abcdefgh'[f] + (8 - r) });
  }
  const line = (side) => order.split('').map((t) => {
    const xs = out[side].filter((x) => x.t === t).map((x) => x.sq);
    return xs.length ? `${NAMES[t]}${xs.length > 1 ? 's' : ''} ${xs.join(', ')}` : null;
  }).filter(Boolean).join('; ');
  const st = game.status();
  return `White: ${line('w')}.\nBlack: ${line('b')}.\n${game.turn === 'w' ? 'White' : 'Black'} to move${game.inCheck() ? ', in check' : ''}.${st.over ? ' Game over: ' + st.reason + ' (' + st.result + ').' : ''}`;
}
