import { describe, it, expect } from 'vitest';
import { listToolNames } from '../../src/daemon/mcp_server.js';

describe('MCP server: Phase 6 tools', () => {
  it('exposes conductor.brain_start, brain_stop, brain_status, set_autonomy', () => {
    const names = listToolNames();
    expect(names).toContain('conductor.brain_start');
    expect(names).toContain('conductor.brain_stop');
    expect(names).toContain('conductor.brain_status');
    expect(names).toContain('conductor.set_autonomy');
  });
});
