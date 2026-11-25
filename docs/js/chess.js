// chess.js — the deterministic rules engine for chess-webCLI.
//
// Pure ES module, no dependencies, no I/O. Every peer runs this same file and replays every move it
// receives, so a move that this engine calls illegal is never applied, whoever sent it.
//
// Board: 0x88, a8 = 0, h1 = 119. Pieces are one-character strings, uppercase for White.
// Covers: legal move generation (pins, checks, castling through/out of check, en passant including
// the discovered-check case, promotion), SAN in and out, UCI in and out, FEN in and out, PGN in and
// out, checkmate, stalemate, fifty-move, threefold repetition and insufficient material.

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const F = { NORMAL: 0, CAPTURE: 1, BIG_PAWN: 2, EP: 4, PROMO: 8, KCASTLE: 16, QCASTLE: 32 };
const CASTLE = { K: 1, Q: 2, k: 4, q: 8 };
const ROOK_HOME = { 119: CASTLE.K, 112: CASTLE.Q, 7: CASTLE.k, 0: CASTLE.q };

const KNIGHT = [-33, -31, -18, -14, 14, 18, 31, 33];
const BISHOP = [-17, -15, 15, 17];
const ROOK = [-16, -1, 1, 16];
const KING = [-17, -16, -15, -1, 1, 15, 16, 17];

export const sqName = (sq) => 'abcdefgh'[sq & 7] + (8 - (sq >> 4));
export const sqIndex = (name) => {
  if (!/^[a-h][1-8]$/.test(name)) return -1;
  return (8 - Number(name[1])) * 16 + (name.charCodeAt(0) - 97);
};
const colorOf = (p) => (p === p.toUpperCase() ? 'w' : 'b');
const swap = (c) => (c === 'w' ? 'b' : 'w');

export class Chess {
  constructor(fen = START_FEN) {
    const err = this.load(fen);
    if (err) throw new Error(err);
  }

  // ------------------------------------------------------------------ FEN
  static validateFen(fen) {
    const parts = String(fen).trim().split(/\s+/);
    if (parts.length < 4 || parts.length > 6) return 'A FEN has 4 to 6 fields.';
    const rows = parts[0].split('/');
    if (rows.length !== 8) return 'The board field needs 8 ranks separated by "/".';
    let wk = 0, bk = 0;
    for (const [i, row] of rows.entries()) {
      let n = 0;
      for (const ch of row) {
        if (/[1-8]/.test(ch)) n += Number(ch);
        else if (/[pnbrqkPNBRQK]/.test(ch)) {
          n += 1;
          if (ch === 'K') wk++;
          if (ch === 'k') bk++;
          if ((ch === 'p' || ch === 'P') && (i === 0 || i === 7)) return 'A pawn cannot stand on the first or last rank.';
        } else return `Unexpected character "${ch}" in the board field.`;
      }
      if (n !== 8) return `Rank ${8 - i} does not have 8 squares.`;
    }
    if (wk !== 1 || bk !== 1) return 'Each side needs exactly one king.';
    if (!/^[wb]$/.test(parts[1])) return 'Side to move must be "w" or "b".';
    if (!/^(-|K?Q?k?q?)$/.test(parts[2]) || parts[2] === '') return 'Castling field must be "-" or a subset of "KQkq".';
    if (!/^(-|[a-h][36])$/.test(parts[3])) return 'En passant field must be "-" or a square on rank 3 or 6.';
    if (parts[4] !== undefined && !/^\d+$/.test(parts[4])) return 'Halfmove clock must be a number.';
    if (parts[5] !== undefined && !/^[1-9]\d*$/.test(parts[5])) return 'Fullmove number must be a positive number.';
    return null;
  }

  load(fen) {
    const err = Chess.validateFen(fen);
    if (err) return err;
    const [pos, turn, castling, ep, half = '0', full = '1'] = String(fen).trim().split(/\s+/);
    this.b = new Array(128).fill(null);
    this.kings = { w: -1, b: -1 };
    let sq = 0;
    for (const ch of pos) {
      if (ch === '/') sq += 8;
      else if (/\d/.test(ch)) sq += Number(ch);
      else {
        this.b[sq] = ch;
        if (ch === 'K') this.kings.w = sq;
        if (ch === 'k') this.kings.b = sq;
        sq++;
      }
    }
    this.turn = turn;
    this.castling = 0;
    for (const c of castling) if (CASTLE[c]) this.castling |= CASTLE[c];
    // Drop castling rights that the position cannot have (king or rook not on its home square).
    if (this.b[116] !== 'K') this.castling &= ~(CASTLE.K | CASTLE.Q);
    if (this.b[4] !== 'k') this.castling &= ~(CASTLE.k | CASTLE.q);
    if (this.b[119] !== 'R') this.castling &= ~CASTLE.K;
    if (this.b[112] !== 'R') this.castling &= ~CASTLE.Q;
    if (this.b[7] !== 'r') this.castling &= ~CASTLE.k;
    if (this.b[0] !== 'r') this.castling &= ~CASTLE.q;
    this.ep = ep === '-' ? -1 : sqIndex(ep);
    this.half = Number(half);
    this.full = Number(full);
    this.stack = [];
    this.startFen = this.fen();
    this.reps = new Map();
    this._countRep(1);
    if (this.attacked(this.kings[swap(this.turn)], this.turn)) return 'The side not to move is in check, which cannot happen.';
    return null;
  }

  reset() { this.load(START_FEN); }

  fen() {
    let s = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const p = this.b[r * 16 + f];
        if (!p) empty++;
        else { if (empty) s += empty; empty = 0; s += p; }
      }
      if (empty) s += empty;
      if (r < 7) s += '/';
    }
    let c = '';
    if (this.castling & CASTLE.K) c += 'K';
    if (this.castling & CASTLE.Q) c += 'Q';
    if (this.castling & CASTLE.k) c += 'k';
    if (this.castling & CASTLE.q) c += 'q';
    return `${s} ${this.turn} ${c || '-'} ${this.ep >= 0 ? sqName(this.ep) : '-'} ${this.half} ${this.full}`;
  }

  // Position key for repetition: board, side, castling, and en passant only when a capture is really possible.
  _repKey() {
    const parts = this.fen().split(' ');
    let ep = '-';
    if (this.ep >= 0) {
      const pawn = this.turn === 'w' ? 'P' : 'p';
      const from = this.turn === 'w' ? [this.ep + 15, this.ep + 17] : [this.ep - 15, this.ep - 17];
      for (const s of from) {
        if (s & 0x88 || this.b[s] !== pawn) continue;
        const m = { from: s, to: this.ep, piece: pawn, captured: this.turn === 'w' ? 'p' : 'P', flags: F.EP | F.CAPTURE };
        this._make(m);
        const ok = !this.attacked(this.kings[swap(this.turn)], this.turn);
        this._unmake();
        if (ok) { ep = parts[3]; break; }
      }
    }
    return `${parts[0]} ${parts[1]} ${parts[2]} ${ep}`;
  }
  _countRep(d) {
    const k = this._repKey();
    const n = (this.reps.get(k) || 0) + d;
    if (n <= 0) this.reps.delete(k); else this.reps.set(k, n);
  }

  // ------------------------------------------------------------------ board access
  get(name) { const s = sqIndex(name); return s < 0 ? null : this.b[s]; }
  board() {
    const out = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let f = 0; f < 8; f++) row.push(this.b[r * 16 + f]);
      out.push(row);
    }
    return out;
  }

  // Is `sq` attacked by side `by`?
  attacked(sq, by) {
    const b = this.b;
    // pawns
    if (by === 'w') {
      for (const d of [15, 17]) { const s = sq + d; if (!(s & 0x88) && b[s] === 'P') return true; }
    } else {
      for (const d of [-15, -17]) { const s = sq + d; if (!(s & 0x88) && b[s] === 'p') return true; }
    }
    const N = by === 'w' ? 'N' : 'n', B = by === 'w' ? 'B' : 'b', R = by === 'w' ? 'R' : 'r', Q = by === 'w' ? 'Q' : 'q', K = by === 'w' ? 'K' : 'k';
    for (const d of KNIGHT) { const s = sq + d; if (!(s & 0x88) && b[s] === N) return true; }
    for (const d of KING) { const s = sq + d; if (!(s & 0x88) && b[s] === K) return true; }
    for (const d of BISHOP) {
      for (let s = sq + d; !(s & 0x88); s += d) { const p = b[s]; if (p) { if (p === B || p === Q) return true; break; } }
    }
    for (const d of ROOK) {
      for (let s = sq + d; !(s & 0x88); s += d) { const p = b[s]; if (p) { if (p === R || p === Q) return true; break; } }
    }
    return false;
  }

  inCheck() { return this.attacked(this.kings[this.turn], swap(this.turn)); }

  // ------------------------------------------------------------------ move generation
  _pseudo() {
    const out = [];
    const us = this.turn, them = swap(us), b = this.b;
    const add = (from, to, flags, promo) => {
      const piece = b[from];
      const captured = flags & F.EP ? (us === 'w' ? 'p' : 'P') : b[to];
      if ((piece === 'P' && to >> 4 === 0) || (piece === 'p' && to >> 4 === 7)) {
        for (const p of ['q', 'r', 'b', 'n']) out.push({ from, to, piece, captured, promotion: us === 'w' ? p.toUpperCase() : p, flags: flags | F.PROMO });
      } else out.push({ from, to, piece, captured, promotion: null, flags });
    };
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = b[sq];
      if (!p || colorOf(p) !== us) continue;
      const t = p.toLowerCase();
      if (t === 'p') {
        const dir = us === 'w' ? -16 : 16;
        const startRank = us === 'w' ? 6 : 1;
        const one = sq + dir;
        if (!(one & 0x88) && !b[one]) {
          add(sq, one, F.NORMAL);
          const two = one + dir;
          if (sq >> 4 === startRank && !b[two]) add(sq, two, F.BIG_PAWN);
        }
        for (const d of [dir - 1, dir + 1]) {
          const s = sq + d;
          if (s & 0x88) continue;
          if (b[s] && colorOf(b[s]) === them) add(sq, s, F.CAPTURE);
          else if (s === this.ep) add(sq, s, F.EP | F.CAPTURE);
        }
      } else if (t === 'n' || t === 'k') {
        for (const d of t === 'n' ? KNIGHT : KING) {
          const s = sq + d;
          if (s & 0x88) continue;
          if (!b[s]) add(sq, s, F.NORMAL);
          else if (colorOf(b[s]) === them) add(sq, s, F.CAPTURE);
        }
      } else {
        const dirs = t === 'b' ? BISHOP : t === 'r' ? ROOK : KING;
        for (const d of dirs) {
          for (let s = sq + d; !(s & 0x88); s += d) {
            if (!b[s]) add(sq, s, F.NORMAL);
            else { if (colorOf(b[s]) === them) add(sq, s, F.CAPTURE); break; }
          }
        }
      }
    }
    // castling: king and rook on home squares, path empty, king not in, through or into check
    const ks = this.kings[us];
    if (us === 'w' && ks === 116) {
      if (this.castling & CASTLE.K && !b[117] && !b[118] && b[119] === 'R' && !this.attacked(116, them) && !this.attacked(117, them) && !this.attacked(118, them)) add(116, 118, F.KCASTLE);
      if (this.castling & CASTLE.Q && !b[115] && !b[114] && !b[113] && b[112] === 'R' && !this.attacked(116, them) && !this.attacked(115, them) && !this.attacked(114, them)) add(116, 114, F.QCASTLE);
    } else if (us === 'b' && ks === 4) {
      if (this.castling & CASTLE.k && !b[5] && !b[6] && b[7] === 'r' && !this.attacked(4, them) && !this.attacked(5, them) && !this.attacked(6, them)) add(4, 6, F.KCASTLE);
      if (this.castling & CASTLE.q && !b[3] && !b[2] && !b[1] && b[0] === 'r' && !this.attacked(4, them) && !this.attacked(3, them) && !this.attacked(2, them)) add(4, 2, F.QCASTLE);
    }
    return out;
  }

  _make(m) {
    const b = this.b, us = this.turn;
    this.stack.push({ m, castling: this.castling, ep: this.ep, half: this.half, full: this.full });
    b[m.to] = m.promotion || m.piece;
    b[m.from] = null;
    if (m.flags & F.EP) b[us === 'w' ? m.to + 16 : m.to - 16] = null;
    if (m.flags & F.KCASTLE) { b[m.to - 1] = b[m.to + 1]; b[m.to + 1] = null; }
    if (m.flags & F.QCASTLE) { b[m.to + 1] = b[m.to - 2]; b[m.to - 2] = null; }
    if (m.piece === 'K') { this.kings.w = m.to; this.castling &= ~(CASTLE.K | CASTLE.Q); }
    if (m.piece === 'k') { this.kings.b = m.to; this.castling &= ~(CASTLE.k | CASTLE.q); }
    if (ROOK_HOME[m.from]) this.castling &= ~ROOK_HOME[m.from];
    if (ROOK_HOME[m.to]) this.castling &= ~ROOK_HOME[m.to];
    this.ep = m.flags & F.BIG_PAWN ? (m.from + m.to) / 2 : -1;
    this.half = m.piece.toLowerCase() === 'p' || m.flags & F.CAPTURE ? 0 : this.half + 1;
    if (us === 'b') this.full++;
    this.turn = swap(us);
  }

  _unmake() {
    const st = this.stack.pop();
    if (!st) return null;
    const { m } = st, b = this.b;
    this.turn = swap(this.turn);
    const us = this.turn;
    this.castling = st.castling; this.ep = st.ep; this.half = st.half; this.full = st.full;
    b[m.from] = m.piece;
    b[m.to] = m.flags & F.EP ? null : m.captured || null;
    if (m.flags & F.EP) b[us === 'w' ? m.to + 16 : m.to - 16] = m.captured;
    if (m.flags & F.KCASTLE) { b[m.to + 1] = b[m.to - 1]; b[m.to - 1] = null; }
    if (m.flags & F.QCASTLE) { b[m.to - 2] = b[m.to + 1]; b[m.to + 1] = null; }
    if (m.piece === 'K') this.kings.w = m.from;
    if (m.piece === 'k') this.kings.b = m.from;
    return m;
  }

  _legal() {
    const us = this.turn, out = [];
    for (const m of this._pseudo()) {
      this._make(m);
      if (!this.attacked(this.kings[us], swap(us))) out.push(m);
      this._unmake();
    }
    return out;
  }

  // Public, decorated moves: { from, to, piece, captured, promotion, san, uci, flags }
  moves({ square } = {}) {
    let list = this._legal();
    if (square) { const s = sqIndex(square); list = list.filter((m) => m.from === s); }
    return list.map((m) => this._decorate(m, list));
  }

  _decorate(m, legal) {
    const san = this._san(m, legal || this._legal());
    const uci = sqName(m.from) + sqName(m.to) + (m.promotion ? m.promotion.toLowerCase() : '');
    const fl = [];
    if (m.flags & F.CAPTURE) fl.push('capture');
    if (m.flags & F.EP) fl.push('en-passant');
    if (m.flags & F.KCASTLE) fl.push('castle-kingside');
    if (m.flags & F.QCASTLE) fl.push('castle-queenside');
    if (m.flags & F.PROMO) fl.push('promotion');
    if (m.flags & F.BIG_PAWN) fl.push('double-push');
    return {
      from: sqName(m.from), to: sqName(m.to), piece: m.piece, captured: m.captured || null,
      promotion: m.promotion || null, color: colorOf(m.piece), san, uci, flags: fl, _raw: m,
    };
  }

  _san(m, legal) {
    let s;
    if (m.flags & F.KCASTLE) s = 'O-O';
    else if (m.flags & F.QCASTLE) s = 'O-O-O';
    else {
      const t = m.piece.toUpperCase();
      if (t === 'P') {
        s = m.flags & F.CAPTURE ? sqName(m.from)[0] + 'x' + sqName(m.to) : sqName(m.to);
        if (m.promotion) s += '=' + m.promotion.toUpperCase();
      } else {
        // disambiguation
        const rivals = legal.filter((o) => o.piece === m.piece && o.to === m.to && o.from !== m.from);
        let dis = '';
        if (rivals.length) {
          const sameFile = rivals.some((o) => (o.from & 7) === (m.from & 7));
          const sameRank = rivals.some((o) => o.from >> 4 === m.from >> 4);
          if (!sameFile) dis = sqName(m.from)[0];
          else if (!sameRank) dis = sqName(m.from)[1];
          else dis = sqName(m.from);
        }
        s = t + dis + (m.flags & F.CAPTURE ? 'x' : '') + sqName(m.to);
      }
    }
    this._make(m);
    if (this.inCheck()) s += this._legal().length ? '+' : '#';
    this._unmake();
    return s;
  }

  // Find a legal move from SAN, UCI or {from,to,promotion}. Returns the decorated move or null.
  find(input) {
    const legal = this._legal();
    const dec = () => legal.map((m) => this._decorate(m, legal));
    if (input && typeof input === 'object') {
      const from = sqIndex(input.from), to = sqIndex(input.to);
      const promo = input.promotion ? input.promotion.toLowerCase() : null;
      const m = legal.find((x) => x.from === from && x.to === to && (!x.promotion || x.promotion.toLowerCase() === (promo || 'q')));
      return m ? this._decorate(m, legal) : null;
    }
    let s = String(input || '').trim();
    if (!s) return null;
    // UCI
    const u = /^([a-h][1-8])-?([a-h][1-8])([qrbnQRBN])?$/.exec(s);
    if (u) {
      const r = this.find({ from: u[1], to: u[2], promotion: u[3] });
      if (r) return r;
    }
    const norm = (x) => x.replace(/[+#!?]+$/g, '').replace(/0-0-0/g, 'O-O-O').replace(/0-0/g, 'O-O').replace(/o-o-o/gi, 'O-O-O').replace(/o-o/gi, 'O-O').replace(/=/g, '');
    const want = norm(s);
    const all = dec();
    let hit = all.find((m) => norm(m.san) === want);
    if (hit) return hit;
    // lenient: drop "x", accept lowercase piece letters when unambiguous, "e8Q" style promotion
    const loose = (x) => norm(x).replace(/x/g, '');
    hit = all.filter((m) => loose(m.san) === loose(s));
    if (hit.length === 1) return hit[0];
    if (/^[nrqk]/.test(s)) {
      const up = s[0].toUpperCase() + s.slice(1);
      hit = all.filter((m) => loose(m.san) === loose(up));
      if (hit.length === 1) return hit[0];
    }
    if (/^b[a-h]?x?[a-h][1-8]/.test(s)) { // "bc4" might mean bishop to c4
      const up = 'B' + s.slice(1);
      hit = all.filter((m) => loose(m.san) === loose(up));
      if (hit.length === 1) return hit[0];
    }
    return null;
  }

  move(input) {
    const m = this.find(input);
    if (!m) return null;
    this._make(m._raw);
    this._countRep(1);
    return m;
  }

  undo() {
    if (!this.stack.length) return null;
    this._countRep(-1);
    const m = this._unmake();
    return m ? this._decorate(m) : null;
  }

  history() {
    // replay from the start to produce SAN for each ply
    const out = [];
    const raw = this.stack.map((s) => s.m);
    const c = new Chess(this.startFen);
    for (const m of raw) {
      const d = c.find({ from: sqName(m.from), to: sqName(m.to), promotion: m.promotion });
      out.push(d);
      c.move(d.uci);
    }
    return out;
  }
  ply() { return this.stack.length; }
  lastMove() { const s = this.stack[this.stack.length - 1]; return s ? { from: sqName(s.m.from), to: sqName(s.m.to) } : null; }

  // ------------------------------------------------------------------ end of game
  isCheckmate() { return this.inCheck() && this._legal().length === 0; }
  isStalemate() { return !this.inCheck() && this._legal().length === 0; }
  isFiftyMove() { return this.half >= 100; }
  isThreefold() { return (this.reps.get(this._repKey()) || 0) >= 3; }
  isInsufficientMaterial() {
    const pieces = [];
    for (let sq = 0; sq < 120; sq++) {
      if (sq & 0x88) { sq += 7; continue; }
      const p = this.b[sq];
      if (p && p.toLowerCase() !== 'k') pieces.push({ p: p.toLowerCase(), shade: ((sq >> 4) + (sq & 7)) % 2 });
    }
    if (!pieces.length) return true;
    if (pieces.length === 1 && (pieces[0].p === 'n' || pieces[0].p === 'b')) return true;
    // only bishops, all on one colour of square
    if (pieces.every((x) => x.p === 'b') && new Set(pieces.map((x) => x.shade)).size === 1) return true;
    return false;
  }
  // { over, result: '1-0' | '0-1' | '1/2-1/2' | '*', reason }
  status() {
    const n = this._legal().length;
    if (n === 0 && this.inCheck()) return { over: true, result: this.turn === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
    if (n === 0) return { over: true, result: '1/2-1/2', reason: 'stalemate' };
    if (this.isInsufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient material' };
    if (this.isFiftyMove()) return { over: true, result: '1/2-1/2', reason: 'fifty-move rule' };
    if (this.isThreefold()) return { over: true, result: '1/2-1/2', reason: 'threefold repetition' };
    return { over: false, result: '*', reason: '' };
  }

  // ------------------------------------------------------------------ PGN
  pgn(headers = {}, result) {
    const h = { Event: 'chess-webCLI game', Site: 'chess-webCLI', Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'), White: '?', Black: '?', Result: result || this.status().result, ...headers };
    if (this.startFen !== START_FEN) { h.SetUp = '1'; h.FEN = this.startFen; }
    let out = Object.entries(h).map(([k, v]) => `[${k} "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`).join('\n') + '\n\n';
    const hist = this.history();
    const startFull = Number(this.startFen.split(' ')[5]);
    const blackFirst = this.startFen.split(' ')[1] === 'b';
    let line = '', moveNo = startFull;
    hist.forEach((m, i) => {
      const white = blackFirst ? i % 2 === 1 : i % 2 === 0;
      if (white) line += `${moveNo}. `;
      else if (i === 0) line += `${moveNo}... `;
      line += m.san + ' ';
      if (!white) moveNo++;
    });
    out += (line + h.Result).replace(/(.{1,79})(\s|$)/g, '$1\n').trim() + '\n';
    return out;
  }

  // Returns { ok, headers, error }. Replaces the current game on success.
  static parsePgn(text) {
    const headers = {};
    const src = String(text);
    for (const m of src.matchAll(/\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/g)) headers[m[1]] = m[2].replace(/\\(.)/g, '$1');
    let body = src.replace(/\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]/g, ' ');
    body = body.replace(/\{[^}]*\}/g, ' ').replace(/;[^\n]*/g, ' ');
    // strip variations (nested)
    let prev;
    do { prev = body; body = body.replace(/\([^()]*\)/g, ' '); } while (body !== prev);
    body = body.replace(/\$\d+/g, ' ');
    const tokens = body.split(/\s+/).map((t) => t.replace(/^\d+\.(\.\.)?/, '')).filter((t) => t && !/^\d+\.+$/.test(t));
    let result = '*';
    let c;
    try { c = new Chess(headers.FEN || START_FEN); } catch (e) { return { ok: false, error: 'Bad FEN header: ' + e.message }; }
    for (const t of tokens) {
      if (/^(1-0|0-1|1\/2-1\/2|\*)$/.test(t)) { result = t; break; }
      if (!c.move(t)) return { ok: false, error: `Illegal or unreadable move "${t}" at ply ${c.ply() + 1}.`, game: c, headers };
    }
    return { ok: true, game: c, headers, result };
  }

  perft(depth) {
    if (depth === 0) return 1;
    const list = this._legal();
    if (depth === 1) return list.length;
    let n = 0;
    for (const m of list) { this._make(m); n += this.perft(depth - 1); this._unmake(); }
    return n;
  }
}

export const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
