export function parseRunParams(search, hash) {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  const get = (key) => fragment.has(key) ? fragment.get(key) : query.get(key);
  if (!fragment.has('run') && !query.has('run')) return null;
  const run = get('run');
  if (run !== 'analyze') throw new Error(`Unknown run=${run}.`);

  const pgn = get('pgn');
  const fen = get('fen');
  if ((pgn === null) === (fen === null)) throw new Error('run=analyze requires exactly one of pgn or fen.');

  const format = get('format') ?? 'PGN';
  if (!['PGN', 'FEN'].includes(format)) throw new Error('format must be PGN or FEN.');
  const download = get('download');
  if (download !== null && download !== '1') throw new Error('download must be 1 when specified.');
  return { run, pgn, fen, format, download: download === '1' };
}

export function makeTextArtifact(text, name, mime = 'text/plain') {
  const bytes = new TextEncoder().encode(text);
  const artifact = { mime, name, size: bytes.byteLength };
  let dataUrl;
  Object.defineProperty(artifact, 'dataUrl', {
    enumerable: true,
    get() {
      if (!dataUrl) {
        let binary = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        dataUrl = `data:${mime};base64,${btoa(binary)}`;
      }
      return dataUrl;
    },
  });
  return artifact;
}
