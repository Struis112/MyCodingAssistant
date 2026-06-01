# MyCodingAssistant — Windows Service uninstaller.
# Stops and deletes the service created by install-windows.ps1.
# Requires Administrator.

$ErrorActionPreference = "Stop"

$ServiceName = if ($env:MCA_SERVICE_NAME) { $env:MCA_SERVICE_NAME } else { "MyCodingAssistant" }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run from an elevated PowerShell."
    exit 1
}

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $svc) {
    Write-Host "Service '$ServiceName' is not installed; nothing to remove."
    exit 0
}

if ($svc.Status -ne "Stopped") {
    Write-Host "Stopping '$ServiceName'..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}

Write-Host "Deleting '$ServiceName'..."
& sc.exe delete $ServiceName | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "sc.exe delete failed (exit $LASTEXITCODE)."
    exit 1
}

Write-Host "Service '$ServiceName' removed."
