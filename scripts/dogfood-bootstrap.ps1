# Bootstrap a fresh repo for autonomous Conductor dogfood.
# Idempotent: re-runnable to add missing pieces without clobbering state.
#
# Usage:
#   .\scripts\dogfood-bootstrap.ps1 [-Repo path-to-repo]

param(
    [string]$Repo = "."
)

$here = $PSScriptRoot
$cli = Join-Path $here "..\dist\cli\index.js"

if (-not (Test-Path $cli)) {
    Write-Error "Conductor CLI not built. Run 'npm run build' first."
    exit 1
}

Set-Location $Repo

if (-not (Test-Path .conductor)) {
    node $cli init
}

if (-not (Test-Path .conductor\config.yaml)) {
    Copy-Item (Join-Path $here "..\examples\minimal\.conductor\config.yaml") .conductor\config.yaml
    Write-Output "wrote .conductor/config.yaml from examples/minimal"
}

# Discover cards from existing TODO/FIXME comments (best-effort)
& node $cli discover 2>$null
if (-not $?) { Write-Output "(discover failed; continuing)" }

# Order them
& node $cli order 2>$null
if (-not $?) { Write-Output "(order failed; continuing)" }

# Start the daemon
$daemon = Start-Process node `
    -ArgumentList $cli,"daemon","start","--port","7180" `
    -PassThru -NoNewWindow

# Wait for daemon endpoint
for ($i = 0; $i -lt 5; $i++) {
    if (Test-Path .conductor\daemon.endpoint) { break }
    Start-Sleep -Seconds 1
}

$endpoint = if (Test-Path .conductor\daemon.endpoint) { Get-Content .conductor\daemon.endpoint } else { "?" }

@"

Conductor dogfood ready. Open: $endpoint/

Brain control: conductor brain start
Cost:          conductor cost show
Run logs:      conductor run list

Press Ctrl-C to stop the daemon.
"@

Wait-Process -Id $daemon.Id
