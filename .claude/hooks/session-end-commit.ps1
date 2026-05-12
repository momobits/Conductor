#Requires -Version 5.0
# Control hook: SessionEnd (PowerShell port of session-end-commit.sh).
# Fires when a Claude Code session ends (user quits or session closed).
# Final safety net -- snapshot state, warn about uncommitted changes.
#
# Does NOT auto-commit or auto-update STATE.md -- those are work for the
# /session-end command (runs before this hook, in the active session).
# This hook only snapshots what's on disk at the moment of shutdown.
#
# Mirrors .claude/hooks/session-end-commit.sh byte-for-byte in semantics. See
# .relay/issues/windows_powershell_hook_parity.md (I5.3) for the contract.

$ErrorActionPreference = 'Stop'

$failOnError = $false
if (Test-Path '.control/config.sh') {
    Get-Content '.control/config.sh' -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_ -match '^CONTROL_FAIL_ON_HOOK_ERROR=true') { $failOnError = $true }
    }
}

try {
    $snapDir = '.control/snapshots'
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $now = (Get-Date).ToUniversalTime()
    $ts  = $now.ToString('yyyyMMdd-HHmmss')
    $iso = $now.ToString('yyyy-MM-ddTHH:mm:ssZ')

    New-Item -ItemType Directory -Path $snapDir -Force | Out-Null

    # Snapshot state files
    foreach ($f in 'STATE.md', 'journal.md', 'next.md') {
        $src = Join-Path '.control/progress' $f
        if (Test-Path $src) {
            $base = [IO.Path]::GetFileNameWithoutExtension($f)
            Copy-Item $src (Join-Path $snapDir "sessionend-$base-$ts.md") -Force
        }
    }

    # Append a marker line (parallel to PreCompact)
    $markerLine = "$iso  sessionend  snapshot_id=$ts  files=STATE.md,journal.md,next.md`n"
    [System.IO.File]::AppendAllText(
        (Join-Path $snapDir 'markers.log'),
        $markerLine,
        $utf8NoBom)

    # Record whether the working tree was clean at shutdown (only if HEAD exists).
    # M4 cherry-pick: git invocations wrapped in try/finally so $ErrorActionPreference
    # always restores even on Win32Exception.
    $dirtyFlag = Join-Path $snapDir "sessionend-dirty-$ts.flag"
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        & git rev-parse HEAD 2>$null | Out-Null
        $headOK = ($LASTEXITCODE -eq 0)
        if ($headOK) {
            & git diff-index --quiet HEAD -- 2>$null
            $diffExit = $LASTEXITCODE
            $porcelain = (& git status --porcelain 2>$null)
            if ($diffExit -ne 0 -or $porcelain) {
                $statusShort = (& git status --short 2>$null)
                $statusJoined = if ($statusShort) { ($statusShort -join "`n") } else { '' }
                $dirtyContent = "Session ended with uncommitted changes.`n" + `
                    "Session ended at: $iso`n`n" + `
                    "--- git status ---`n" + `
                    "$statusJoined`n"
                [System.IO.File]::WriteAllText($dirtyFlag, $dirtyContent, $utf8NoBom)
                [Console]::Error.WriteLine("[control:SessionEnd] WARNING: session ended with uncommitted changes -- see $dirtyFlag")
            }
        }
    }
    finally {
        $ErrorActionPreference = $prevPref
    }

    # Regenerate next.md from STATE.md (v2.0 / cycle 5c / C.3) -- safety net
    # so next.md never falls out of sync if /session-end didn't refresh it.
    $regen = Join-Path '.claude/hooks' 'regenerate-next-md.ps1'
    if (Test-Path $regen) {
        try { & powershell -NoProfile -File $regen } catch { }
    }

    # Prune old snapshots
    $prune = Join-Path '.claude/hooks' 'prune-snapshots.ps1'
    if (Test-Path $prune) {
        try { & powershell -NoProfile -File $prune } catch { }
    }

    [Console]::Error.WriteLine("[control:SessionEnd] snapshot $ts written to $snapDir")
}
catch {
    [Console]::Error.WriteLine("[control:SessionEnd] ERROR: $_")
    if ($failOnError) { throw } else { exit 0 }
}
