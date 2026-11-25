// store.js against the mock API: create, load, ETag, conflict, encryption, readable form, bad token.
import http from 'node:http';
import { GitStore, decodeFile, defaultPath } from '../docs/js/store.js';
import { mockGitHub } from './mock-github.mjs';
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const gh = mockGitHub();
const srv = http.createServer((req, res) => gh.handle(req, res, req.url)).listen(0);
const api = `http://127.0.0.1:${srv.address().port}`;
const secret = crypto.getRandomValues(new Uint8Array(16));
const path = await defaultPath(secret);
check('default path says nothing about the room', /^chess-webCLI\/[0-9a-f]{16}\.json$/.test(path), path);
const mk = (o = {}) => new GitStore({ repo: gh.repo, path, token: 'tok-ann', secret, api, ...o });
const a = mk(), b = mk({ token: 'tok-bob' });
const ev = [{ t: 'init', i: 0, secret: 'e2e4' }];
check('a missing file is a new game', (await a.load()).events.length === 0);
await a.save(ev, 'start');
const r = await b.load();
check('the other player loads it', r.events.length === 1);
check('encrypted by default: no plaintext in the repo', !gh.files.get(path).text.includes('e2e4') && !gh.files.get(path).text.includes('init'));
check('an unchanged file answers 304', (await b.load()).changed === false);
await b.save([...ev, { i: 1 }], 'bob');
let conflict = false; try { await a.save([...ev, { i: 1, other: true }], 'ann'); } catch (e) { conflict = e.conflict; }
check('a write based on an old version is refused as a conflict', conflict);
await a.load(); await a.save([...ev, { i: 1 }, { i: 2 }], 'ann after merge');
check('after reloading, the write goes through', gh.commits.length === 3 && gh.commits.at(-1).author === 'ann');
let wrong = ''; try { await decodeFile(gh.files.get(path).text, { secret: new Uint8Array(16) }); } catch (e) { wrong = e.message; }
check('another link cannot decrypt it', /could not be decrypted/.test(wrong));
const pr = new GitStore({ repo: gh.repo, path: 'games/readable.json', token: 'tok-ann', secret, api, readable: true });
await pr.load(); await pr.save([{ i: 0, t: 'init' }, { i: 1, t: 'move', uci: 'e2e4' }], '1. e4 (Ann)', { pgn: '1. e4 *' });
const text = gh.files.get('games/readable.json').text;
check('readable form: one event per line, with PGN', text.split('\n').some((l) => l.trim().startsWith('{"i":1')) && /"pgn": "1. e4 \*"/.test(text), text);
const anon = new GitStore({ repo: gh.repo, path, secret, api });
check('anyone can follow a public repo without a token', (await anon.load()).events.length === 3);
let noTok = ''; try { await anon.save([], 'x'); } catch (e) { noTok = e.message; }
check('writing needs a token', /token is needed/.test(noTok));
const bad = new GitStore({ repo: gh.repo, path, secret, api, token: 'nope' }); await bad.load();
let badMsg = ''; try { await bad.save([], 'x'); } catch (e) { badMsg = e.message; }
check('a bad token is explained', /401/.test(badMsg), badMsg);
let noRepo = ''; try { await new GitStore({ repo: 'x/y', path, secret, api }).load(); } catch (e) { noRepo = e.message; }
check('a missing repo is explained', /404/.test(noRepo), noRepo);
let badPath = ''; try { new GitStore({ repo: gh.repo, path: '../etc.json', secret, api }); } catch (e) { badPath = e.message; }
check('path traversal is refused', /relative path/.test(badPath));
srv.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
