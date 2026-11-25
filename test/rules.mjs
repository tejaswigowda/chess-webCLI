// Rules-engine checks: perft counts against published values, SAN/UCI/FEN/PGN round trips, draws.
// Run: node test/rules.mjs   (no dependencies)
import { Chess, START_FEN } from '../docs/js/chess.js';
import { parseIntent } from '../docs/js/intent.js';

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

// Published perft results (chessprogramming.org/Perft_Results)
const PERFT = [
  [START_FEN, [20, 400, 8902, 197281]],
  ['r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', [48, 2039, 97862]], // Kiwipete
  ['8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', [14, 191, 2812, 43238]],
  ['r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', [6, 264, 9467]],
  ['rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8', [44, 1486, 62379]],
  ['r4rk1/1pp1qppp/p1np1n2/2b1p1B1/2B1P1b1/P1NP1N2/1PP1QPPP/R4RK1 w - - 0 10', [46, 2079, 89890]],
];
for (const [fen, counts] of PERFT) {
  const c = new Chess(fen);
  counts.forEach((want, i) => {
    const t0 = Date.now();
    const got = c.perft(i + 1);
    check(`perft ${i + 1} ${fen.split(' ')[0].slice(0, 22)}…`, got === want, `${got} (want ${want}, ${Date.now() - t0} ms)`);
  });
  check('perft leaves the position unchanged', c.fen() === new Chess(fen).fen());
}

// SAN
{
  const c = new Chess();
  for (const s of ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O']) check(`SAN ${s}`, !!c.move(s));
  check('castled king on g1', c.get('g1') === 'K' && c.get('f1') === 'R');
  check('FEN after Ruy Lopez', c.fen() === 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQ1RK1 b kq - 3 5', c.fen());
  check('undo restores', c.undo() && c.fen() === 'r1bqkb1r/1ppp1ppp/p1n2n2/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 5');
}
{
  // disambiguation
  const c = new Chess('7k/8/8/8/8/8/8/R4RK1 w - - 0 1');
  const sans = c.moves().map((m) => m.san);
  check('rook disambiguation by file', sans.includes('Rad1') && sans.includes('Rfd1'), sans.filter((s) => s.includes('d1')).join(','));
  const c2 = new Chess('4k3/8/8/N7/8/8/8/N3K3 w - - 0 1');
  const s2 = c2.moves().map((m) => m.san);
  check('knight disambiguation by rank', s2.includes('N1b3') && s2.includes('N5b3'), s2.filter((s) => s.includes('b3')).join(','));
}
{
  // promotion, check marks
  const c = new Chess('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  const m = c.move('a8=Q');
  check('promotion SAN', m && m.san === 'a8=Q' && c.get('a8') === 'Q');
  const c2 = new Chess('8/P6k/8/8/8/8/8/K7 w - - 0 1');
  check('promotion via UCI', c2.move('a7a8n') && c2.get('a8') === 'N');
  const c3 = new Chess('7k/8/6K1/8/8/8/Q7/8 w - - 0 1');
  const mate = c3.move('Qa8');
  check('mate mark', mate && mate.san === 'Qa8#' && c3.status().reason === 'checkmate' && c3.status().result === '1-0');
}
{
  // en passant, including the case where it would expose the king
  const c = new Chess('rnbqkbnr/ppp1p1pp/8/3pPp2/8/8/PPPP1PPP/RNBQKBNR w KQkq f6 0 3');
  check('en passant legal', !!c.find('exf6'));
  const pin = new Chess('8/8/8/K2pP2r/8/8/8/7k w - d6 0 1');
  check('en passant illegal when it exposes the king', !pin.find('exd6'));
}
{
  // castling through check
  const c = new Chess('r3k2r/8/8/8/8/8/5r2/R3K2R w KQkq - 0 1');
  check('cannot castle through attacked f1', !c.find('O-O'));
  check('can castle queenside', !!c.find('O-O-O'));
  check('lenient castle 0-0-0', !!c.find('0-0-0'));
}
{
  // draws
  check('stalemate', new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').status().reason === 'stalemate');
  check('K v K insufficient', new Chess('8/8/4k3/8/8/4K3/8/8 w - - 0 1').status().reason === 'insufficient material');
  check('K+N v K insufficient', new Chess('8/8/4k3/8/8/4KN2/8/8 w - - 0 1').status().reason === 'insufficient material');
  check('K+R v K is not', !new Chess('8/8/4k3/8/8/4KR2/8/8 w - - 0 1').status().over);
  const c = new Chess();
  for (let i = 0; i < 2; i++) for (const s of ['Nf3', 'Nf6', 'Ng1', 'Ng8']) c.move(s);
  check('threefold repetition', c.status().reason === 'threefold repetition', JSON.stringify(c.status()));
  check('fifty-move', new Chess('8/8/4k3/8/8/4KR2/8/8 w - - 100 80').status().reason === 'fifty-move rule');
}
{
  // FEN validation
  check('rejects bad FEN', !!Chess.validateFen('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP w KQkq - 0 1'));
  check('rejects two white kings', !!Chess.validateFen('K6k/8/8/8/8/8/8/K7 w - - 0 1'));
  let threw = false; try { new Chess('k7/8/8/8/8/8/8/R3K3 w - - 0 1'); } catch { threw = false; }
  try { new Chess('k7/R7/8/8/8/8/8/4K3 w - - 0 1'); } catch { threw = true; }
  check('rejects side-not-to-move in check', threw);
}
{
  // PGN round trip
  const c = new Chess();
  for (const s of ['d4', 'd5', 'c4', 'dxc4', 'e3', 'b5', 'a4', 'c6', 'axb5', 'cxb5', 'Qf3']) c.move(s);
  const pgn = c.pgn({ White: 'A', Black: 'B' });
  const p = Chess.parsePgn(pgn);
  check('PGN round trip', p.ok && p.game.fen() === c.fen(), p.error || '');
  const messy = '[Event "x"]\n1. e4 {best by test} e5 (1... c5 2. Nf3) 2. Nf3 $1 Nc6 3. Bb5 a6 *';
  const q = Chess.parsePgn(messy);
  check('PGN with comments, variations, NAGs', q.ok && q.game.ply() === 6, q.error || '');
  const bad = Chess.parsePgn('1. e4 e5 2. Ke3 Nc6');
  check('PGN reports the illegal move', !bad.ok && /Ke3/.test(bad.error));
  const fromFen = new Chess('8/P6k/8/8/8/8/8/K7 b - - 0 40');
  fromFen.move('Kg6'); fromFen.move('a8=Q');
  const r = Chess.parsePgn(fromFen.pgn());
  check('PGN with FEN header and black to move first', r.ok && r.game.fen() === fromFen.fen(), r.error || '');
}

// The deterministic intent parser (no model)
{
  const c = new Chess();
  const t = (text, want) => {
    const r = parseIntent(text, c);
    const got = r.kind === 'move' ? r.move.san : r.kind === 'command' ? '/' + r.command : r.kind + (r.candidates ? ':' + r.candidates.map((m) => m.san).join(',') : '');
    check(`intent "${text}"`, got === want, got);
  };
  t('e4', 'e4');
  t('e2e4', 'e4');
  t('pawn to e4', 'e4');
  t('knight to f3', 'Nf3');
  t('Knight f3', 'Nf3');
  t('move my king side knight out', 'ambiguous:Nf3,Nh3');
  t('knight', 'ambiguous:Na3,Nc3,Nf3,Nh3');
  t('resign', '/resign');
  t('offer a draw', '/draw');
  t('flip the board', '/flip');
  t('pawn to e5', 'none');
  c.move('e4'); c.move('d5');
  t('take the pawn', 'exd5');
  t('pawn takes d5', 'exd5');
  t('capture', 'exd5');
  t('castle', 'none');
  for (const s of ['Nf3', 'Nc6', 'Bc4', 'Nf6']) c.move(s);
  t('castle', 'O-O');
  t('castle kingside', 'O-O');
  t('short castle', 'O-O');
  t('castle queenside', 'none');
  t('bishop takes the knight on f7', 'none');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
