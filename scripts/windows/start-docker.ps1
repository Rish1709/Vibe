# Starts Docker Desktop on Windows builds where stale unix-socket files cannot be deleted.
#
# Symptom: Docker Desktop fails with
#   "listening on unix://.../dockerInference: remove ...: The file cannot be accessed by the system."
# On some Windows Insider builds, AF_UNIX socket files can't be deleted once their owner exits
# (Win32 error 1920), and Docker Desktop deletes and recreates its sockets on every start.
# Renaming the parent folder still works, so this script moves the socket folders aside and starts
# Docker with fresh, empty ones.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\windows\start-docker.ps1

$ErrorActionPreference = 'Stop'

Get-Process -Name 'Docker Desktop', 'com.docker.backend', 'com.docker.build' -ErrorAction SilentlyContinue |
  Stop-Process -Force
Start-Sleep -Seconds 3

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$socketDirs = @("$env:LOCALAPPDATA\Docker\run", "$env:LOCALAPPDATA\docker-secrets-engine")
foreach ($dir in $socketDirs) {
  if ((Test-Path $dir) -and @(Get-ChildItem -Force $dir).Count -gt 0) {
    Rename-Item -LiteralPath $dir -NewName ((Split-Path $dir -Leaf) + ".stale-$stamp")
    New-Item -ItemType Directory -Path $dir | Out-Null
    Write-Host "Moved aside stale sockets in $dir"
  }
}

Start-Process 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 3
  docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Host 'Docker engine is up.'
    exit 0
  }
}
Write-Error 'Docker engine did not start within 3 minutes. Check Docker Desktop for errors.'
