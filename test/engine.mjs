// Engine checks: finds mates, wins material, respects its bounds, is deterministic.
import { search, LEVELS } from '../docs/js/engine.js';
import { Chess } from '../docs/js/chess.js';
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

const r1 = search('7k/8/6K1/8/8/8/Q7/8 w - - 0 1', { level: 3 });
check('mate in 1', r1.san === 'Qa8#' && r1.mateIn === 1, JSON.stringify(r1));
const r2 = search('r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4', { level: 3 });
check("scholar's mate", r2.san === 'Qxf7#', r2.san);
const r3 = search('6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1', { level: 3 });
check('back-rank mate', r3.san === 'Rd8#', r3.san);
const r4 = search('4k3/8/8/3q4/8/8/3R4/3RK3 w - - 0 1', { level: 2 });
check('wins the hanging queen', r4.san === 'Rxd5', r4.san);
const r5 = search('4k3/8/8/8/3q4/8/8/3QK3 b - - 0 1', { level: 1 });
check('level 1 answers in a queen-trade position', !!r5.san, r5.san);
for (const lv of [1, 3, 5]) {
  const r = search('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', { level: lv });
  check(`level ${lv} stays within its time bound`, r.ms <= LEVELS[lv].ms + 400, `${r.ms} ms, ${r.nodes} nodes, depth ${r.depth}, stopped by ${r.stoppedBy}, ${r.san}`);
  check(`level ${lv} stays within its node bound`, r.nodes <= LEVELS[lv].nodes + 1024);
  check(`level ${lv} returns a legal move`, !!new Chess('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3').find(r.uci));
}
const a = search('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', { level: 1, seed: 7, limits: { ms: 1e9 } });
const b = search('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', { level: 1, seed: 7, limits: { ms: 1e9 } });
check('same seed, same move', a.uci === b.uci, a.san);
check('no move when mated', search('Q6k/8/6K1/8/8/8/8/8 b - - 0 1').uci === null);
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
