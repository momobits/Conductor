<!-- Filled example issue. See .control/templates/issue.md for the skeleton. -->
<!-- Archetype: a CLI tool processing episodic session data. Treat this as a shape reference, not a content source. -->

# ISSUE-2026-02-03-state-atomic-write

**Severity:** major
**Discovered:** 2026-02-03
**Phase/step:** 2.4
**Status:** resolved
**Tags:** `phase:2-blocker`

## Symptom

State file truncated and unparseable after a mid-save interrupt. Resume raises:

```
[2026-02-03T14:22:10Z ERROR] cli.resume: InvalidStateError: unexpected EOF reading state: expected 14 sections, got 7
Traceback (most recent call last):
  File "cli/resume.py", line 21, in resume
    state = load_state(workspace)
  File "state/load.py", line 48, in load_state
    return _parse_sections(data)
  File "state/load.py", line 112, in _parse_sections
    raise InvalidStateError(f"expected {expected} sections, got {got}")
  triggered by: python -m cli.resume --workspace /home/alice/ws-17
```

The resume path aborts; the operator sees the traceback; no partial state is recovered. A second resume attempt raises identically because the file on disk is still truncated.

## Repro

1. Start a long-running session in workspace `/home/alice/ws-17` (PID 48291).
2. Wait until the session enters a save cycle — observable in logs as `state.persist: begin` (a save takes ~200 ms on an NVMe SSD).
3. Inject interrupt mid-write: `kill -TERM 48291` during the save window.
4. Run `python -m cli.resume --workspace /home/alice/ws-17`.
5. Observe traceback ending in `InvalidStateError: unexpected EOF reading state: expected 14 sections, got 7`.
6. `cat` the state file — truncated at a mid-record boundary; file size ~60% of expected.

Reproduced 4 consecutive times; 0 false negatives. Also reproduced with `kill -INT` (same outcome) and `kill -KILL` (same outcome). Not signal-specific — the bug is the in-place write, not the signal handling.

## Hypothesis

Initial guess: the save path opens the file with `open(state_path, 'w')` (which truncates), then streams writes via the file object's `write()` method — so an interrupt between the truncate syscall and `close()` leaves the file at whatever byte count was flushed. Verified via `strace` on the save cycle — confirmed the `O_WRONLY|O_TRUNC` syscall followed by streamed `write()` calls before the signal landed.

**Ruled out: partial-disk-full** — `df -h` and `dmesg` show no ENOSPC at the time of the interrupt. Disk was 41% full.

**Ruled out: concurrent editor collision** — fresh workspace, single process, no editor open. `lsof` during the save window shows only the CLI process holding the file.

**Ruled out: filesystem-specific bug** — reproduced on ext4, xfs, and APFS. Not filesystem-dependent.

## Resolution

- **Fix commit:** `e7c1f90` — adopt write-to-tmp-then-rename pattern. Writer opens `state.md.tmp` in the same directory, streams the full payload, calls `os.fsync()` on the file descriptor, then `os.rename('state.md.tmp', 'state.md')`. POSIX guarantees the rename is atomic on a single filesystem; a mid-write interrupt leaves the old `state.md` intact and the tmp file abandoned.
- **Regression test:** `tests/test_state_atomic_write.py::test_interrupt_during_save` — spawns the save path in a subprocess, injects `SIGTERM` at a controlled mid-write breakpoint (via `ptrace`), and asserts the on-disk file is either the pre-save content or the post-save content — never truncated. Runs 50 iterations to shake out timing sensitivity.
- **Diff summary:** `state/save.py` — replaced in-place write (30 lines) with tmp-rename pattern (38 lines); added `os.fsync()` before `os.rename()`. `state/load.py` unchanged. Added startup cleanup pass on import that removes stale `*.tmp` files (covers the "tmp written, rename never reached" case).

## Post-close notes

- 2026-02-09: Behavior drifted on network-mounted filesystems (NFSv3 export) — `rename` is not atomic over NFS when client and server are both writing. Filed follow-up ISSUE-2026-02-09-nfs-rename-atomicity; current mitigation is to detect NFS at startup and fall back to a lock-file strategy. The original fix holds for all local filesystems; NFS is a distinct issue with a different root cause (cross-host state-machine race, not single-host interrupt).
