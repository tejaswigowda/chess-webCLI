// Makes the README screenshots: a room in progress (two real pages over a mock relay) and the phone layout.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { startMockRelay } from './mock-relay.mjs';
const PORT = 18950;
const ORIGIN = `http://localhost:${PORT}`;
const until = async (fn, ms = 30000) => { const t0 = Date.now(); for (;;) { try { if (await fn()) return true; } catch {} if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 200)); } };
const server = spawn('node', ['server.js'], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const relay = await startMockRelay();
await until(async () => (await fetch(ORIGIN)).ok);
const exe = ['/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => existsSync(p));
const browser = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const open = async (name, url, vp = { width: 1360, height: 860 }) => {
  const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
  await ctx.addInitScript(({ name, relays }) => { if (!sessionStorage.getItem('chess.settings')) sessionStorage.setItem('chess.settings', JSON.stringify({ name, lan: true, relays, sounds: false })); }, { name, relays: relay.url });
  const p = await ctx.newPage(); await p.goto(url); return p;
};
const A = await open('Ann', ORIGIN + '/?nosw');
await A.selectOption('#selColor', 'w'); await A.selectOption('#selTc', '600+5'); await A.click('#btnCreate');
const B = await open('Bob', A.url());
await B.click('#btnJoin');
await until(() => B.evaluate(() => window.chess.S.st?.seats.b && window.chess.S.st.seats.b.keyId === window.chess.S.key.keyId));
const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6', 'd4', 'exd4', 'cxd4', 'Bb4+'];
for (let i = 0; i < moves.length; i++) {
  const p = i % 2 ? B : A;
  await until(() => p.evaluate((n) => window.chess.S.st.game.ply() === n, i));
  await p.evaluate((m) => window.chess.runInput(m), moves[i]);
}
await until(() => A.evaluate(() => window.chess.S.st.game.ply() === 12));
await B.evaluate(() => window.chess.runCommand('/chat the Møller attack? brave'));
await A.click('#tabChat');
await A.evaluate(() => window.chess.runCommand('/chat we will see 😄'));
await A.fill('#cmdIn', 'bishop blocks on d2');
await A.click('#cmdGo');
await A.mouse.move(2, 400); await A.waitForTimeout(600);
await A.screenshot({ path: 'docs/img/demo.png' });
const M = await open('Phone', ORIGIN + '/?nosw', { width: 390, height: 844 });
await M.selectOption('#selLevel', '2'); await M.click('#btnEngine');
for (const m of ['d4', 'c4', 'Nc3']) { await until(() => M.evaluate(() => window.chess.S.st.game.turn === 'w' && !window.chess.S.thinking)); await M.evaluate((x) => window.chess.runInput(x), m); }
await until(() => M.evaluate(() => window.chess.S.st.game.ply() === 6));
await M.screenshot({ path: 'docs/img/phone.png' });
await browser.close(); server.kill(); relay.close();
console.log('wrote docs/img/demo.png, docs/img/phone.png');
