#Requires -Version 5.0
# Control hook: SessionStart (PowerShell port of session-start-load.sh).
# Fires at the beginning of every Claude Code session.
#
# v2.0: data-only output. Emits structured [control:*] blocks for Claude to
# read; the runbook at .claude/commands/session-start.md tells Claude what
# to do with them. The "Before accepting user input, run the session-start
# protocol: 1. Read STATE.md ..." prose has moved into the runbook.
#
# Quadruplication contract: this hook + .sh sibling + runbook + slash command
# stay byte-equivalent on the [control:*] data blocks. Future changes update
# all four files in the same diff. tests/i5-parity.{sh,ps1} verifies parity.

$ErrorActionPreference = 'Continue'   # bash uses `|| true` per-command; mirror

$failOnError = $false
if (Test-Path '.control/config.sh') {
    Get-Content '.control/config.sh' -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_ -match '^CONTROL_FAIL_ON_HOOK_ERROR=true') { $failOnError = $true }
    }
}

try {
    # --- Git state capture ---
    $prevPref = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'

    $latestSnap = (Get-ChildItem '.control/snapshots' -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^(precompact-)?STATE-\d{8}-\d{6}\.md$' } |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
    if (-not $latestSnap) { $latestSnap = '' }

    $gitBranch = (& git rev-parse --abbrev-ref HEAD 2>$null)
    if (-not $gitBranch) { $gitBranch = 'not-a-git-repo' }

    & git rev-parse HEAD 2>$null | Out-Null
    $headOK = ($LASTEXITCODE -eq 0)
    if ($headOK) {
        $gitLast = (& git log -1 --oneline 2>$null)
        $gitLastSha = if ($gitLast) { ($gitLast -split ' ', 2)[0] } else { 'none' }
        $gitLastSubject = if ($gitLast -and ($gitLast -split ' ', 2).Count -gt 1) { ($gitLast -split ' ', 2)[1] } else { '' }
        & git diff-index --quiet HEAD -- 2>$null
        $diffExit = $LASTEXITCODE
        $porcelain = (& git status --porcelain 2>$null)
        $gitDirty = if (($diffExit -eq 0) -and (-not $porcelain)) { 'clean' } else { 'dirty' }
        $lastTag = (& git describe --tags --abbrev=0 2>$null)
        if (-not $lastTag) { $lastTag = 'none' }
    } else {
        $gitLastSha = 'none'
        $gitLastSubject = ''
        $gitDirty = 'n/a'
        $lastTag = 'none'
    }

    $ErrorActionPreference = $prevPref

    # --- Drift detection (mechanical compare against STATE.md) ---
    # Source-repo sentinel: if .control/.is-source-repo exists, skip ALL drift
    # checks. This is the Control framework's own dev repo where STATE.md is
    # intentionally template-shaped. The sentinel is gitignored so it never
    # propagates to consumer projects.
    $stateFile = '.control/progress/STATE.md'
    $sourceRepoSentinel = '.control/.is-source-repo'
    $driftBlocks = ''

    function Get-StateField($label) {
        if (-not (Test-Path $stateFile)) { return '' }
        $line = Select-String -Path $stateFile -Pattern "^- \*\*${label}:\*\*" -List | Select-Object -First 1
        if (-not $line) { return '' }
        return ($line.Line -replace "^- \*\*${label}:\*\* *", '' -replace "`r", '')
    }

    function Add-Drift {
        param($type, $body = '')
        if ($body) {
            $script:driftBlocks += "[control:drift]`ntype: ${type}`n${body}`n[/control:drift]`n`n"
        } else {
            $script:driftBlocks += "[control:drift]`ntype: ${type}`n[/control:drift]`n`n"
        }
    }

    if (Test-Path $sourceRepoSentinel) {
        # Control source/dev repo -- skip all drift checks
    }
    elseif (-not (Test-Path $stateFile)) {
        Add-Drift 'state-md-missing'
    }
    elseif (Select-String -Path $stateFile -Pattern '<short-sha>|<YYYY-MM-DD>|<sha>' -Quiet) {
        Add-Drift 'state-md-template'
    }
    else {
        $stateBranch     = Get-StateField 'Branch'
        $stateLastCommit = Get-StateField 'Last commit'
        $stateUncomm     = Get-StateField 'Uncommitted changes'
        $stateLastTagRaw = Get-StateField 'Last phase tag'

        if (-not $stateBranch -and -not $stateLastCommit -and -not $stateUncomm -and -not $stateLastTagRaw) {
            Add-Drift 'state-md-unparseable'
        }
        else {
            $stateLastTag = ($stateLastTagRaw -replace '`', '').Split(' ')[0]

            if ($stateBranch -and ($stateBranch -ne $gitBranch)) {
                Add-Drift 'branch-mismatch' "expected: $stateBranch`nactual: $gitBranch"
            }
            if ($stateLastCommit -and $gitLastSha -and ($gitLastSha -ne 'none') -and (-not $stateLastCommit.Contains($gitLastSha))) {
                # Self-reference exception: /session-end commits STATE.md as
                # `docs(state): session end ...`, so HEAD becomes that commit
                # while STATE.md still references its parent (the last work
                # commit it summarized). That's the expected post-/session-end
                # shape, not drift. Suppress when HEAD's subject matches AND
                # HEAD's parent short SHA appears in STATE.md's "Last commit".
                $selfRefOk = $false
                if ($gitLastSubject -match '^docs\(state\): session end') {
                    $parentSha = (& git rev-parse --short 'HEAD~1' 2>$null)
                    if ($parentSha -and $stateLastCommit.Contains($parentSha)) {
                        $selfRefOk = $true
                    }
                }
                if (-not $selfRefOk) {
                    Add-Drift 'commit-mismatch' "expected: $stateLastCommit`nactual: $gitLastSha $gitLastSubject"
                }
            }
            if (($stateUncomm -eq 'none') -and ($gitDirty -ne 'clean')) {
                Add-Drift 'uncommitted-mismatch' "expected: none`nactual: $gitDirty"
            }
            if ($stateLastTag -and ($stateLastTag -ne $lastTag)) {
                Add-Drift 'tag-mismatch' "expected: $stateLastTag`nactual: $lastTag"
            }
        }
    }

    # --- Lightweight validation checks (v2.0 / cycle 5d / C.4) ---
    # Fast file-existence and filesystem-coherence checks beyond drift detection.
    # Emits zero or more [control:validate] blocks. Skipped when source-repo
    # sentinel present (template-shape STATE.md has placeholder cursor values).
    function Add-Validate {
        param($severity, $check, $detail)
        $script:driftBlocks += "[control:validate]`nseverity: ${severity}`ncheck: ${check}`ndetail: ${detail}`n[/control:validate]`n`n"
    }

    if (-not (Test-Path $sourceRepoSentinel) -and (Test-Path $stateFile)) {
        # Check: phase-plan.md exists
        if (-not (Test-Path '.control/architecture/phase-plan.md')) {
            Add-Validate 'warning' 'phase-plan-missing' '.control/architecture/phase-plan.md not found -- run /bootstrap or author manually'
        }

        # Check: cursor phase dir resolves
        # "Current phase" is a top-level bold field (not a `- **` bullet),
        # so use direct regex instead of Get-StateField (which targets bullets).
        $cursorPhase = ''
        $cpLine = Select-String -Path $stateFile -Pattern '^\*\*Current phase:\*\*' -List | Select-Object -First 1
        if ($cpLine) {
            $cursorPhase = ($cpLine.Line -replace '^\*\*Current phase:\*\* *', '' -replace "`r", '')
        }
        if ($cursorPhase -and $cursorPhase -ne 'not-yet-defined') {
            $phaseMatch = [regex]::Match($cursorPhase, '^[0-9]+')
            if ($phaseMatch.Success) {
                $phaseNum = $phaseMatch.Value
                $phaseDirs = Get-ChildItem -Directory -Path '.control/phases' -Filter "phase-${phaseNum}-*" -ErrorAction SilentlyContinue
                if (-not $phaseDirs) {
                    Add-Validate 'error' 'phase-dir-missing' "STATE.md cursor phase=${phaseNum} but no .control/phases/phase-${phaseNum}-*/ directory exists"
                }
            }
        }
    }
    # --- End validation checks ---

    # --- Emit data blocks ---
    $snapDisplay = if ($latestSnap) { $latestSnap } else { 'none' }

    $output = @"
[control:SessionStart]

[control:state]
branch: $gitBranch
last-commit-sha: $gitLastSha
last-commit-subject: $gitLastSubject
working-tree: $gitDirty
last-tag: $lastTag
[/control:state]

[control:snapshot]
latest-precompact: $snapDisplay
[/control:snapshot]

"@

    # Normalize CRLF -> LF for byte parity with bash sibling.
    # PS here-strings drop the trailing newline of the line before "@, so the
    # bash heredoc's final blank line (producing \n\n) becomes \n in PS. Add
    # the missing \n explicitly to keep parity.
    $output = ($output -replace "`r`n", "`n") + "`n"
    [Console]::Out.Write($output)

    if ($driftBlocks) {
        # driftBlocks already uses LF line endings (built with `n)
        [Console]::Out.Write($driftBlocks)
    }

    $tail = @"
-> Follow .claude/commands/session-start.md to bootstrap. Read STATE.md and
the current phase docs, narrate the status from the [control:state] data
above (plain English, not the raw block), surface any [control:drift] as a
narrative warning, and propose the next action. Wait for operator go before
editing code.

"@
    $tail = $tail -replace "`r`n", "`n"
    [Console]::Out.Write($tail)
}
catch {
    [Console]::Error.WriteLine("[control:SessionStart] ERROR: $_")
    if ($failOnError) { throw } else { exit 0 }
}
