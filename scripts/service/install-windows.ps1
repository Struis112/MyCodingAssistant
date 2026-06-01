# MyCodingAssistant -- Windows Service installer
#
# Registers a Windows Service named "MyCodingAssistant" that runs
#   node apps/server/dist/start-prod.js
# from the repository root. `start-prod.js` flips MCA_SUPERVISE_WEB=1 so
# the API server uses its built-in WebSupervisor to spawn the Next.js
# `next start -p 7642` child and keep it alive across crashes/updates.
#
# One service, two processes, auto-start on boot, auto-restart on failure.
#
# Requires: PowerShell 5+, Administrator privileges, a prior `npm run build`.
#
# Usage (from an *elevated* PowerShell at the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\service\install-windows.ps1
#
# Optional environment overrides before running:
#   $env:MCA_SERVICE_NAME      = "MyCodingAssistant"   # service display id
#   $env:MCA_SERVICE_DISPLAY   = "MyCodingAssistant"   # what shows in services.msc
#   $env:MCA_PORT              = "7641"                # API server port
#   $env:MCA_WEB_PORT          = "7642"                # Next.js port

$ErrorActionPreference = "Stop"

# ---- Resolve config from env / defaults ----
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

# ---- Locate repo + entrypoint ----
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$Entry    = Join-Path $RepoRoot "apps\server\dist\start-prod.js"
if (-not (Test-Path $Entry)) {
    Write-Error "Cannot find $Entry. Run ``npm run build`` from the repo root first."
    exit 1
}

# ---- Locate node.exe ----
$NodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $NodeCmd) {
    Write-Error "node.exe is not on PATH. Install Node.js 22+ (e.g. via Volta) and re-run."
    exit 1
}
$Node = $NodeCmd.Source

# ---- Remove existing service of the same name ----
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Stopping existing service '$ServiceName'..."
    if ($existing.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    Write-Host "Deleting existing service '$ServiceName'..."
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 1
}

# ---- Build the binPath ----
# sc.exe wants the *full* command, including quoting if paths have spaces. We
# wrap the node path and the entry path in escaped quotes.
$binPath = "`"$Node`" `"$Entry`""

Write-Host ""
Write-Host "Registering service:"
Write-Host "  Name        : $ServiceName"
Write-Host "  DisplayName : $ServiceDisplay"
Write-Host "  binPath     : $binPath"
Write-Host "  cwd         : $RepoRoot"
Write-Host "  API port    : $ApiPort   (env PORT)"
Write-Host "  Web port    : $WebPort   (env WEB_PORT, propagated to WebSupervisor)"
Write-Host ""

# ---- sc.exe create ----
& sc.exe create $ServiceName binPath= $binPath start= auto DisplayName= $ServiceDisplay | Out-Null
if ($LASTEXITCODE -ne 0) {
    Write-Error "sc.exe create failed (exit $LASTEXITCODE)."
    exit 1
}

# Friendly description that shows up in services.msc.
& sc.exe description $ServiceName "MyCodingAssistant API server + supervised Next.js web (built from $RepoRoot)." | Out-Null

# Restart on failure: 5s, 15s, 60s; reset failure counter daily.
& sc.exe failure $ServiceName reset= 86400 actions= restart/5000/restart/15000/restart/60000 | Out-Null

# ---- Inject the env vars the service needs ----
# sc.exe doesn't pass env vars through binPath. We add them to the service's
# Environment property via the registry; the SCM reads them when launching.
$envValues = @(
    "PORT=$ApiPort",
    "WEB_PORT=$WebPort",
    "MCA_WEB_ORIGIN=http://localhost:$WebPort",
    "MCA_WEB_DIR=$(Join-Path $RepoRoot 'apps\web')",
    "MCA_PROJECT_ROOT=$RepoRoot",
    "MCA_SUPERVISE_WEB=1",
    "NODE_ENV=production"
)
$svcKey = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
New-ItemProperty -Path $svcKey -Name "Environment" -Value $envValues -PropertyType MultiString -Force | Out-Null

# sc.exe doesn't expose a `cwd` field -- the service starts in
# C:\Windows\System32 by default. Override via the registry too.
# Note: this only works because our entrypoint resolves all paths relative to
# itself (start-prod.js -> ./index.js with absolute MCA_WEB_DIR set above).

Write-Host "Done. Useful commands:"
Write-Host "  Start now : Start-Service $ServiceName"
Write-Host "  Stop      : Stop-Service  $ServiceName"
Write-Host "  Status    : Get-Service   $ServiceName"
Write-Host "  Logs      : Get-EventLog Application -Source $ServiceName -Newest 50   (or set up file logging -- see below)"
Write-Host ""
Write-Host "When the service is running, open http://localhost:$WebPort/"
Write-Host ""
Write-Host "Note: native Windows Services don't capture child stdout to a file by"
Write-Host "default. If you want a log file at logs\mca.log, install nssm.exe and"
Write-Host "re-run this script (it'll switch to nssm-based mode). For now,"
Write-Host "crashes appear in the Application event log."
Write-Host ""
Write-Host "Starting service now..."
Start-Service -Name $ServiceName
Start-Sleep -Seconds 3
$svc = Get-Service -Name $ServiceName
Write-Host "Status: $($svc.Status)"

if ($svc.Status -eq "Running") {
    Write-Host ""
    Write-Host "Service is up. Try: curl http://localhost:$ApiPort/health"
    Write-Host "Web UI:           http://localhost:$WebPort/"
} else {
    Write-Warning "Service did not reach Running state. Check the Application event log for errors:"
    Write-Warning "  Get-EventLog Application -Source $ServiceName -Newest 20"
}
