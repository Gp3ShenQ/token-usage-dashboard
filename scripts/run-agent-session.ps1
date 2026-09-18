param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('codex', 'claude')]
  [string]$Agent,

  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{8}$')]
  [string]$TabKey,

  [string]$SessionId,
  [string]$AgentArgumentsBase64 = 'W10='
)

$bindingDir = Join-Path $env:LOCALAPPDATA 'TokenUsageDashboard\session-bindings'
$sessionRoot = if ($Agent -eq 'codex') {
  Join-Path $env:USERPROFILE '.codex\sessions'
} else {
  Join-Path $env:USERPROFILE '.claude\projects'
}

function Get-AgentArguments {
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($AgentArgumentsBase64))
    return @($json | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    return @()
  }
}

function Get-SessionFiles {
  if (-not (Test-Path -LiteralPath $sessionRoot)) {
    return @()
  }

  return @(Get-ChildItem -LiteralPath $sessionRoot -Recurse -File -Filter '*.jsonl' -ErrorAction SilentlyContinue)
}

function Get-SessionId([System.IO.FileInfo]$File) {
  if ($Agent -eq 'claude') {
    return [System.IO.Path]::GetFileNameWithoutExtension($File.Name)
  }

  try {
    $metadata = Get-Content -LiteralPath $File.FullName -TotalCount 1 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    return [string]($metadata.payload.session_id ?? $metadata.payload.id)
  } catch {
    return $null
  }
}

function Save-SessionBinding([string]$ResolvedSessionId) {
  if ([string]::IsNullOrWhiteSpace($ResolvedSessionId)) {
    return
  }

  New-Item -ItemType Directory -Path $bindingDir -Force | Out-Null
  [pscustomobject]@{
    agent = $Agent
    sessionId = $ResolvedSessionId
    createdAt = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $bindingDir "$TabKey.json") -Encoding utf8
}

$agentArguments = Get-AgentArguments
$knownFiles = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in Get-SessionFiles) {
  [void]$knownFiles.Add($file.FullName)
}

if ($SessionId) {
  Save-SessionBinding $SessionId
}

$startParams = @{
  FilePath = $ExecutablePath
  WorkingDirectory = (Get-Location).Path
  NoNewWindow = $true
  PassThru = $true
}
if ($agentArguments.Count -gt 0) {
  $startParams.ArgumentList = $agentArguments
}
$process = Start-Process @startParams
$deadline = [DateTime]::UtcNow.AddSeconds(45)

while (-not $process.HasExited) {
  if (-not $SessionId -and [DateTime]::UtcNow -lt $deadline) {
    $newFiles = @(Get-SessionFiles | Where-Object { -not $knownFiles.Contains($_.FullName) })
    if ($newFiles.Count -eq 1) {
      $candidateId = Get-SessionId $newFiles[0]
      if ($candidateId) {
        $SessionId = $candidateId
        Save-SessionBinding $SessionId
      }
    }
  }

  Start-Sleep -Milliseconds 150
  $process.Refresh()
}

exit $process.ExitCode
