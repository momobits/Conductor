#Requires -Version 5.0
# Control hook helper: prune old snapshots (PowerShell port of prune-snapshots.sh).
# Two forms:
#   - Arg-less (PreCompact + SessionEnd): global-pool prune. Excludes bucketed
#     snapshot prefixes (stop-*.md) which have separate retention budgets.
#   - Bucketed (Stop): prune-snapshots.ps1 -Bucket <name> -Count <N>
#     Keeps the N most-recent <name>-*.md files; ignores the global pool.
#
# Mirrors .claude/hooks/prune-snapshots.sh byte-for-byte in semantics. See
# .relay/issues/windows_powershell_hook_parity.md (I5.1) for the contract.

param(
    [string]$Bucket,
    [int]$Count
)

$ErrorActionPreference = 'SilentlyContinue'   # bash uses `|| true`; mirror non-fatal errors

$snapDir = '.control/snapshots'
if (-not (Test-Path $snapDir)) { exit 0 }    # `[ ! -d "$SNAP_DIR" ] && exit 0`

# Bucketed form: prune-snapshots.ps1 -Bucket <name> -Count <N>
if ($PSBoundParameters.ContainsKey('Bucket') -and $Count -gt 0) {
    Get-ChildItem $snapDir -Filter "$Bucket-*.md" |
        Sort-Object LastWriteTime -Descending |
        Select-Object -Skip $Count |
        Remove-Item -Force
    exit 0
}

# Global-pool form (arg-less; PreCompact + SessionEnd callers).
# Source config defensively for retention values.
$config = '.control/config.sh'
$retentionCount = 50      # CONTROL_SNAPSHOT_RETENTION_COUNT default
$retentionDays = 14       # CONTROL_SNAPSHOT_RETENTION_DAYS default
if (Test-Path $config) {
    Get-Content $config -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_ -match '^CONTROL_SNAPSHOT_RETENTION_COUNT=(\d+)') { $retentionCount = [int]$Matches[1] }
        if ($_ -match '^CONTROL_SNAPSHOT_RETENTION_DAYS=(\d+)')  { $retentionDays  = [int]$Matches[1] }
    }
}

# Days-based prune: delete *.md and *.flag older than $retentionDays
# (excludes bucketed stop-*.md per relay-config.md edge case).
$cutoff = (Get-Date).AddDays(-$retentionDays)
Get-ChildItem $snapDir -File |
    Where-Object {
        ($_.Name -like '*.md' -or $_.Name -like '*.flag') -and
        $_.LastWriteTime -lt $cutoff -and
        ($_.Name -notlike 'stop-*.md')
    } | Remove-Item -Force

# Count-based prune: keep the most-recent $retentionCount timestamped snapshots
# in the global pool (excludes bucketed stop-[0-9]* per `grep -v '/stop-[0-9]'`).
Get-ChildItem $snapDir -Filter '*-*.md' |
    Where-Object { $_.Name -notmatch '^stop-[0-9]' } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip $retentionCount |
    Remove-Item -Force
