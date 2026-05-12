#Requires -Version 5.0
# Control helper: regenerate .control/progress/next.md from STATE.md.
# PowerShell port of regenerate-next-md.sh. Idempotent and side-effect-free.

$ErrorActionPreference = 'Continue'

$StateFile = '.control/progress/STATE.md'
$NextFile  = '.control/progress/next.md'

if (-not (Test-Path $StateFile)) {
    [Console]::Error.WriteLine("[regenerate-next-md] STATE.md not found at $StateFile -- skipping")
    exit 0
}

# Extract content of "## $label" section: returns lines after the heading
# until the next "## " heading or "---" separator (whichever comes first).
function Extract-StateSection($label) {
    $printing = $false
    $out = @()
    $heading = "## $label"
    foreach ($line in (Get-Content $StateFile)) {
        if ($line -eq $heading) { $printing = $true; continue }
        if ($printing -and $line -match '^## ') { break }
        if ($printing -and $line -eq '---') { break }
        if ($printing) { $out += $line }
    }
    return ($out -join "`n")
}

$ts = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$nextAction = Extract-StateSection 'Next action'
$notes      = Extract-StateSection 'Notes for next session'

if (-not $nextAction.Trim()) { $nextAction = '(See STATE.md "Next action" -- section missing or empty.)' }
if (-not $notes.Trim())      { $notes      = '(See STATE.md "Notes for next session" -- section missing or empty.)' }

$content = @"
# Next session kickoff

> Auto-generated from ``.control/progress/STATE.md`` at $ts by
> ``.claude/hooks/regenerate-next-md.ps1``. Edit STATE.md's "Next action"
> or "Notes for next session" to influence this prompt; **do not edit
> next.md by hand** -- it's overwritten on every session end.

This is a Control-managed project. Bootstrap protocol:

1. Read ``.control/progress/STATE.md`` -- the single source of truth.
2. Read the current phase's ``README.md`` and ``steps.md`` (path in STATE.md).
3. Check ``.control/issues/OPEN/`` for current-phase blockers.

If the SessionStart hook is installed, steps 1-3 run automatically and you
see a structured ``[control:state]`` block instead of doing them by hand.

## Next action
$nextAction

## Notes for next session
$notes
"@

# Normalize CRLF -> LF for parity with bash sibling
$content = $content -replace "`r`n", "`n"
[System.IO.File]::WriteAllText((Join-Path (Get-Location) $NextFile), $content)

[Console]::Error.WriteLine("[regenerate-next-md] wrote $NextFile from $StateFile at $ts")
