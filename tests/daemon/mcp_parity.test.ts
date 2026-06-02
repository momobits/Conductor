// Parity guard: every RPC method in the registry must be EITHER exposed as an
// MCP tool OR explicitly listed as intentionally-excluded. This makes MCP
// coverage a deliberate choice — a new RPC method that is neither exposed nor
// excluded fails this test, so the surface can never silently drift again
// (the audit found ~26/42 methods exposed with no guard).

import { describe, it, expect } from 'vitest';
import { methods, type MethodName } from '../../src/rpc/methods.js';
import { MCP_TOOLS, INTENTIONALLY_NOT_MCP_TOOLS } from '../../src/daemon/mcp_server.js';

// The method each tool dispatches to: explicit methodName, else the tool name
// with the 'conductor.' namespace stripped (mirrors mcp_server's dispatch).
function toolMethodNames(): Set<string> {
  return new Set(
    MCP_TOOLS.map((t) => t.methodName ?? t.name.replace('conductor.', '')),
  );
}

describe('MCP ↔ RPC parity', () => {
  const registry = Object.keys(methods) as MethodName[];
  const exposed = toolMethodNames();

  it('every MCP tool maps to a real RPC method', () => {
    const orphanTools = [...exposed].filter((m) => !(m in methods));
    expect(orphanTools, `MCP tools referencing non-existent methods: ${orphanTools.join(', ')}`).toEqual([]);
  });

  it('every RPC method is either an MCP tool or intentionally excluded', () => {
    const uncovered = registry.filter(
      (m) => !exposed.has(m) && !INTENTIONALLY_NOT_MCP_TOOLS.has(m),
    );
    expect(
      uncovered,
      `These RPC methods are neither exposed as MCP tools nor in INTENTIONALLY_NOT_MCP_TOOLS. ` +
        `Add each to the MCP TOOLS list or to the exclusion set (with a reason): ${uncovered.join(', ')}`,
    ).toEqual([]);
  });

  it('exclusion set only names real methods (no stale entries)', () => {
    const stale = [...INTENTIONALLY_NOT_MCP_TOOLS].filter((m) => !(m in methods));
    expect(stale, `Stale entries in INTENTIONALLY_NOT_MCP_TOOLS: ${stale.join(', ')}`).toEqual([]);
  });

  it('a tool and the exclusion set never overlap', () => {
    const overlap = [...exposed].filter((m) => INTENTIONALLY_NOT_MCP_TOOLS.has(m as MethodName));
    expect(overlap, `Methods both exposed and excluded: ${overlap.join(', ')}`).toEqual([]);
  });
});
