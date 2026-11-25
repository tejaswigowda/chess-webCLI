// Games kept in a git repo: self-claimed seats, times on every event, days-per-move deadlines.
import { newSeatKey, signEvent, replay, nextEvent, PROTO } from '../docs/js/log.js';
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const room = 'room-async';
const A = await newSeatKey(), B = await newSeatKey(), C = await newSeatKey();
const DAY = 864e5, T0 = Date.UTC(2026, 10, 25, 9);
let log = [];
const add = async (key, body, expectOk, label) => {
  const st = await replay(log, { room });
  const ev = await signEvent(key, nextEvent(st, body));
  const r = await replay([...log, ev], { room, anchor: A.keyId });
  if (expectOk && r.ok) log.push(ev);
  check(label, expectOk ? r.ok : !r.ok, r.error || '');
  return r;
};
await add(A, { t: 'init', v: PROTO, color: 'w', pub: A.pub, name: 'Ann', tc: { days: 3 }, claim: true, at: T0 }, true, 'creator opens a 3-days-per-move game');
await add(B, { t: 'claim', color: 'b', pub: B.pub, name: 'Bob' }, false, 'a claim without a time is refused');
await add(B, { t: 'claim', color: 'w', pub: B.pub, name: 'Bob', at: T0 + 1000 }, false, 'the creator\'s seat cannot be claimed');
await add(B, { t: 'claim', color: 'b', pub: B.pub, name: 'Bob', at: T0 + DAY }, true, 'Bob claims Black while Ann is offline');
await add(C, { t: 'claim', color: 'b', pub: C.pub, name: 'Cat', at: T0 + DAY + 5 }, false, 'a second claim for the same seat is refused');
let st = await replay(log, { room });
check('the clock starts when both seats are taken', st.deadline === T0 + 4 * DAY);
await add(A, { t: 'move', by: 'w', uci: 'e2e4', at: T0 + 2 * DAY }, true, 'Ann plays e4 a day later');
await add(B, { t: 'move', by: 'b', uci: 'e7e5', at: T0 + 1.5 * DAY }, false, 'an event dated before the one it follows is refused');
st = await replay(log, { room });
check('Black\'s deadline is 3 days after e4', st.deadline === T0 + 5 * DAY);
await add(A, { t: 'flag', by: 'w', color: 'b', at: T0 + 4 * DAY }, false, 'no flag before the deadline');
await add(A, { t: 'flag', by: 'w', color: 'w', at: T0 + 6 * DAY }, false, 'only the side to move can run out of time');
await add(A, { t: 'flag', by: 'w', color: 'b', at: T0 + 5 * DAY + 1 }, true, 'a flag after the deadline wins');
st = await replay(log, { room });
check('result: White wins on time', st.result?.result === '1-0' && st.deadline === null, JSON.stringify(st.result));
check('PGN time control is correspondence', /TimeControl "1\/259200"/.test((await import('../docs/js/log.js')).pgnOf(st)));
// claims are off in a live room
{
  const l2 = [];
  const init = await signEvent(A, nextEvent({ events: [], tip: room }, { t: 'init', v: PROTO, color: 'w', pub: A.pub, name: 'Ann', tc: null }));
  l2.push(init);
  const st2 = await replay(l2, { room });
  const c = await signEvent(B, nextEvent(st2, { t: 'claim', color: 'b', pub: B.pub, name: 'Bob' }));
  const r = await replay([...l2, c], { room });
  check('a live room does not accept claims', !r.ok && /claimed/.test(r.error), r.error);
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
