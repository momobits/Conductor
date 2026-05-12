#Requires -Version 5.0
# Control hook: Stop (PowerShell port of stop-snapshot.sh).
# Fires after each Claude response completes.
# Per-turn snapshot into a rolling window -- mechanical insurance against slow drift.
# Cheap: only writes if STATE.md changed (length-check + SHA256 dedup).
#
# Restore from drift:
#   Copy-Item .control/snapshots/stop-<ts>.md .control/progress/STATE.md
#
# If Stop hook overhead becomes an issue, remove it and rely on PreCompact + SessionEnd only.
#
# Mirrors .claude/hooks/stop-snapshot.sh byte-for-byte in semantics. See
# .relay/issues/windows_powershell_hook_parity.md (I5.4) for the contract.

$ErrorActionPreference = 'Stop'

# Load retention config defensively (.control/config.sh is kind=project; older
# installs may not have CONTROL_STOP_SNAPSHOT_RETENTION_COUNT yet, so default
# in-script). M1 fix: tolerate unreadable config.sh.
$failOnError = $false
$retentionCount = 10
if (Test-Path '.control/config.sh') {
    Get-Content '.control/config.sh' -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_ -match '^CONTROL_STOP_SNAPSHOT_RETENTION_COUNT=(\d+)') { $retentionCount = [int]$Matches[1] }
        if ($_ -match '^CONTROL_FAIL_ON_HOOK_ERROR=true') { $failOnError = $true }
    }
}

try {
    $snapDir = '.control/snapshots'
    $stateFile = '.control/progress/STATE.md'

    if (-not (Test-Path $stateFile)) { exit 0 }   # `[ ! -f "$STATE_FILE" ] && exit 0`

    New-Item -ItemType Directory -Path $snapDir -Force | Out-Null

    # Skip if STATE.md content unchanged since the most recent stop snapshot.
    # Performance cherry-pick: length-check FIRST (cheap short-circuit when sizes
    # differ); only hash both files when lengths match (covers same-length-but-
    # different-content edits, e.g., flipping `phase=1` to `phase=2`).
    $newest = Get-ChildItem $snapDir -Filter 'stop-*.md' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($newest) {
        $stateLen = (Get-Item $stateFile).Length
        $newestLen = $newest.Length
        if ($stateLen -eq $newestLen) {
            $newHash = (Get-FileHash $stateFile -Algorithm SHA256).Hash
            $oldHash = (Get-FileHash $newest.FullName -Algorithm SHA256).Hash
            if ($newHash -eq $oldHash) { exit 0 }
        }
    }

    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $now = (Get-Date).ToUniversalTime()
    $ts  = $now.ToString('yyyyMMdd-HHmmss')
    $iso = $now.ToString('yyyy-MM-ddTHH:mm:ssZ')

    # M2 fix: -Force matches bash cp overwrite (timestamp-collision safe).
    Copy-Item $stateFile (Join-Path $snapDir "stop-$ts.md") -Force

    # I3.5 marker line (no `files=` clause -- single-file event).
    $markerLine = "$iso  stop  snapshot_id=$ts`n"
    [System.IO.File]::AppendAllText(
        (Join-Path $snapDir 'markers.log'),
        $markerLine,
        $utf8NoBom)

    # Bucketed prune (independent budget from PreCompact / SessionEnd global pool).
    $prune = Join-Path '.claude/hooks' 'prune-snapshots.ps1'
    if (Test-Path $prune) {
        try { & powershell -NoProfile -File $prune -Bucket stop -Count $retentionCount } catch { }
    }
}
catch {
    [Console]::Error.WriteLine("[control:Stop] ERROR: $_")
    if ($failOnError) { throw } else { exit 0 }
}
