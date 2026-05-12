#Requires -Version 5.0
# Control hook: PreCompact (PowerShell port of pre-compact-dump.sh).
# Fires BEFORE Claude Code compacts the conversation history to free context.
# Snapshots live state to disk so nothing is lost when context is compressed.
#
# Mirrors .claude/hooks/pre-compact-dump.sh byte-for-byte in semantics. See
# .relay/issues/windows_powershell_hook_parity.md (I5.2) for the contract.

$ErrorActionPreference = 'Stop'

# Honor CONTROL_FAIL_ON_HOOK_ERROR (config.sh tunable). M1 fix: tolerate
# unreadable config.sh -- never crash the session-start lifecycle.
$failOnError = $false
if (Test-Path '.control/config.sh') {
    Get-Content '.control/config.sh' -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_ -match '^CONTROL_FAIL_ON_HOOK_ERROR=true') { $failOnError = $true }
    }
}

try {
    $snapDir = '.control/snapshots'
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)   # cached encoder; LF + no BOM for markers.log
    $now = (Get-Date).ToUniversalTime()
    $ts  = $now.ToString('yyyyMMdd-HHmmss')                # matches `date -u +%Y%m%d-%H%M%S`
    $iso = $now.ToString('yyyy-MM-ddTHH:mm:ssZ')           # matches `date -u +%Y-%m-%dT%H:%M:%SZ`

    New-Item -ItemType Directory -Path $snapDir -Force | Out-Null

    # Snapshot the live progress files -- quietly skip missing ones.
    foreach ($f in 'STATE.md', 'journal.md', 'next.md') {
        $src = Join-Path '.control/progress' $f
        if (Test-Path $src) {
            $base = [IO.Path]::GetFileNameWithoutExtension($f)
            # M2 fix: -Force matches bash cp overwrite (timestamp-collision safe).
            Copy-Item $src (Join-Path $snapDir "precompact-$base-$ts.md") -Force
        }
    }

    # Append a marker line to the chronological event stream (I1.3 contract:
    # `<ISO8601>  <event>  snapshot_id=<TS>  ...`, two-space-separated, ASCII, LF).
    # Use [System.IO.File]::AppendAllText to bypass Add-Content's CRLF default.
    $markerLine = "$iso  precompact  snapshot_id=$ts  files=STATE.md,journal.md,next.md`n"
    [System.IO.File]::AppendAllText(
        (Join-Path $snapDir 'markers.log'),
        $markerLine,
        $utf8NoBom)

    # Trigger pruning (subprocess matches bash's `bash .claude/hooks/prune-snapshots.sh`).
    $prune = Join-Path '.claude/hooks' 'prune-snapshots.ps1'
    if (Test-Path $prune) {
        try { & powershell -NoProfile -File $prune } catch { }
    }

    [Console]::Error.WriteLine("[control:PreCompact] snapshot $ts written to $snapDir")
}
catch {
    [Console]::Error.WriteLine("[control:PreCompact] ERROR: $_")
    if ($failOnError) { throw } else { exit 0 }
}
