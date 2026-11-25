// ai.js — the optional, bounded, on-device language model.
//
// What it is for: the "fuzzy residue" that the deterministic grammar in intent.js cannot place, such as
// "get my horse out of danger" or "push the pawn next to my king". What it may do: pick exactly ONE item
// from a closed list that this file builds from the rules engine (the legal moves, the commands, or
// "none"). What it may not do: play a move, send a message, resign, see the network, or invent anything
// outside that list.
//
// The bounds, all enforced here and not by the model's good behaviour:
//   1. Closed output. Decoding is constrained by a JSON schema whose only field is an enum of the list.
//      If the runtime ignores the schema, the reply is still parsed and rejected unless it is in the list.
//   2. Re-validated. A chosen move is looked up again in the rules engine before it is offered.
//   3. Bounded effort. At most MAX_ATTEMPTS tries, MAX_TOKENS tokens each, temperature 0.
//   4. Proposal only. The result is shown as "Play Nf3?" and nothing happens until you confirm.
//   5. Narrowed when possible. If the grammar found candidates ("ambiguous"), the list is only those.
//   6. Local. The weights are downloaded once on an explicit click, then inference runs in this tab
//      (WebGPU). The prompt never leaves the device.
//   7. Advice-free. The model is never shown an evaluation, and is never asked which move is good.

import { describeMove } from './intent.js';

export const MAX_ATTEMPTS = 3;
export const MAX_TOKENS = 40;

// Only these models can be loaded (the library is given a config that lists nothing else).
// Sizes are the WebLLM catalogue's VRAM estimates. None of them has been evaluated on this task yet.
export const MODELS = [
  { id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 1.5B Instruct', size: '≈1.6 GB', note: 'default' },
  { id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen2.5 0.5B Instruct', size: '≈0.9 GB', note: 'smaller, faster, weaker' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 1B Instruct', size: '≈0.9 GB', note: '' },
];

// The hosts a model load contacts (declared in the egress table, and in the page's CSP).
export const MODEL_HOSTS = ['huggingface.co (weights, redirected to *.hf.co)', 'raw.githubusercontent.com (the compiled WebGPU model library)'];

export const COMMAND_CHOICES = {
  resign: 'resign the game',
  draw: 'offer or accept a draw',
  takeback: 'ask to take back the last move',
  flip: 'flip the board',
  hint: 'ask the local engine for a hint',
  describe: 'read out where the pieces are',
  new: 'start a new game',
};

export class BoundedAI {
  constructor({ loadLib } = {}) {
    this.loadLib = loadLib; // async () => web-llm module (hash-verified by the page)
    this.engine = null;
    this.modelId = null;
    this.trace = [];
  }

  get ready() { return !!this.engine; }

  static webgpuAvailable() { return typeof navigator !== 'undefined' && !!navigator.gpu; }

  async load(modelId, onProgress = () => {}) {
    if (!MODELS.some((m) => m.id === modelId)) throw new Error(`"${modelId}" is not on the allowed model list.`);
    if (!BoundedAI.webgpuAvailable()) throw new Error('This browser has no WebGPU, so the on-device model cannot run here. Everything else still works: the move grammar, the console and the local engine need no model.');
    const webllm = await this.loadLib();
    const model_list = webllm.prebuiltAppConfig.model_list.filter((m) => MODELS.some((x) => x.id === m.model_id));
    await this.unload();
    this.engine = await webllm.CreateMLCEngine(modelId, {
      appConfig: { ...webllm.prebuiltAppConfig, model_list },
      initProgressCallback: (p) => onProgress(p),
    });
    this.modelId = modelId;
  }

  async unload() {
    if (this.engine) { try { await this.engine.unload(); } catch {} }
    this.engine = null; this.modelId = null;
  }

  // Use an already-made engine (tests pass a fake with the same chat.completions.create shape).
  attach(engine, modelId = 'test') { this.engine = engine; this.modelId = modelId; }

  // Build the closed list of options for this position.
  static options(game, { candidates = null, commands = Object.keys(COMMAND_CHOICES) } = {}) {
    const moves = candidates || game.moves();
    const opts = moves.map((m) => ({ id: m.san, kind: 'move', move: m, text: describeMove(m) }));
    for (const c of commands) opts.push({ id: '/' + c, kind: 'command', command: c, text: COMMAND_CHOICES[c] });
    opts.push({ id: 'none', kind: 'none', text: 'none of these fits the instruction' });
    return opts;
  }

  static prompt(text, game, opts) {
    const side = game.turn === 'w' ? 'White' : 'Black';
    const sys = 'You map a chess player\'s instruction to exactly one option id from a fixed list. '
      + 'You do not judge whether a move is good. You do not explain. '
      + 'If the instruction names a piece, a square or an action, pick the option that matches it literally. '
      + 'If nothing in the list fits, pick "none". Reply with JSON only: {"choice":"<id>"}.';
    const list = opts.map((o) => `${o.id} = ${o.text}`).join('\n');
    const user = `Position (FEN): ${game.fen()}\nThe player is ${side}.\nOptions:\n${list}\n\nInstruction: "${String(text).slice(0, 300)}"`;
    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  // -> { kind: 'move' | 'command' | 'none', move?, command?, attempts, trace }
  async interpret(text, game, { candidates = null, commands } = {}) {
    if (!this.engine) throw new Error('No model is loaded.');
    const opts = BoundedAI.options(game, { candidates, commands });
    const ids = opts.map((o) => o.id);
    const schema = { type: 'object', properties: { choice: { type: 'string', enum: ids } }, required: ['choice'], additionalProperties: false };
    const messages = BoundedAI.prompt(text, game, opts);
    const trace = [];
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let reply = '';
      try {
        const r = await this.engine.chat.completions.create({
          messages, temperature: 0, max_tokens: MAX_TOKENS, stream: false,
          response_format: { type: 'json_object', schema: JSON.stringify(schema) },
        });
        reply = String(r?.choices?.[0]?.message?.content ?? '');
      } catch (e) {
        trace.push({ attempt, reply: '', verdict: 'runtime error: ' + (e?.message || e) });
        break;
      }
      const verdict = BoundedAI.check(reply, ids);
      trace.push({ attempt, reply: reply.slice(0, 200), verdict: verdict.ok ? 'accepted' : verdict.why });
      if (verdict.ok) {
        const o = opts.find((x) => x.id === verdict.choice);
        if (o.kind === 'move') {
          const again = game.find(o.move.uci); // bound 2: the rules engine has the last word
          if (!again) { trace.push({ attempt, reply: '', verdict: 'rejected: not legal on re-check' }); continue; }
          this.trace = trace;
          return { kind: 'move', move: again, attempts: attempt, trace };
        }
        this.trace = trace;
        return o.kind === 'command' ? { kind: 'command', command: o.command, attempts: attempt, trace } : { kind: 'none', attempts: attempt, trace };
      }
      messages.push({ role: 'assistant', content: reply.slice(0, 200) }, { role: 'user', content: `That is not valid (${verdict.why}). Reply with exactly {"choice":"<id>"} where <id> is one of the listed ids.` });
    }
    this.trace = trace;
    return { kind: 'none', attempts: trace.length, trace, why: `No valid answer after ${MAX_ATTEMPTS} attempts.` };
  }

  // Parse and validate a raw reply against the closed list. Exported for tests.
  static check(reply, ids) {
    let obj;
    const m = /\{[\s\S]*\}/.exec(reply);
    try { obj = JSON.parse(m ? m[0] : reply); } catch { return { ok: false, why: 'not JSON' }; }
    const choice = typeof obj?.choice === 'string' ? obj.choice.trim() : null;
    if (!choice) return { ok: false, why: 'no "choice" field' };
    if (!ids.includes(choice)) return { ok: false, why: `"${choice.slice(0, 20)}" is not in the list` };
    return { ok: true, choice };
  }
}
