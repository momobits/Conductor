import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon } from '../../src/daemon/index.js';
import { discoverDaemon } from '../../src/rpc/client.js';
import { readAuthToken } from '../../src/daemon/auth.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-phase4-e2e-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\nverify_command: "echo ok"\n',
    'utf8',
  );
  return repo;
}

describe('phase 4 end-to-end', () => {
  it('daemon up → JSON-RPC files a card → MCP transitions it → scan reflects it → daemon down', async () => {
    const repo = setupRepo();
    const handle = await startDaemon({ repo, port: 0 });
    try {
      // RPC client files a card
      const rpc = await discoverDaemon(repo);
      expect(rpc).toBeDefined();
      const created = (await rpc!.call('conductor.card_new', {
        slug: 'phase4-e2e', title: 'Phase 4 E2E', kind: 'feature',
      })) as { id: string };
      expect(created.id).toMatch(/-phase4-e2e$/);

      // MCP client transitions it
      const token = await readAuthToken(repo);
      const transport = new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      const mcp = new McpClient({ name: 'phase4-e2e', version: '0.0.0' }, { capabilities: {} });
      await mcp.connect(transport);
      try {
        const transitioned = await mcp.callTool({
          name: 'conductor.transition',
          arguments: { id: created.id, to: 'planned' },
        });
        const tResult = JSON.parse((transitioned.content as { type: string; text: string }[])[0].text);
        expect(tResult.to).toBe('planned');

        // RPC scan confirms the move
        const scan = (await rpc!.call('conductor.scan', {})) as { by_column: { planned: number } };
        expect(scan.by_column.planned).toBe(1);
      } finally {
        await mcp.close();
      }

      // Confirm endpoint files exist
      expect(existsSync(join(repo, '.conductor', 'mcp.endpoint'))).toBe(true);
      expect(existsSync(join(repo, '.conductor', 'daemon.endpoint'))).toBe(true);
      expect(existsSync(join(repo, '.conductor', 'auth.token'))).toBe(true);
    } finally {
      await handle.shutdown();
    }
  });
});
