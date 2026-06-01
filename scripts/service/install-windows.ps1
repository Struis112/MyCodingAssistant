# MyCodingAssistant -- Windows Service installer (via NSSM)
#
# Why NSSM and not `sc.exe create` directly:
#   Windows Service Control Manager (SCM) requires every service process to
#   call SetServiceStatus() within 30 seconds. Plain node.exe doesn't speak
#   that protocol, so `sc.exe create binPath= "node start-prod.js"` ends with
#   the SCM timing out (Event Log id 7000 / 7009) and killing the process.
#   NSSM ("Non-Sucking Service Manager") is a tiny wrapper that registers
#   itself with SCM and runs our node command as a child process, restarting
#   it on crash and capturing its stdout/stderr to a log file.
#
# What this script registers:
#   binPath = <nssm.exe> -- and NSSM is configured to launch
#   Application      : node.exe
#   AppParameters    : apps\server\dist\start-prod.js
#   AppDirectory     : <repo root>
#   AppEnvironmentExtra : PORT, WEB_PORT, MCA_WEB_ORIGIN, MCA_WEB_DIR,
#                         MCA_PROJECT_ROOT, MCA_SUPERVISE_WEB=1,
#                         NODE_ENV=production
#   AppStdout/AppStderr : logs\mca.log (rotated by NSSM)
#   AppExit Default Restart, throttled
#
# Requires: PowerShell 5+, Administrator privileges, a prior `npm run build`,
# and `nssm.exe` reachable (we look in: PATH, common installer dirs, and
# .\tools\nssm\nssm.exe).
#
# Usage (from an *elevated* PowerShell at the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\service\install-windows.ps1
#
# Optional environment overrides before running:
#   $env:MCA_SERVICE_NAME    = "MyCodingAssistant"
#   $env:MCA_SERVICE_DISPLAY = "MyCodingAssistant"
#   $env:MCA_PORT            = "7641"
#   $env:MCA_WEB_PORT        = "7642"

$ErrorActionPreference = "Stop"

# ---- Config from env / defaults ----
$ServiceName    = if ($env:MCA_SERVICE_NAME)    { $env:MCA_SERVICE_NAME }    else { "MyCodingAssistant" }
$ServiceDisplay = if ($env:MCA_SERVICE_DISPLAY) { $env:MCA_SERVICE_DISPLAY } else { "MyCodingAssistant" }
$ApiPort        = if ($env:MCA_PORT)            { $env:MCA_PORT }            else { "7641" }
$WebPort        = if ($env:MCA_WEB_PORT)        { $env:MCA_WEB_PORT }        else { "7642" }

# ---- Admin check ----
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run from an elevated PowerShell. Right-click PowerShell -> Run as administrator, cd to this repo, then re-run."
    exit 1
}

# ---- Resolve repo + entrypoint ----
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$Entry    = Join-Path $RepoRoot "apps\server\dist\start-prod.js"
if (-not (Test-Path $Entry)) {
    Write-Error "Cannot find $Entry. Run ``npm run build`` from the repo root first."
    exit 1
}

# ---- Resolve node.exe ----
$NodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Error "node.exe is not on PATH. Install Node.js 22+ (e.g. via Volta) and re-run."
    exit 1
}
$Node = $NodeCmd.Source

# ---- Resolve nssm.exe ----
function Find-Nssm {
    # 1. PATH
    $cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    # 2. Bundled-in-repo (tools\nssm\nssm.exe), the recommended drop-in location.
    $local = Join-Path $RepoRoot "tools\nssm\nssm.exe"
    if (Test-Path $local) { return (Resolve-Path $local).Path }
    # 3. Common third-party install locations.
    $candidates = @(
        "C:\ProgramData\chocolatey\bin\nssm.exe",
        "C:\ProgramData\scoop\shims\nssm.exe",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\nssm.exe",
        "C:\Program Files\nssm\nssm.exe",
        "C:\Program Files (x86)\nssm\nssm.exe"
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    return $null
}

$Nssm = Find-Nssm
if (-not $Nssm) {
    Write-Host ""
    Write-Host "nssm.exe is not installed."
    Write-Host ""
    Write-Host "Install it with whichever package manager you have:"
    Write-Host "  winget install NSSM.NSSM"
    Write-Host "  choco  install nssm"
    Write-Host "  scoop  install nssm"
    Write-Host ""
    Write-Host "Or download manually from https://nssm.cc/download and place either"
    Write-Host "  $RepoRoot\tools\nssm\nssm.exe"
    Write-Host "or somewhere on your PATH. Then re-run this script."
    Write-Host ""
    Write-Error "nssm.exe not found."
    exit 1
}
Write-Host "Using NSSM at: $Nssm"

# ---- Logs directory ----
$LogDir   = Join-Path $RepoRoot "logs"
$StdoutLog = Join-Path $LogDir "mca.out.log"
$StderrLog = Join-Path $LogDir "mca.err.log"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# ---- Remove existing service of the same name (idempotent re-install) ----
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing service '$ServiceName'..."
    if ($existing.Status -ne "Stopped") {
        & $Nssm stop $ServiceName confirm | Out-Null
        Start-Sleep -Seconds 2
    }
    Write-Host "Removing existing service '$ServiceName'..."
    & $Nssm remove $ServiceName confirm | Out-Null
    Start-Sleep -Seconds 1
}

# ---- Install + configure via NSSM ----
Write-Host ""
Write-Host "Registering service:"
Write-Host "  Name        : $ServiceName"
Write-Host "  DisplayName : $ServiceDisplay"
Write-Host "  App         : $Node"
Write-Host "  Arguments   : $Entry"
Write-Host "  AppDirectory: $RepoRoot"
Write-Host "  API port    : $ApiPort   (env PORT)"
Write-Host "  Web port    : $WebPort   (env WEB_PORT, propagated to WebSupervisor)"
Write-Host "  Stdout log  : $StdoutLog"
Write-Host "  Stderr log  : $StderrLog"
Write-Host ""

# install <servicename> <app> [<args>]
& $Nssm install $ServiceName $Node $Entry | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "nssm install failed (exit $LASTEXITCODE)."; exit 1 }

# Friendly metadata in services.msc.
& $Nssm set $ServiceName DisplayName $ServiceDisplay      | Out-Null
& $Nssm set $ServiceName Description "MyCodingAssistant API server + supervised Next.js web (built from $RepoRoot)." | Out-Null
& $Nssm set $ServiceName Start SERVICE_AUTO_START         | Out-Null

# Working directory matches the repo root.
& $Nssm set $ServiceName AppDirectory $RepoRoot           | Out-Null

# Environment: NSSM takes one big string of "KEY=VALUE" pairs joined by `r`n.
# Listing each on its own line keeps the registry value readable.
$envBlock = (@(
    "PORT=$ApiPort",
    "WEB_PORT=$WebPort",
    "MCA_WEB_ORIGIN=http://localhost:$WebPort",
    "MCA_WEB_DIR=$(Join-Path $RepoRoot 'apps\web')",
    "MCA_PROJECT_ROOT=$RepoRoot",
    "MCA_SUPERVISE_WEB=1",
    "NODE_ENV=production"
) -join [char]13 + [char]10)
& $Nssm set $ServiceName AppEnvironmentExtra $envBlock    | Out-Null

# Stdout/stderr to files, with rotation (10 MB max, keep on restart).
& $Nssm set $ServiceName AppStdout $StdoutLog             | Out-Null
& $Nssm set $ServiceName AppStderr $StderrLog             | Out-Null
& $Nssm set $ServiceName AppStdoutCreationDisposition 4   | Out-Null  # OPEN_ALWAYS
& $Nssm set $ServiceName AppStderrCreationDisposition 4   | Out-Null
& $Nssm set $ServiceName AppRotateFiles 1                 | Out-Null
& $Nssm set $ServiceName AppRotateOnline 1                | Out-Null
& $Nssm set $ServiceName AppRotateBytes 10485760          | Out-Null  # 10 MB

# Restart policy: if the wrapped node exits with anything other than 0,
# restart after 5 s (throttled -- NSSM auto-backs off on rapid crashes).
& $Nssm set $ServiceName AppExit Default Restart          | Out-Null
& $Nssm set $ServiceName AppRestartDelay 5000             | Out-Null
& $Nssm set $ServiceName AppThrottle 10000                | Out-Null  # 10 s minimum lifetime

# Graceful shutdown: send Ctrl+Break, wait 8 s, then kill the tree.
& $Nssm set $ServiceName AppStopMethodConsole 8000        | Out-Null
& $Nssm set $ServiceName AppStopMethodWindow  8000        | Out-Null
& $Nssm set $ServiceName AppStopMethodThreads 8000        | Out-Null
& $Nssm set $ServiceName AppKillProcessTree 1             | Out-Null

Write-Host "Done. Useful commands:"
Write-Host "  Start now : Start-Service $ServiceName     (or: nssm start $ServiceName)"
Write-Host "  Stop      : Stop-Service  $ServiceName     (or: nssm stop  $ServiceName)"
Write-Host "  Status    : Get-Service   $ServiceName"
Write-Host "  Logs      : Get-Content -Wait $StdoutLog"
Write-Host "  Edit conf : nssm edit $ServiceName"
Write-Host ""
Write-Host "When the service is running, open http://localhost:$WebPort/"
Write-Host ""
Write-Host "Starting service now..."
Start-Service -Name $ServiceName
Start-Sleep -Seconds 4
$svc = Get-Service -Name $ServiceName
Write-Host "Status: $($svc.Status)"

if ($svc.Status -eq "Running") {
    Write-Host ""
    Write-Host "Service is up. Try: curl http://localhost:$ApiPort/health"
    Write-Host "Web UI:           http://localhost:$WebPort/"
} else {
    Write-Warning "Service did not reach Running state. Check the log files:"
    Write-Warning "  $StdoutLog"
    Write-Warning "  $StderrLog"
    Write-Warning "and the Application event log:"
    Write-Warning "  Get-EventLog Application -Source $ServiceName -Newest 20"
}
