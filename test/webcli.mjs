import assert from 'node:assert/strict';
import { parseRunParams, makeTextArtifact } from '../docs/js/webcli.js';

assert.equal(parseRunParams('', ''), null);
assert.deepEqual(
  parseRunParams('?pgn=old&run=analyze', '#&run=analyze&pgn=1.%20e4&format=FEN&download=1'),
  { run: 'analyze', pgn: '1. e4', fen: null, format: 'FEN', download: true },
);
assert.deepEqual(
  parseRunParams('', '#&run=analyze&fen=position'),
  { run: 'analyze', pgn: null, fen: 'position', format: 'PGN', download: false },
);
for (const [hash, pattern] of [
  ['#&run=unknown&pgn=x', /Unknown run/],
  ['#&run=analyze', /exactly one/],
  ['#&run=analyze&pgn=x&fen=y', /exactly one/],
  ['#&run=analyze&pgn=x&format=HTML', /format/],
  ['#&run=analyze&fen=x&download=yes', /download/],
]) assert.throws(() => parseRunParams('', hash), pattern);

const artifact = makeTextArtifact('1. e4 *', 'game.pgn', 'application/x-chess-pgn');
assert.equal(artifact.name, 'game.pgn');
assert.equal(artifact.size, 7);
assert.equal(artifact.mime, 'application/x-chess-pgn');
assert.equal(atob(artifact.dataUrl.split(',')[1]), '1. e4 *');
console.log('PASS  chess URL-run parser and PGN artifact');
