# Launches the unpacked build and waits for the backend (including better-sqlite3) to start.
param(
  [string]$AppDirectory = 'release\win-unpacked',
  [int]$TimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
$exe = Get-ChildItem -Path $AppDirectory -Filter '*.exe' -File | Where-Object { $_.Name -notlike 'elevate*' } | Select-Object -First 1
if (-not $exe) { throw "No executable found in $AppDirectory" }

$startedAt = Get-Date
$process = Start-Process -FilePath $exe.FullName -PassThru
try {
  $deadline = $startedAt.AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { throw "App exited early with code $($process.ExitCode)" }
    $log = Get-ChildItem -Path $env:APPDATA -Filter 'startup.log' -File -Recurse -Depth 1 -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $startedAt } | Select-Object -First 1
    if ($log -and (Select-String -Path $log.FullName -Pattern 'backend ready' -SimpleMatch -Quiet)) {
      Write-Host "Smoke test passed: $($log.FullName)"
      Get-Content $log.FullName
      exit 0
    }
    Start-Sleep -Seconds 2
  }
  if ($log) { Get-Content $log.FullName }
  throw "Backend did not report ready within $TimeoutSeconds seconds"
} finally {
  Get-Process -Id $process.Id -ErrorAction SilentlyContinue | Stop-Process -Force
  Get-Process -Name $exe.BaseName -ErrorAction SilentlyContinue | Stop-Process -Force
}
