// Copies the third-party libraries into docs/lib/ and pins their SHA-256 in docs/lib/PINS.json and in
// docs/js/app.js (between /*PINS*/ and /*END-PINS*/). The page refuses to run a file whose hash differs.
//
// trystero-nostr.js and qrcode.js are the exact builds pinned by rtc-webCLI (same hashes), so the two
// tools run the same reviewed bytes. web-llm.js is @mlc-ai/web-llm's own ESM bundle, copied unchanged.
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const lib = path.join(root, 'docs/lib');
const webllmPkg = JSON.parse(await readFile(path.join(root, 'node_modules/@mlc-ai/web-llm/package.json'), 'utf8'));
await copyFile(path.join(root, 'node_modules/@mlc-ai/web-llm/lib/index.js'), path.join(lib, 'web-llm.js'));

const files = {
  'trystero-nostr.js': { version: '0.27.0', package: '@trystero-p2p/nostr', note: 'same build as rtc-webCLI' },
  'qrcode.js': { version: '1.5.2', package: 'qrcode-generator', note: 'same build as rtc-webCLI' },
  'web-llm.js': { version: webllmPkg.version, package: '@mlc-ai/web-llm', note: 'loaded only when you press Load model' },
};
const pins = {};
for (const [f, meta] of Object.entries(files)) {
  const sha256 = createHash('sha256').update(await readFile(path.join(lib, f))).digest('hex');
  pins[f] = { version: meta.version, sha256, package: meta.package };
  console.log(`${f}  ${meta.package}@${meta.version}  ${sha256}  (${meta.note})`);
}
await writeFile(path.join(lib, 'PINS.json'), JSON.stringify(pins, null, 2) + '\n');
const idx = path.join(root, 'docs/js/app.js');
try {
  const html = await readFile(idx, 'utf8');
  const next = html.replace(/\/\*PINS\*\/[\s\S]*?\/\*END-PINS\*\//, `/*PINS*/${JSON.stringify(pins)}/*END-PINS*/`);
  await writeFile(idx, next);
  console.log(next === html ? 'app.js pins already current' : 'app.js pins updated');
} catch { console.log('app.js not found yet; pins written to PINS.json only'); }
