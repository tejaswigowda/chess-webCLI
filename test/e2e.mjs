// End-to-end: real Chrome pages, a mock Nostr relay, real WebRTC data channels between the pages.
// Checks the room protocol (seating, moves, refusals, forgery, watchers, offers, rematch, reload), the
// on-device modes, and that the invite secret never reaches the relay or the page server.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { startMockRelay } from './mock-relay.mjs';

const PORT = 18600 + Math.floor(Math.random() * 300);
const ORIGIN = `http://localhost:${PORT}`;
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const until = async (fn, ms = 30000, step = 200) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, step)); } };

const server = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1' }, stdio: 'ignore' });
const relay = await startMockRelay();
await until(async () => (await fetch(ORIGIN)).ok, 15000);
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
const browser = await chromium.launch({ ...(exe && !process.env.PW_BUNDLED ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'] });

const requests = [];
async function open(name, url = ORIGIN + '/') {
  const ctx = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(({ name, relays }) => {
    if (!sessionStorage.getItem('chess.settings')) sessionStorage.setItem('chess.settings', JSON.stringify({ name, lan: true, relays, sounds: false }));
  }, { name, relays: relay.url });
  const page = await ctx.newPage();
  page.on('request', (r) => requests.push(r.url()));
  page.on('pageerror', (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(url);
  return page;
}
const st = (page) => page.evaluate(() => { const S = window.chess.S; const s = S.st; return s ? { ply: s.game.ply(), fen: s.game.fen(), w: s.seats.w?.name, b: s.seats.b?.name, result: s.result, pending: s.pending, gameNo: s.gameNo, len: S.log.length, me: (() => { for (const c of ['w', 'b']) if (s.seats[c]?.keyId === S.key?.keyId) return c; return null; })() } : null; });
const consoleText = (page) => page.evaluate(() => document.querySelector('#consoleOut').innerText);
const say = (page, text) => page.evaluate((t) => window.chess.runInput(t), text);
const cmd = (page, text) => page.evaluate((t) => window.chess.runCommand(t), text);
const autoConfirm = (page) => page.evaluate(() => { new MutationObserver(() => { const ov = document.querySelector('#overlay'); if (!ov.classList.contains('hidden')) ov.querySelector('.actions button.primary, .actions button.danger')?.click(); }).observe(document.querySelector('#overlay'), { attributes: true }); });

// ---------------------------------------------------------------- on-device modes (zero egress)
{
  const p = await open('Solo');
  const before = requests.length;
  await p.selectOption('#selLevel', '1');
  await p.selectOption('#selLocalColor', 'w');
  await p.click('#btnEngine');
  await say(p, 'e4');
  check('engine answers a move', await until(async () => (await st(p)).ply === 2, 10000));
  await say(p, 'knight to f3');
  check('words become a proposal, not a move', (await st(p)).ply === 2 && /Nf3/.test(await p.innerText('#proposal')));
  await p.click('#proposal button.primary');
  check('confirmed proposal is played', await until(async () => (await st(p)).ply >= 3, 5000));
  await until(async () => (await st(p)).ply === 4, 10000);
  await autoConfirm(p);
  await cmd(p, '/takeback');
  check('takeback against the engine removes your move and its reply', (await st(p)).ply === 2, String((await st(p)).ply));
  await cmd(p, '/hint');
  check('hint available on this device', await until(async () => /Hint: /.test(await consoleText(p)), 15000));
  const hosts = new Set(requests.slice(before).map((u) => new URL(u).host));
  check('on-device game contacts only the page origin', [...hosts].filter(Boolean).every((h) => h === `localhost:${PORT}`), [...hosts].join(','));
  // reload keeps the game
  await p.reload();
  check('reload restores the on-device game', await until(async () => (await st(p))?.ply === 2, 5000));
  // analysis + PGN load
  await p.evaluate(() => window.chess.runCommand('/leave'));
  await p.click('#btnAnalysis');
  await cmd(p, '/load 1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 *');
  check('PGN loads into the analysis board', await until(async () => (await st(p))?.ply === 6, 5000));
  await say(p, 'a6a5');
  check('analysis lets either side move but still refuses illegal moves', (await st(p)).ply === 6);
  await p.context().close();
}

// ---------------------------------------------------------------- a room
const A = await open('Ann');
await A.selectOption('#selColor', 'w');
await A.selectOption('#selTc', '180+2');
await A.click('#btnCreate');
await A.waitForSelector('#game:not(.hidden)');
const invite = A.url();
check('invite has the secret and creator key after #', /#k=[A-Za-z0-9_-]{22}&s=[A-Za-z0-9_-]{22}$/.test(invite), invite.split('#')[1]);
const secret = /#k=([^&]+)/.exec(invite)[1];

const B = await open('Bob', invite);
check('invite screen shows Join', await B.isVisible('#btnJoin'));
await B.click('#btnJoin');
check('Bob is seated as Black by Ann\'s browser', await until(async () => (await st(B))?.me === 'b' && (await st(A))?.b === 'Bob', 30000), JSON.stringify(await st(B)));
check('Bob\'s board is flipped to Black', await B.evaluate(() => window.chess.S.flipped));

await say(A, 'e4');
check('Ann\'s e4 reaches Bob', await until(async () => (await st(B)).ply === 1, 10000));
await say(A, 'd4');
check('Ann cannot move twice', (await st(A)).ply === 1 && /turn/.test(await consoleText(A)));
await say(B, 'pawn to e5');
await B.click('#proposal button.primary');
check('Bob\'s e5 reaches Ann', await until(async () => (await st(A)).ply === 2, 10000));

// forgery: Bob signs a White move and sends it straight to Ann
await B.evaluate(async () => {
  const S = window.chess.S;
  const { signEvent, nextEvent } = await import('./js/log.js');
  const ev = await signEvent(S.key, nextEvent(S.st, { t: 'move', by: 'w', uci: 'd2d4', clk: 1 }));
  await S.actions.ev.send({ ev });
});
await new Promise((r) => setTimeout(r, 1200));
check('a move Bob signs for White is refused by Ann', (await st(A)).ply === 2 && /bad signature/.test(await consoleText(A)));

// a watcher
const C = await open('Cat', invite);
await C.click('#btnJoin');
check('a third person receives the game and watches', await until(async () => { const s = await st(C); return s && s.ply === 2 && s.me === null; }, 30000), JSON.stringify(await st(C)));
await say(C, 'Nf3');
check('the watcher cannot move', (await st(C)).ply === 2 && (await st(A)).ply === 2);
const hintMsgB = await (async () => { await cmd(B, '/hint'); return consoleText(B); })();
check('hints are off for a player during the game', /off for players/.test(hintMsgB));

// clocks
const clocks = await A.evaluate(() => window.chess.S.st.clocks);
check('clocks run with increment', clocks.w > 170000 && clocks.w <= 182000 && clocks.b <= 182000, JSON.stringify(clocks));

// takeback with consent
await autoConfirm(A); await autoConfirm(B);
await cmd(B, '/takeback');
check('Ann sees the takeback request', await until(async () => (await st(A)).pending?.kind === 'takeback', 8000));
await cmd(A, '/accept');
check('takeback applied everywhere', await until(async () => (await st(B)).ply === 1 && (await st(C)).ply === 1, 8000));
await say(B, 'c5');
await until(async () => (await st(A)).ply === 2, 8000);

// reload keeps Bob's seat
await B.reload();
check('after a reload Bob rejoins with his seat', await until(async () => (await st(B))?.me === 'b' && (await st(B)).ply === 2, 30000), JSON.stringify(await st(B)));
await autoConfirm(B);
await say(A, 'Nf3');
check('and the game goes on after the reload', await until(async () => (await st(B)).ply === 3, 15000));

// draw by agreement
await cmd(A, '/draw');
check('draw offer arrives', await until(async () => (await st(B)).pending?.kind === 'draw', 8000));
await cmd(B, '/accept');
check('draw agreed on all three', await until(async () => (await st(A)).result?.result === '1/2-1/2' && (await st(C)).result?.result === '1/2-1/2', 8000));

// rematch swaps colours
await cmd(B, '/rematch');
await until(async () => (await st(A)).pending?.kind === 'rematch', 8000);
await cmd(A, '/accept');
check('rematch swaps colours', await until(async () => (await st(A)).me === 'b' && (await st(B)).me === 'w' && (await st(C)).gameNo === 2, 8000), JSON.stringify(await st(A)));
await say(B, 'd4');
check('Bob opens game 2 as White', await until(async () => (await st(A)).ply === 1, 8000));

// resignation, and the log is identical everywhere
await cmd(A, '/resign');
check('resignation recorded everywhere', await until(async () => (await st(C)).result?.result === '1-0', 8000));
const tips = await Promise.all([A, B, C].map((p) => p.evaluate(() => window.chess.S.st.tip)));
check('all three hold the same log', new Set(tips).size === 1);

// privacy
const frames = relay.frames.join('\n');
check('the invite secret never appears in a relay frame', !frames.includes(secret));
const leak = /"uci"|"t":"move"|"san"/.exec(frames);
check('no relay frame carries a move in plaintext', !leak, leak ? frames.slice(Math.max(0, leak.index - 120), leak.index + 60) : '');
check('the secret never appears in a page request', !requests.some((u) => u.includes(secret)));
const httpReq = requests.filter((u) => /^https?:/.test(u));
check('nothing is fetched from another host', httpReq.every((u) => new URL(u).host === `localhost:${PORT}`), [...new Set(httpReq.map((u) => new URL(u).host))].join(','));

// screenshots for the README
await A.screenshot({ path: 'test/out/room-ann.png' });
await C.screenshot({ path: 'test/out/room-watcher.png' });

await browser.close(); server.kill(); relay.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
