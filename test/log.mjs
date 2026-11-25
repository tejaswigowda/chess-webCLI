// The signed event log: forged, illegal and out-of-turn events are refused; consent must be signed by
// the consenting player; two peers with a fork settle on the same branch.
import { newSeatKey, signEvent, replay, nextEvent, choose, keyIdOf, PROTO, eventHash } from '../docs/js/log.js';
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const room = 'room-1';
const A = await newSeatKey(), B = await newSeatKey(), M = await newSeatKey(); // creator, joiner, mallory
let log = [];
const add = async (key, body, expectOk = true, label = '') => {
  const st = await replay(log, { room });
  const ev = await signEvent(key, nextEvent(st, body));
  const r = await replay([...log, ev], { room, anchor: A.keyId });
  if (expectOk && r.ok) log.push(ev);
  if (label) check(label, expectOk ? r.ok : !r.ok, r.error || '');
  return r;
};
await add(A, { t: 'init', v: PROTO, color: 'w', pub: A.pub, name: 'Ann', tc: { base: 300000, inc: 2000 }, fen: null }, true, 'creator opens the room');
await add(A, { t: 'move', by: 'w', uci: 'e2e4', clk: 300000 }, false, 'no move before the second seat is taken');
await add(M, { t: 'seat', color: 'b', pub: M.pub, name: 'Mal' }, false, 'only the creator can seat someone');
await add(A, { t: 'seat', color: 'b', pub: B.pub, name: 'Bob' }, true, 'creator seats Bob as Black');
await add(A, { t: 'seat', color: 'b', pub: M.pub, name: 'Mal' }, false, 'a taken seat stays taken');
await add(B, { t: 'move', by: 'w', uci: 'e2e4', clk: 1 }, false, 'Black cannot sign a move for White');
await add(A, { t: 'move', by: 'w', uci: 'e2e5' }, false, 'illegal move refused');
await add(A, { t: 'move', by: 'w', uci: 'e2e4', clk: 300000 }, true, 'White plays e4');
await add(A, { t: 'move', by: 'w', uci: 'd2d4', clk: 300000 }, false, 'not White\'s turn twice');
await add(B, { t: 'move', by: 'b', uci: 'e7e5', clk: 999999 }, true, 'Black plays e5');
let st = await replay(log, { room });
check('self-reported clock is capped at remaining + increment', st.clocks.b === 302000, String(st.clocks.b));
await add(B, { t: 'offer', by: 'b', kind: 'takeback' }, true, 'Black asks for a takeback');
await add(B, { t: 'reply', by: 'b', kind: 'takeback', accept: true }, false, 'Black cannot accept their own takeback');
await add(A, { t: 'reply', by: 'w', kind: 'takeback', accept: true }, true, 'White accepts');
st = await replay(log, { room });
check('takeback undid exactly Black\'s move', st.game.ply() === 1 && st.game.turn === 'b');
await add(B, { t: 'move', by: 'b', uci: 'c7c5', clk: 299000 }, true, 'Black plays c5 instead');
await add(A, { t: 'offer', by: 'w', kind: 'draw' }, true, 'White offers a draw');
await add(A, { t: 'move', by: 'w', uci: 'g1f3', clk: 299000 }, true, 'White moves; their own offer stands');
st = await replay(log, { room });
check('offer still pending after the offerer moved', st.pending && st.pending.kind === 'draw');
await add(B, { t: 'move', by: 'b', uci: 'd7d6', clk: 298000 }, true, 'Black moves instead of accepting');
st = await replay(log, { room });
check('moving declines the draw', st.pending === null);
await add(A, { t: 'reply', by: 'w', kind: 'draw', accept: true }, false, 'cannot accept a draw that is no longer offered');

// tampering
{
  const t = structuredClone(log); t[4].uci = 'd2d4';
  const r = await replay(t, { room });
  check('a tampered move fails its signature', !r.ok && r.error === 'bad signature' && r.at === 4, r.error);
  const t2 = structuredClone(log); t2.splice(5, 1);
  const r2 = await replay(t2, { room });
  check('a dropped event breaks the chain', !r2.ok && /index|chain/.test(r2.error), r2.error);
  const r3 = await replay(log, { room, anchor: B.keyId });
  check('a log whose creator does not match the invite is refused', !r3.ok && /invite/.test(r3.error));
  const r4 = await replay(log, { room: 'other-room' });
  check('a log from another room does not chain', !r4.ok);
}
// fork: Black resigns while White also offers... simulate two events at the same index
{
  st = await replay(log, { room });
  const e1 = await signEvent(B, nextEvent(st, { t: 'resign', by: 'b' }));
  const e2 = await signEvent(A, nextEvent(st, { t: 'move', by: 'w', uci: 'd2d4', clk: 297000 }));
  // e2 is illegal (Black to move): use a legal-but-racing pair instead: Black move vs Black resign
  const e3 = await signEvent(B, nextEvent(st, { t: 'move', by: 'b', uci: 'g8f6', clk: 297000 }));
  const x = [...log, e1], y = [...log, e3];
  const c1 = await choose(x, y), c2 = await choose(y, x);
  const winner1 = c1.pick === 'ours' ? x : y, winner2 = c2.pick === 'ours' ? y : x;
  check('both sides of a fork pick the same branch', (await eventHash(winner1.at(-1))) === (await eventHash(winner2.at(-1))) && c1.why === 'fork');
  check('a longer valid log is adopted', (await choose(log.slice(0, 5), log)).pick === 'theirs');
  void e2;
}
// rematch swaps colours
{
  const l2 = [...log];
  log = l2;
  await add(B, { t: 'resign', by: 'b' }, true, 'Black resigns');
  st = await replay(log, { room });
  check('result recorded', st.result.result === '1-0');
  await add(A, { t: 'move', by: 'w', uci: 'd2d4' }, false, 'no moves after the game');
  await add(B, { t: 'offer', by: 'b', kind: 'rematch' }, true, 'Black offers a rematch');
  await add(A, { t: 'reply', by: 'w', kind: 'rematch', accept: true }, true, 'White accepts');
  st = await replay(log, { room });
  check('colours swapped', st.seats.w.keyId === B.keyId && st.seats.b.keyId === A.keyId && st.gameNo === 2 && st.games.length === 1);
  await add(B, { t: 'move', by: 'w', uci: 'e2e4', clk: 300000 }, true, 'Bob opens game 2 as White');
  check('previous game kept as PGN', /Result "1-0"/.test(st.games[0].pgn));
}
// flag
{
  await add(A, { t: 'flag', by: 'b', color: 'b' }, true, 'a flag is recorded');
  st = await replay(log, { room });
  check('flag result', st.result.result === '1-0' && /time/.test(st.result.reason), JSON.stringify(st.result));
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
