// Git-backed games, end to end, with peer-to-peer deliberately broken (dead relay) so that every move has
// to travel through the repo: create, claim while the creator is offline, play across closed tabs, the
// "your games" list, a commit race, a watcher with no token, readable commit messages, and a deadline.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { serve } from './serve.mjs';
import { mockGitHub } from './mock-github.mjs';
import { replay } from '../docs/js/log.js';

let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const until = async (fn, ms = 15000, step = 200) => { const t0 = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch {} if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, step)); } };
const gh = mockGitHub({ repo: 'ann/chess-games', tokens: ['tok-ann', 'tok-bob'] });
const server = await serve({ gh });
const ORIGIN = `http://localhost:${server.port}`;
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
const browser = await chromium.launch({ ...(exe && !process.env.PW_BUNDLED ? { executablePath: exe } : {}), args: ['--no-sandbox'] });
const hosts = new Set();
async function person(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addInitScript(({ name }) => { if (!sessionStorage.getItem('chess.settings')) sessionStorage.setItem('chess.settings', JSON.stringify({ name, lan: true, relays: 'ws://127.0.0.1:9', sounds: false, gitApi: '/__gh' })); }, { name });
  ctx.on('request', (r) => { if (/^https?:/.test(r.url())) hosts.add(new URL(r.url()).host); });
  return ctx;
}
const page = async (ctx, url = ORIGIN + '/?nosw') => { const p = await ctx.newPage(); p.on('pageerror', (e) => console.log('[pageerror]', e.message)); await p.goto(url); return p; };
const st = (p) => p.evaluate(() => { const S = window.chess.S, s = S.st; if (!s) return null; let me = null; for (const c of ['w', 'b']) if (s.seats[c]?.keyId === S.key?.keyId) me = c; return { ply: s.game.ply(), w: s.seats.w?.name, b: s.seats.b?.name, me, result: s.result, deadline: s.deadline, tip: s.tip, len: S.log.length, pending: s.pending }; });
const say = (p, t) => p.evaluate((x) => window.chess.runInput(x), t);
const cmd = (p, t) => p.evaluate((x) => window.chess.runCommand(x), t);
const autoConfirm = (p) => p.evaluate(() => new MutationObserver(() => { const ov = document.querySelector('#overlay'); if (!ov.classList.contains('hidden')) ov.querySelector('.actions button.primary, .actions button.danger')?.click(); }).observe(document.querySelector('#overlay'), { attributes: true }));
const fileOf = () => [...gh.files.values()][0]?.text || '';

// 1. Ann creates a 3-days-per-move game kept in the repo
const annCtx = await person('Ann');
let ann = await page(annCtx);
await ann.check('#useGit');
await ann.fill('#gitRepo', 'ann/chess-games');
await ann.fill('#gitToken', 'tok-ann');
await ann.selectOption('#selColor', 'w');
await ann.selectOption('#selTc', 'd3');
await ann.click('#btnCreate');
await ann.waitForSelector('#game:not(.hidden)');
const invite = ann.url();
check('invite carries the repo after #', /#k=[\w-]{22}&s=[\w-]{22}&g=ann\/chess-games$/.test(invite), invite.split('#')[1]);
check('the game file is committed', gh.commits.length === 1 && gh.commits[0].author === 'ann');
check('encrypted by default: no names or moves in the repo', !/Ann|init|"t"/.test(fileOf()) && !/Ann/.test(gh.commits[0].message), gh.commits[0].message);
await ann.close();

// 2. Bob opens the link while Ann is offline, and claims Black
const bobCtx = await person('Bob');
let bob = await page(bobCtx, invite);
check('the invite screen names the repo', /ann\/chess-games/.test(await bob.innerText('#gitJoinNote')));
await bob.fill('#gitToken', 'tok-bob');
await bob.check('#gitRemember');
await bob.click('#btnJoin');
check('Bob loads the game from the repo, not from a peer', await until(async () => (await st(bob))?.w === 'Ann'));
check('Bob is offered the open seat', await until(() => bob.isVisible('#boardMsg button:has-text("Take the seat")')));
await bob.click('#boardMsg button:has-text("Take the seat")');
check('Bob\'s claim is committed while Ann is offline', await until(async () => gh.commits.length === 2 && gh.commits[1].author === 'bob'));
const s2 = await st(bob);
check('Bob plays Black, and White\'s 3 days have started', s2.me === 'b' && s2.deadline > Date.now() + 2.9 * 864e5);
await bob.close();

// 3. Ann comes back from her games list and moves
ann = await page(annCtx);
check('Ann\'s games list shows the game', await until(() => ann.isVisible('#pane-games:not(.hidden) .grow')));
check('… and says it is her move', /Your move/.test(await ann.innerText('#gamesList')), await ann.innerText('#gamesList'));
await ann.click('#gamesList button.primary');
check('a new tab with no token asks for it', await until(() => ann.isVisible('#askTok')));
await ann.fill('#askTok', 'tok-ann'); await ann.click('#overlay button.primary');
check('Ann sees Bob seated', await until(async () => (await st(ann))?.b === 'Bob' && (await st(ann)).me === 'w'));
await say(ann, 'e4');
check('e4 is committed by Ann', await until(() => gh.commits.length === 3 && gh.commits[2].author === 'ann'));
check('the day clock shows days', /\dd \d+h/.test(await ann.innerText('#barBot .clock')) || /\dd \d+h/.test(await ann.innerText('#barTop .clock')), await ann.innerText('#barTop .clock'));

// 4. Bob comes back later, replies; Ann's open page picks it up
bob = await page(bobCtx);
await until(() => bob.isVisible('#gamesList button.primary'));
await bob.click('#gamesList button.primary');
check('Bob sees e4', await until(async () => (await st(bob))?.ply === 1));
await say(bob, 'e5');
check('e5 is committed by Bob', await until(() => gh.commits.length === 4));
await cmd(ann, '/sync');
check('Ann\'s open page picks up e5 from the repo', await until(async () => (await st(ann)).ply === 2));

// 5. A race: Ann moves while Bob's page, not yet synced, offers a draw
await say(ann, 'Nf3');
await until(() => gh.commits.length === 5);
await bob.evaluate(() => { window.chess.S.git.etag = null; }); // Bob's page still holds the old sha
await cmd(bob, '/draw');
await new Promise((r) => setTimeout(r, 1500));
await cmd(ann, '/sync'); await cmd(bob, '/sync');
await new Promise((r) => setTimeout(r, 800));
const [ta, tb] = [await st(ann), await st(bob)];
const remote = await replay(JSON.parse(JSON.stringify(await ann.evaluate(() => window.chess.S.log))), { room: await ann.evaluate(() => window.chess.S.roomId) });
check('after a race both pages and the repo agree', ta.tip === tb.tip && remote.ok, `${ta.tip} ${tb.tip}`);
check('no commit was lost or doubled', gh.commits.length >= 5 && gh.commits.length <= 6, String(gh.commits.length));

// 6. A watcher with no token can follow but not play
const catCtx = await person('Cat');
const cat = await page(catCtx, invite);
await cat.click('#btnJoin');
check('a watcher with no token follows the game', await until(async () => (await st(cat))?.ply === ta.ply), await cat.innerText('#consoleOut').catch(() => '') + JSON.stringify(await st(cat)));
await cmd(cat, '/claim');
check('… and cannot take a seat', (await st(cat)).me === null);
check('… and is told it is watching only', /no token/.test(await cat.innerText('#status')));
check('… and is not prompted for a token or given a kept seat key', await cat.evaluate(() => document.querySelector('#overlay').classList.contains('hidden') && !Object.keys(localStorage).some((k) => k.startsWith('chess.gkey.'))));

// 7. Readable form: the history reads as the game
gh.files.clear(); const before = gh.commits.length;
const r1 = await page(annCtx);
await r1.check('#useGit'); await r1.fill('#gitRepo', 'ann/chess-games'); await r1.fill('#gitToken', 'tok-ann'); await r1.check('#gitRemember');
await r1.check('#gitReadable'); await r1.selectOption('#selColor', 'w'); await r1.selectOption('#selTc', 'd1');
await r1.click('#btnCreate'); await r1.waitForSelector('#game:not(.hidden)');
const r2 = await page(bobCtx, r1.url()); await r2.fill('#gitToken', 'tok-bob'); await r2.click('#btnJoin');
await until(() => r2.isVisible('#boardMsg button:has-text("Take the seat")')); await r2.click('#boardMsg button:has-text("Take the seat")');
await until(() => gh.commits.length === before + 2);
await cmd(r1, '/sync'); await until(async () => (await st(r1))?.b === 'Bob');
await say(r1, 'd4');
await until(() => gh.commits.length === before + 3);
const msgs = gh.commits.slice(before).map((c) => c.message);
check('readable commit messages', /Start: Ann plays White \(1 day per move\)/.test(msgs[0]) && /Bob takes Black/.test(msgs[1]) && /^1\. d4 \(Ann\)$/.test(msgs[2]), msgs.join(' | '));
check('readable file carries PGN and one event per line', /"pgn": ".*1\. d4/.test(fileOf()) && fileOf().split('\n').filter((l) => /^\s+\{"/.test(l)).length === 3);

// 8. A deadline passes: Ann's page, with its clock moved 25 hours ahead, records Black's loss on time;
//    Bob's page, on today's clock, refuses an event dated in its future.
await r1.close(); await r2.close();
const late = await annCtx.newPage();
await late.clock.install({ time: Date.now() + 25 * 3600e3 });
await late.goto(ORIGIN + '/?nosw');
await until(() => late.isVisible('#gamesList .grow'));
await late.locator('#gamesList .grow').first().locator('button').first().click();
check('a passed deadline is recorded as a loss on time', await until(async () => { await late.clock.runFor(500); return (await st(late))?.result?.reason === 'Black ran out of time'; }, 15000), JSON.stringify(await st(late)));
check('… and committed', await until(() => gh.commits.length === before + 4, 8000) && /ran out of time/.test(gh.commits.at(-1).message), gh.commits.at(-1).message);
const now = await page(bobCtx);
await until(() => now.isVisible('#gamesList .grow'));
await now.locator('#gamesList .grow').first().locator('button').first().click();
await until(async () => (await st(now))?.ply === 1);
await cmd(now, '/sync');
await new Promise((r) => setTimeout(r, 800));
check('a page whose clock says that event is in the future refuses it', !(await st(now)).result && /future/.test(await now.evaluate(() => document.querySelector('#consoleOut').textContent)));

check('only the page origin was contacted', [...hosts].every((h) => h === `localhost:${server.port}`), [...hosts].join(','));
await browser.close(); server.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
