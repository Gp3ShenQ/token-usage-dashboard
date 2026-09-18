param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('codex', 'claude')]
  [string]$Agent,

  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,

  [string]$WorkingDirectory,

  [string[]]$AgentArguments = @()
)

$tabKey = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$displayName = "$($Agent.Substring(0, 1).ToUpper() + $Agent.Substring(1)) · $tabKey"
$runnerPath = Join-Path $PSScriptRoot 'run-agent-session.ps1'
$argumentsJson = ConvertTo-Json -InputObject @($AgentArguments) -Compress
$argumentsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($argumentsJson))
$sessionId = $null
$resumeIndex = [Array]::IndexOf($AgentArguments, '--resume')
if ($resumeIndex -lt 0) {
  $resumeIndex = [Array]::IndexOf($AgentArguments, '-r')
}
if ($Agent -eq 'codex' -and $AgentArguments.Count -gt 1 -and $AgentArguments[0] -eq 'resume') {
  $resumeIndex = 0
}

if ($resumeIndex -ge 0 -and $resumeIndex + 1 -lt $AgentArguments.Count -and $AgentArguments[$resumeIndex + 1] -match '^[0-9a-f-]{8,}$') {
  $sessionId = $AgentArguments[$resumeIndex + 1]
}

if ($Agent -eq 'claude') {
  if (-not $sessionId -and $resumeIndex -lt 0) {
    $sessionId = [Guid]::NewGuid().ToString()
    $AgentArguments = @('--session-id', $sessionId) + $AgentArguments
    $argumentsJson = ConvertTo-Json -InputObject @($AgentArguments) -Compress
    $argumentsBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($argumentsJson))
  }
}

$wtArguments = @(
  '-w', '0', 'new-tab'
)
if ($WorkingDirectory) {
  $wtArguments += @('-d', $WorkingDirectory)
}
$wtArguments += @(
  '--title', $displayName,
  '--suppressApplicationTitle',
  'pwsh.exe', '-NoExit', '-File', $runnerPath,
  '-Agent', $Agent,
  '-ExecutablePath', $ExecutablePath,
  '-TabKey', $tabKey,
  '-AgentArgumentsBase64', $argumentsBase64
)
if ($sessionId) {
  $wtArguments += @('-SessionId', $sessionId)
}

& wt.exe @wtArguments
