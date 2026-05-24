// Phase 30.6 / Relay #58: moveWithAdvisory shared helper tests.
//
// Tests the orchestration logic of the helper used by BOTH drag-drop
// (board_dnd.ts) and keyboard move (board_keys.ts). The DOM-dependent
// dialog helpers (confirmTransition, chooseSubstrateAdvisory) are
// module-mocked so the helper can run under the 'node' vitest
// environment.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Module mocks MUST be declared before importing the module under test.
const confirmTransitionMock = vi.fn<() => Promise<boolean>>();
const chooseSubstrateAdvisoryMock = vi.fn<() => Promise<'keep' | 'wipe' | 'branch' | 'cancel'>>();

vi.mock('../../src/ui/lib/dialog.js', () => ({
  confirmTransition: (...args: unknown[]) => confirmTransitionMock(...args as []),
  chooseSubstrateAdvisory: (...args: unknown[]) => chooseSubstrateAdvisoryMock(...args as []),
}));

// Imported AFTER vi.mock so the mocked dialog module is wired in.
const { moveWithAdvisory } = await import('../../src/ui/views/move_with_advisory.js');

interface RpcCall { method: string; params: unknown }

function makeRpc(orphans: Array<{ runId: string; op: string }>) {
  const calls: RpcCall[] = [];
  const rpc = {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === 'find_orphaned_substrate') return { orphanedArtifacts: orphans };
      if (method === 'wipe_substrate') return { removedFiles: [] };
      if (method === 'branch_substrate') return { branchedRunIds: [], archiveDir: '' };
      if (method === 'transition') return { id: 'x', from: 'verifying', to: 'planned' };
      // Phase 30.11 / Relay #50: op_invoke is the post-transition chain
      // target. The handler returns the started-runId envelope shape
      // matching src/rpc/methods.ts op_invoke.
      if (method === 'op_invoke') return { runId: 'stub-run', status: 'started' };
      throw new Error(`Unexpected RPC method: ${method}`);
    }),
  };
  // Cast through unknown — the production RpcClient has more methods we
  // don't exercise here. Tests pass the same shape via this stub.
  return { rpc: rpc as unknown as Parameters<typeof moveWithAdvisory>[0]['rpc'], calls };
}

beforeEach(() => {
  confirmTransitionMock.mockReset();
  chooseSubstrateAdvisoryMock.mockReset();
});

describe('moveWithAdvisory — forward moves bypass advisory entirely', () => {
  it('forward drop does NOT call find_orphaned_substrate', async () => {
    const { rpc, calls } = makeRpc([]);
    confirmTransitionMock.mockResolvedValue(true);
    const onDone = vi.fn();
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'discovered', to: 'planned',
      policy: 'manual', onDone,
    });
    expect(calls.find((c) => c.method === 'find_orphaned_substrate')).toBeUndefined();
    expect(calls.find((c) => c.method === 'transition')).toBeDefined();
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe('moveWithAdvisory — backward moves without orphans skip the advisory dialog', () => {
  it('backward + 0 orphans → no advisory dialog; standard confirm + transition', async () => {
    const { rpc, calls } = makeRpc([]);
    confirmTransitionMock.mockResolvedValue(true);
    const onDone = vi.fn();
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'verifying', to: 'planned',
      policy: 'manual', onDone,
    });
    expect(calls.find((c) => c.method === 'find_orphaned_substrate')).toBeDefined();
    expect(chooseSubstrateAdvisoryMock).not.toHaveBeenCalled();
    expect(confirmTransitionMock).toHaveBeenCalledTimes(1);
    expect(calls.find((c) => c.method === 'transition')).toBeDefined();
  });
});

describe('moveWithAdvisory — backward moves with orphans open the advisory dialog', () => {
  it('Cancel from advisory dialog → no substrate op, no transition', async () => {
    const orphans = [{ runId: '20260524T120000-card-x', op: 'implement' }];
    const { rpc, calls } = makeRpc(orphans);
    chooseSubstrateAdvisoryMock.mockResolvedValue('cancel');
    const onDone = vi.fn();
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'verifying', to: 'planned',
      policy: 'manual', onDone,
    });
    expect(calls.filter((c) => c.method === 'wipe_substrate')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'branch_substrate')).toHaveLength(0);
    expect(calls.filter((c) => c.method === 'transition')).toHaveLength(0);
    expect(confirmTransitionMock).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('Wipe → wipe_substrate then transition, in that order, with from/to passed through', async () => {
    const orphans = [{ runId: '20260524T120000-card-x', op: 'implement' }];
    const { rpc, calls } = makeRpc(orphans);
    chooseSubstrateAdvisoryMock.mockResolvedValue('wipe');
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'verifying', to: 'planned',
      policy: 'manual', onDone: vi.fn(),
    });
    const ops = calls.map((c) => c.method);
    expect(ops).toEqual(['find_orphaned_substrate', 'wipe_substrate', 'transition']);
    const wipeCall = calls.find((c) => c.method === 'wipe_substrate')!;
    expect(wipeCall.params).toMatchObject({ cardId: 'card-x', from: 'verifying', to: 'planned' });
  });

  it('Branch → branch_substrate then transition', async () => {
    const orphans = [{ runId: '20260524T120000-card-x', op: 'implement' }];
    const { rpc, calls } = makeRpc(orphans);
    chooseSubstrateAdvisoryMock.mockResolvedValue('branch');
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'verifying', to: 'planned',
      policy: 'manual', onDone: vi.fn(),
    });
    expect(calls.map((c) => c.method)).toEqual([
      'find_orphaned_substrate', 'branch_substrate', 'transition',
    ]);
  });

  it('Keep → no substrate RPC; falls through to confirm + transition', async () => {
    const orphans = [{ runId: '20260524T120000-card-x', op: 'implement' }];
    const { rpc, calls } = makeRpc(orphans);
    chooseSubstrateAdvisoryMock.mockResolvedValue('keep');
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'verifying', to: 'planned',
      policy: 'manual', onDone: vi.fn(),
    });
    expect(calls.map((c) => c.method)).toEqual(['find_orphaned_substrate', 'transition']);
  });

  it('Substrate RPC failure aborts transition (transactional)', async () => {
    const orphans = [{ runId: '20260524T120000-card-x', op: 'implement' }];
    const calls: RpcCall[] = [];
    const rpc = {
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === 'find_orphaned_substrate') return { orphanedArtifacts: orphans };
        if (method === 'wipe_substrate') throw new Error('disk full');
        throw new Error(`Unexpected RPC method: ${method}`);
      }),
    };
    chooseSubstrateAdvisoryMock.mockResolvedValue('wipe');
    await moveWithAdvisory({
      rpc: rpc as unknown as Parameters<typeof moveWithAdvisory>[0]['rpc'],
      id: 'card-x', from: 'verifying', to: 'planned',
      policy: 'manual', onDone: vi.fn(),
    });
    expect(calls.find((c) => c.method === 'transition')).toBeUndefined();
    expect(confirmTransitionMock).not.toHaveBeenCalled();
  });
});

describe('moveWithAdvisory — confirm cancel aborts transition', () => {
  it('Cancel at confirmTransition → no transition RPC', async () => {
    const { rpc, calls } = makeRpc([]);
    confirmTransitionMock.mockResolvedValue(false);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'discovered', to: 'planned',
      policy: 'manual', onDone: vi.fn(),
    });
    expect(calls.find((c) => c.method === 'transition')).toBeUndefined();
  });
});

// Phase 30.11 / Relay #50: column-transition op triggering.
// After a successful forward transition, moveWithAdvisory chains
// engine ops per the brainstorm Decision 7 mapping. The tests below
// cover the policy gate, the directionality gate, the chain-on-failure
// stop semantics, and the empty-mapping fall-through.

describe('moveWithAdvisory — forward transition op triggering (Relay #50)', () => {
  it('auto + discovered→planned → chains op_invoke(analyze) after transition', async () => {
    const { rpc, calls } = makeRpc([]);
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'discovered', to: 'planned',
      policy: 'auto', onDone: vi.fn(),
    });
    const methods = calls.map((c) => c.method);
    // transition must precede op_invoke
    expect(methods.indexOf('transition')).toBeLessThan(methods.indexOf('op_invoke'));
    const opInvokeCalls = calls.filter((c) => c.method === 'op_invoke');
    expect(opInvokeCalls).toHaveLength(1);
    expect(opInvokeCalls[0]?.params).toEqual({ cardId: 'card-x', op: 'analyze' });
  });

  it('auto + approved→building → chains op_invoke(plan) then op_invoke(implement) in order', async () => {
    const { rpc, calls } = makeRpc([]);
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'approved', to: 'building',
      policy: 'auto', onDone: vi.fn(),
    });
    const opInvokeCalls = calls.filter((c) => c.method === 'op_invoke');
    expect(opInvokeCalls).toHaveLength(2);
    expect(opInvokeCalls[0]?.params).toEqual({ cardId: 'card-x', op: 'plan' });
    expect(opInvokeCalls[1]?.params).toEqual({ cardId: 'card-x', op: 'implement' });
  });

  it('assist + building→verifying → chains op_invoke(verify) after the post-confirm transition', async () => {
    const { rpc, calls } = makeRpc([]);
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'building', to: 'verifying',
      policy: 'assist', onDone: vi.fn(),
    });
    const opInvokeCalls = calls.filter((c) => c.method === 'op_invoke');
    expect(opInvokeCalls).toHaveLength(1);
    expect(opInvokeCalls[0]?.params).toEqual({ cardId: 'card-x', op: 'verify' });
  });

  it('manual + discovered→planned → commits move but NO op_invoke', async () => {
    const { rpc, calls } = makeRpc([]);
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'discovered', to: 'planned',
      policy: 'manual', onDone: vi.fn(),
    });
    expect(calls.find((c) => c.method === 'transition')).toBeDefined();
    expect(calls.find((c) => c.method === 'op_invoke')).toBeUndefined();
  });

  it('auto + planned→approved (canonical edge but no ops) → no op_invoke', async () => {
    const { rpc, calls } = makeRpc([]);
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'planned', to: 'approved',
      policy: 'auto', onDone: vi.fn(),
    });
    expect(calls.find((c) => c.method === 'transition')).toBeDefined();
    expect(calls.find((c) => c.method === 'op_invoke')).toBeUndefined();
  });

  it('auto + shipped→archived (canonical edge but no ops) → no op_invoke', async () => {
    const { rpc, calls } = makeRpc([]);
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'shipped', to: 'archived',
      policy: 'auto', onDone: vi.fn(),
    });
    expect(calls.find((c) => c.method === 'transition')).toBeDefined();
    expect(calls.find((c) => c.method === 'op_invoke')).toBeUndefined();
  });

  it('auto + backward (verifying→planned) with 0 orphans → no op_invoke (substrate-advisory owns backward)', async () => {
    const { rpc, calls } = makeRpc([]);
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc, id: 'card-x', from: 'verifying', to: 'planned',
      policy: 'auto', onDone: vi.fn(),
    });
    expect(calls.find((c) => c.method === 'transition')).toBeDefined();
    expect(calls.find((c) => c.method === 'op_invoke')).toBeUndefined();
  });

  it('transition rejected by server → no op_invoke chain', async () => {
    const calls: RpcCall[] = [];
    const rpc = {
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === 'find_orphaned_substrate') return { orphanedArtifacts: [] };
        if (method === 'transition') throw new Error('illegal transition');
        if (method === 'op_invoke') return { runId: 'stub', status: 'started' };
        throw new Error(`Unexpected RPC method: ${method}`);
      }),
    };
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc: rpc as unknown as Parameters<typeof moveWithAdvisory>[0]['rpc'],
      id: 'card-x', from: 'building', to: 'verifying',
      policy: 'auto', onDone: vi.fn(),
    });
    expect(calls.find((c) => c.method === 'op_invoke')).toBeUndefined();
  });

  it('first op in chain fails → halts chain (second op not invoked)', async () => {
    const calls: RpcCall[] = [];
    let opInvokeCount = 0;
    const rpc = {
      call: vi.fn(async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === 'find_orphaned_substrate') return { orphanedArtifacts: [] };
        if (method === 'transition') return { id: 'card-x', from: 'approved', to: 'building' };
        if (method === 'op_invoke') {
          opInvokeCount++;
          if (opInvokeCount === 1) throw new Error('cost-ceiling breach');
          return { runId: 'stub', status: 'started' };
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      }),
    };
    confirmTransitionMock.mockResolvedValue(true);
    await moveWithAdvisory({
      rpc: rpc as unknown as Parameters<typeof moveWithAdvisory>[0]['rpc'],
      id: 'card-x', from: 'approved', to: 'building',
      policy: 'auto', onDone: vi.fn(),
    });
    // Only the first op_invoke was attempted; second (implement) was not.
    const opInvokeCalls = calls.filter((c) => c.method === 'op_invoke');
    expect(opInvokeCalls).toHaveLength(1);
    expect(opInvokeCalls[0]?.params).toEqual({ cardId: 'card-x', op: 'plan' });
  });
});
