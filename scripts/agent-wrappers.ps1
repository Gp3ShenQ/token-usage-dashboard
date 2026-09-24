# Dot-source this file from your PowerShell profile:
#   . "<repo>\scripts\agent-wrappers.ps1"
# It wraps interactive `codex` / `claude` so each session opens in a managed Windows Terminal tab.

$tokenUsageDashboardWrapper = Join-Path $PSScriptRoot 'start-agent-session.ps1'

function Resolve-AgentExecutable([string]$Name) {
  # Application lookup skips the wrapper functions below, avoiding recursion.
  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  return $null
}

$codexExecutable = Resolve-AgentExecutable 'codex'
$claudeExecutable = Resolve-AgentExecutable 'claude'

if ($codexExecutable) {
  function codex {
    & $tokenUsageDashboardWrapper -Agent codex -ExecutablePath $codexExecutable -AgentArguments $args
  }
}

if ($claudeExecutable) {
  function claude {
    & $tokenUsageDashboardWrapper -Agent claude -ExecutablePath $claudeExecutable -AgentArguments $args
  }
}
