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
