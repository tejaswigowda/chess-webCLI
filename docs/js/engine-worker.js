// Runs the local engine off the main thread, so the board stays responsive while it thinks.
// It receives a FEN and a level, and posts back one result. It has no network access of its own to use:
// it imports only ./engine.js and ./chess.js from this site.
import { search } from './engine.js';
self.onmessage = (e) => {
  const { id, fen, level, seed, history } = e.data || {};
  try { self.postMessage({ id, ok: true, result: search(fen, { level, seed, history }) }); }
  catch (err) { self.postMessage({ id, ok: false, error: String(err && err.message || err) }); }
};
