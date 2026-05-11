// Manual smoke test for ClaudeSubscriptionAdapter.
//
// Unit tests inject a fake CliRunner and never spawn the real `claude`
// binary. This script exercises the actual shell-out + JSON-parse path
// end-to-end. Run manually after CLI upgrades or when verifying that
// `claude login` is still valid.
//
// Prereqs:
//   - `claude` CLI on PATH (claude --version should work)
//   - `claude login` completed previously
//   - `npm run build` ran since the last edit to src/adapters/claude-subscription.ts
//
// Usage:
//   node scripts/smoke-claude-subscription.mjs

import { ClaudeSubscriptionAdapter } from '../dist/adapters/claude-subscription.js';

const adapter = new ClaudeSubscriptionAdapter();
const resp = await adapter.invoke({
  operation: 'smoke',
  model: 'claude-sub:haiku',
  system: 'Be terse. Output exactly the word: pong',
  user: 'ping',
});

console.log('text:    ', JSON.stringify(resp.text));
console.log('model:   ', resp.model);
console.log('tokens:  ', resp.inputTokens, '→', resp.outputTokens);

if (resp.text.toLowerCase().includes('pong')) {
  console.log('\nsmoke: ✓ pass');
  process.exit(0);
} else {
  console.error('\nsmoke: ✗ unexpected response');
  process.exit(1);
}
