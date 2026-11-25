// The model layer's bounds, checked with scripted fake models (no WebGPU needed).
import { BoundedAI, MAX_ATTEMPTS } from '../docs/js/ai.js';
import { Chess } from '../docs/js/chess.js';
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const fake = (replies) => { let i = 0; const calls = []; return { calls, chat: { completions: { create: async (req) => { calls.push(req); return { choices: [{ message: { content: replies[Math.min(i++, replies.length - 1)] } }] }; } } } }; };

const g = new Chess();
{
  const ai = new BoundedAI(); const f = fake(['{"choice":"Nf3"}']); ai.attach(f);
  const r = await ai.interpret('get the horse out on the king side', g);
  check('valid choice becomes a proposal', r.kind === 'move' && r.move.san === 'Nf3' && r.attempts === 1);
  const req = f.calls[0];
  const schema = JSON.parse(req.response_format.schema);
  check('decoding is constrained to the closed list', schema.properties.choice.enum.length === 20 + 7 + 1, String(schema.properties.choice.enum.length));
  check('temperature 0 and a token cap', req.temperature === 0 && req.max_tokens <= 40);
  check('the prompt carries no evaluation', !/eval|score|centipawn|best move/i.test(req.messages.map((m) => m.content).join(' ').replace('You do not judge whether a move is good', '')));
}
{
  const ai = new BoundedAI(); const f = fake(['Qh5!!', '{"choice":"Qxf7"}', '{"choice":"e4"}']); ai.attach(f);
  const r = await ai.interpret('attack', g);
  check('invented and illegal answers are rejected, then a valid one accepted', r.kind === 'move' && r.move.san === 'e4' && r.attempts === 3, JSON.stringify(r.trace));
}
{
  const ai = new BoundedAI(); const f = fake(['{"choice":"Ke2"}']); ai.attach(f);
  const r = await ai.interpret('anything', g);
  check(`gives up after ${MAX_ATTEMPTS} attempts`, r.kind === 'none' && f.calls.length === MAX_ATTEMPTS);
}
{
  const ai = new BoundedAI(); const f = fake(['{"choice":"Nh3"}']); ai.attach(f);
  const cands = g.moves().filter((m) => m.piece === 'N' && m.from === 'g1');
  const r = await ai.interpret('the knight, the safe one', g, { candidates: cands, commands: [] });
  const ids = JSON.parse(f.calls[0].response_format.schema).properties.choice.enum;
  check('ambiguous: the list is narrowed to the grammar\'s candidates', ids.join(',') === 'Nf3,Nh3,none' && r.move.san === 'Nh3', ids.join(','));
}
{
  const ai = new BoundedAI(); const f = fake(['{"choice":"/resign"}']); ai.attach(f);
  const r = await ai.interpret('i am done', g);
  check('a command comes back as a command (the page asks before acting on it)', r.kind === 'command' && r.command === 'resign');
}
{
  const ai = new BoundedAI();
  let threw = ''; try { await ai.load('some-other-model'); } catch (e) { threw = e.message; }
  check('models outside the allowed list are refused', /not on the allowed model list/.test(threw));
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
