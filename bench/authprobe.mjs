/**
 * Auth probe — the one fact the design could not confirm from docs.
 *
 * The task-success runner is built on @anthropic-ai/claude-agent-sdk and is
 * meant to ride the human's existing Claude Code credentials rather than a
 * separate ANTHROPIC_API_KEY. Whether the SDK inherits those credentials is not
 * stated in the docs, so it is MEASURED here before anything is built on it.
 *
 * Run: node bench/authprobe.mjs
 * It deletes ANTHROPIC_API_KEY (and the other key-shaped vars) from its own
 * env, then issues one trivial query with every tool withheld.
 *
 * Exit 0 = the SDK authenticated with no API key. Exit 1 = it needs one.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';

for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']) {
  if (process.env[k]) console.log(`unsetting ${k} (was set)`);
  delete process.env[k];
}
console.log('ANTHROPIC_API_KEY in child env:', JSON.stringify(process.env.ANTHROPIC_API_KEY));

const q = query({
  prompt: 'Reply with exactly the word: PONG. Nothing else.',
  options: {
    model: 'claude-sonnet-5',
    systemPrompt: 'You are a test probe. Answer in one word.',
    settingSources: [],
    allowedTools: [],
    disallowedTools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch',
      'WebSearch', 'NotebookEdit', 'TodoWrite', 'Task'],
    permissionMode: 'dontAsk',
    maxTurns: 2,
    env: { ...process.env, ANTHROPIC_API_KEY: undefined },
  },
});

let text = '';
let result = null;
try {
  for await (const m of q) {
    if (m.type === 'assistant') {
      for (const b of m.message.content) if (b.type === 'text') text += b.text;
    }
    if (m.type === 'result') result = m;
  }
} catch (e) {
  console.error('QUERY THREW:', e?.message ?? e);
  process.exit(1);
}

console.log('assistant text:', JSON.stringify(text.trim()));
console.log('result subtype:', result?.subtype);
console.log('is_error:', result?.is_error);
console.log('total_cost_usd:', result?.total_cost_usd);
console.log('modelUsage:', JSON.stringify(result?.modelUsage, null, 2));

if (result && !result.is_error && /PONG/i.test(text)) {
  console.log('\nAUTH OK — the SDK authenticated with NO ANTHROPIC_API_KEY.');
  process.exit(0);
}
console.log('\nAUTH FAILED — the SDK did not complete a query without an API key.');
process.exit(1);
