import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startDaemon, type DaemonHandle } from '../../src/daemon/index.js';
import { readAuthToken } from '../../src/daemon/auth.js';

function setupRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'conductor-mcp-'));
  mkdirSync(join(repo, '.conductor', 'cards'), { recursive: true });
  writeFileSync(
    join(repo, '.conductor', 'config.yaml'),
    'routing:\n  default: claude-sonnet-4-6\n',
    'utf8',
  );
  return repo;
}

describe('mcp_server', () => {
  let repo: string;
  let handle: DaemonHandle;
  let client: Client;

  beforeEach(async () => {
    repo = setupRepo();
    handle = await startDaemon({ repo, port: 0 });
    const token = await readAuthToken(repo);
    const transport = new StreamableHTTPClientTransport(new URL(`${handle.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    client = new Client({ name: 'test-client', version: '0.0.0' }, { capabilities: {} });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await handle.shutdown();
  });

  it('lists conductor.* tools', async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).toContain('conductor.card_new');
    expect(names).toContain('conductor.scan');
    expect(names).toContain('conductor.transition');
  });

  it('invokes conductor.card_new and round-trips card_get', async () => {
    const created = await client.callTool({
      name: 'conductor.card_new',
      arguments: { slug: 'mcp-test', title: 'MCP Test', kind: 'issue' },
    });
    const createdResult = JSON.parse((created.content as { type: string; text: string }[])[0].text);
    expect(createdResult.id).toMatch(/-mcp-test$/);

    const fetched = await client.callTool({
      name: 'conductor.card_get',
      arguments: { id: createdResult.id },
    });
    const fetchedResult = JSON.parse((fetched.content as { type: string; text: string }[])[0].text);
    expect(fetchedResult.frontmatter.title).toBe('MCP Test');
  });

  it('invokes conductor.scan and returns Status', async () => {
    const result = await client.callTool({ name: 'conductor.scan', arguments: {} });
    const r = JSON.parse((result.content as { type: string; text: string }[])[0].text);
    expect(r.by_column).toMatchObject({ discovered: 0 });
  });
});
