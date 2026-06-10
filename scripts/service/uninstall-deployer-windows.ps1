# MyCodingAssistantDeployer -- Windows Service uninstaller.
#
# Mirror of uninstall-windows.ps1 but for the deployer service. Stops and
# removes the service; tries NSSM first, falls back to sc.exe.

$ErrorActionPreference = "Stop"

$ServiceName = if ($env:MCA_DEPLOYER_SERVICE_NAME) { $env:MCA_DEPLOYER_SERVICE_NAME } else { "MyCodingAssistantDeployer" }

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

$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$Nssm = $null
$cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
if ($cmd) { $Nssm = $cmd.Source }
elseif (Test-Path (Join-Path $RepoRoot "tools\nssm\nssm.exe")) {
    $Nssm = (Resolve-Path (Join-Path $RepoRoot "tools\nssm\nssm.exe")).Path
}

if ($svc.Status -ne "Stopped") {
    Write-Host "Stopping '$ServiceName'..."
    if ($Nssm) { & $Nssm stop $ServiceName confirm | Out-Null }
    else       { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

Write-Host "Removing '$ServiceName'..."
if ($Nssm) {
    & $Nssm remove $ServiceName confirm | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error "nssm remove failed (exit $LASTEXITCODE)."; exit 1 }
} else {
    & sc.exe delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Error "sc.exe delete failed (exit $LASTEXITCODE)."; exit 1 }
}

Write-Host "Service '$ServiceName' removed."
