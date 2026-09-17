# Worker window: implements, full tools.
# Usage:  .\bin\duet-wrk.ps1  [extra pi args...]
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$env:DUET_ROLE = 'worker'
$model = if ($env:DUET_WORKER_MODEL) { $env:DUET_WORKER_MODEL } else { 'github-copilot/claude-opus-5' }
$thinking = if ($env:DUET_WORKER_THINKING) { $env:DUET_WORKER_THINKING } else { 'medium' }

pi -e (Join-Path $root 'mail\index.ts') `
   --model $model `
   --thinking $thinking `
   --append-system-prompt (Join-Path $root 'roles\worker-mail.md') `
   @args
