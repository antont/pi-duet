# Supervisor window: plans and reviews, cannot edit or write.
# Usage:  .\bin\duet-sup.ps1  [extra pi args...]
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$env:DUET_ROLE = 'supervisor'
$model = if ($env:DUET_SUPERVISOR_MODEL) { $env:DUET_SUPERVISOR_MODEL } else { 'github-copilot/gpt-5.6-sol' }
$thinking = if ($env:DUET_SUPERVISOR_THINKING) { $env:DUET_SUPERVISOR_THINKING } else { 'high' }

pi -e (Join-Path $root 'mail\index.ts') `
   --exclude-tools edit,write `
   --model $model `
   --thinking $thinking `
   --append-system-prompt (Join-Path $root 'roles\supervisor-mail.md') `
   @args
