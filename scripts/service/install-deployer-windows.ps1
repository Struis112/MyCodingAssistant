# MyCodingAssistantDeployer -- Windows Service installer (via NSSM)
#
# Failure-domain isolation: the deployer runs as its OWN Windows service,
# SEPARATE from MyCodingAssistant (the API + web). That's load-bearing.
# If the AI breaks the API/web, the deployer is what rolls them back to
# `live` -- so the rollback path can't share a failure domain with the
# thing it rolls back. See docs/architecture/self-healing-deploy.md, esp.
# the "Why a separate process" subsection.
#
# What this service does:
#   - Polls the `staging` git ref for new commits (CommitTrigger).
#   - On a new commit, runs the build -> validate -> activate -> verify gate
#     across BOTH children (api + web), in that order.
#   - Promotes the new commit to `live` on success.
#   - Rolls back to `live` on any failure (and hands the logs to the AI repair
#     loop -- stubbed today, real impl is Phase 3).
#
# NSSM registration:
#   App           : node.exe
#   AppParameters : node_modules\tsx\dist\cli.mjs apps\server\src\start-deployer.ts
#                   (we run from source -- the deployer is small and rarely
#                    changes, so the dev-cost of a build step isn't worth the
#                    isolation benefits here)
#   AppDirectory  : <repo root>
#   AppEnvironmentExtra:
#       PORT, WEB_PORT             -- so the deployer probes the right ports
#       MCA_PROJECT_ROOT           -- repo location
#       MCA_SERVICE_NAME           -- the API service it bounces on activate
#       MCA_NSSM_PATH              -- absolute path to nssm.exe
#       MCA_LIVE_REF, MCA_STAGING_REF
#       MCA_DEPLOY_INCLUDE_API=1   -- Phase 4 on by default
#       USERPROFILE/HOMEDRIVE/HOMEPATH (same reason as the API installer)
#
# Requires: PowerShell 5+, Administrator privileges, `npm install` already ran
# (we use the bundled tsx), and `nssm.exe` reachable.
#
# Usage (elevated PowerShell, from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\service\install-deployer-windows.ps1

$ErrorActionPreference = "Stop"

# ---- Config from env / defaults ----
$ServiceName    = if ($env:MCA_DEPLOYER_SERVICE_NAME)    { $env:MCA_DEPLOYER_SERVICE_NAME }    else { "MyCodingAssistantDeployer" }
$ServiceDisplay = if ($env:MCA_DEPLOYER_SERVICE_DISPLAY) { $env:MCA_DEPLOYER_SERVICE_DISPLAY } else { "MyCodingAssistant Deployer" }
$ApiPort        = if ($env:MCA_PORT)        { $env:MCA_PORT }        else { "7641" }
$WebPort        = if ($env:MCA_WEB_PORT)    { $env:MCA_WEB_PORT }    else { "7642" }
$ApiServiceName = if ($env:MCA_SERVICE_NAME) { $env:MCA_SERVICE_NAME } else { "MyCodingAssistant" }
$LiveRef        = if ($env:MCA_LIVE_REF)    { $env:MCA_LIVE_REF }    else { "live" }
$StagingRef     = if ($env:MCA_STAGING_REF) { $env:MCA_STAGING_REF } else { "staging" }
$IncludeApi     = if ($env:MCA_DEPLOY_INCLUDE_API) { $env:MCA_DEPLOY_INCLUDE_API } else { "1" }

# ---- Admin check ----
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run from an elevated PowerShell. Right-click PowerShell -> Run as administrator, cd to this repo, then re-run."
    exit 1
}

# ---- Resolve repo + entrypoint ----
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$TsxCli   = Join-Path $RepoRoot "node_modules\tsx\dist\cli.mjs"
$SrcEntry = Join-Path $RepoRoot "apps\server\src\start-deployer.ts"
if (-not (Test-Path $TsxCli))   { Write-Error "Cannot find tsx at $TsxCli. Run ``npm install`` first."; exit 1 }
if (-not (Test-Path $SrcEntry)) { Write-Error "Cannot find $SrcEntry."; exit 1 }
$AppArgs = """$TsxCli"" ""$SrcEntry"""

# ---- Resolve node.exe ----
$NodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $NodeCmd) { Write-Error "node.exe is not on PATH. Install Node.js 22+ and re-run."; exit 1 }
$Node = $NodeCmd.Source

# ---- Resolve nssm.exe (same algorithm as install-windows.ps1) ----
function Find-Nssm {
    $cmd = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $local = Join-Path $RepoRoot "tools\nssm\nssm.exe"
    if (Test-Path $local) { return (Resolve-Path $local).Path }
    foreach ($c in @(
        "C:\ProgramData\chocolatey\bin\nssm.exe",
        "C:\ProgramData\scoop\shims\nssm.exe",
        "$env:LOCALAPPDATA\Microsoft\WinGet\Links\nssm.exe",
        "C:\Program Files\nssm\nssm.exe",
        "C:\Program Files (x86)\nssm\nssm.exe"
    )) { if (Test-Path $c) { return $c } }
    return $null
}
$Nssm = Find-Nssm
if (-not $Nssm) {
    Write-Error "nssm.exe not found. Install it (winget install NSSM.NSSM / choco install nssm / scoop install nssm) or drop it at $RepoRoot\tools\nssm\nssm.exe, then re-run."
    exit 1
}
Write-Host "Using NSSM at: $Nssm"

# ---- Logs directory ----
$LogDir    = Join-Path $RepoRoot "logs"
$StdoutLog = Join-Path $LogDir   "deployer.out.log"
$StderrLog = Join-Path $LogDir   "deployer.err.log"
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir | Out-Null }

# ---- Remove any existing service of the same name (idempotent re-install) ----
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Existing service '$ServiceName' found ($($existing.Status)) -- removing..."
    if ($existing.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        & $Nssm stop $ServiceName confirm 2>$null | Out-Null
        Start-Sleep -Seconds 2
    }
    & $Nssm remove $ServiceName confirm 2>$null | Out-Null
    Start-Sleep -Seconds 1
    if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
        & sc.exe delete $ServiceName | Out-Null
        Start-Sleep -Seconds 2
        if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
            Write-Error "Could not remove existing service '$ServiceName'. Remove manually and re-run."
            exit 1
        }
    }
    Write-Host "Removed."
}

# ---- Install + configure ----
Write-Host ""
Write-Host "Registering deployer service:"
Write-Host "  Name        : $ServiceName"
Write-Host "  DisplayName : $ServiceDisplay"
Write-Host "  App         : $Node"
Write-Host "  Arguments   : $AppArgs"
Write-Host "  AppDirectory: $RepoRoot"
Write-Host "  API service : $ApiServiceName (will be bounced on activate)"
Write-Host "  Refs        : live=$LiveRef staging=$StagingRef"
Write-Host "  Include API : $IncludeApi (set MCA_DEPLOY_INCLUDE_API=0 for web-only)"
Write-Host "  Stdout log  : $StdoutLog"
Write-Host "  Stderr log  : $StderrLog"
Write-Host ""

& $Nssm install $ServiceName $Node | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "nssm install failed (exit $LASTEXITCODE)."; exit 1 }
& $Nssm set $ServiceName AppParameters $AppArgs        | Out-Null
& $Nssm set $ServiceName DisplayName $ServiceDisplay   | Out-Null
& $Nssm set $ServiceName Description "MyCodingAssistant self-healing deployer (separate failure domain from the API + web)." | Out-Null
& $Nssm set $ServiceName Start SERVICE_AUTO_START      | Out-Null
& $Nssm set $ServiceName AppDirectory $RepoRoot        | Out-Null

# Environment: same USERPROFILE forwarding rationale as install-windows.ps1 --
# the deployer runs `git` as LocalSystem otherwise, which loses identity for
# any commit operation (mark/promote) and might trip protected branches.
$UserProfile = if ($env:USERPROFILE) { $env:USERPROFILE } else { "$env:HOMEDRIVE$env:HOMEPATH" }
$envBlock = (@(
    "PORT=$ApiPort",
    "WEB_PORT=$WebPort",
    "MCA_PROJECT_ROOT=$RepoRoot",
    "MCA_SERVICE_NAME=$ApiServiceName",
    "MCA_NSSM_PATH=$Nssm",
    "MCA_LIVE_REF=$LiveRef",
    "MCA_STAGING_REF=$StagingRef",
    "MCA_DEPLOY_INCLUDE_API=$IncludeApi",
    "NODE_ENV=production",
    "USERPROFILE=$UserProfile",
    "HOMEDRIVE=$(($UserProfile -split ':')[0]):",
    "HOMEPATH=$(($UserProfile -replace '^[A-Za-z]:', ''))"
) -join [char]13 + [char]10)
& $Nssm set $ServiceName AppEnvironmentExtra $envBlock | Out-Null

# Stdout/stderr to files, rotated at 10 MB (NSSM handles rotation transparently).
& $Nssm set $ServiceName AppStdout $StdoutLog          | Out-Null
& $Nssm set $ServiceName AppStderr $StderrLog          | Out-Null
& $Nssm set $ServiceName AppStdoutCreationDisposition 4 | Out-Null  # OPEN_ALWAYS
& $Nssm set $ServiceName AppStderrCreationDisposition 4 | Out-Null
& $Nssm set $ServiceName AppRotateFiles 1              | Out-Null
& $Nssm set $ServiceName AppRotateOnline 1             | Out-Null
& $Nssm set $ServiceName AppRotateBytes 10485760       | Out-Null  # 10 MB

# Restart policy. The deployer is supposed to be boring + always-on; if it
# crashes, NSSM throws it back up after 5 s. Throttle prevents tight crash loops.
& $Nssm set $ServiceName AppExit Default Restart       | Out-Null
& $Nssm set $ServiceName AppRestartDelay 5000          | Out-Null
& $Nssm set $ServiceName AppThrottle 10000             | Out-Null

# Graceful shutdown (same windows as the API service).
& $Nssm set $ServiceName AppStopMethodConsole 3000     | Out-Null
& $Nssm set $ServiceName AppStopMethodWindow  3000     | Out-Null
& $Nssm set $ServiceName AppStopMethodThreads 3000     | Out-Null
& $Nssm set $ServiceName AppKillProcessTree 1          | Out-Null

Write-Host "Done. Useful commands:"
Write-Host "  Start now : Start-Service $ServiceName"
Write-Host "  Stop      : Stop-Service  $ServiceName"
Write-Host "  Status    : Get-Service   $ServiceName"
Write-Host "  Logs      : Get-Content -Wait $StdoutLog"
Write-Host "  Journal   : Get-Content   $LogDir\deploy-journal.json"
Write-Host ""
Write-Host "Starting deployer now..."
Start-Service -Name $ServiceName
Start-Sleep -Seconds 4
$svc = Get-Service -Name $ServiceName
Write-Host "Status: $($svc.Status)"

if ($svc.Status -ne "Running") {
    Write-Warning "Deployer did not reach Running state. Check:"
    Write-Warning "  $StdoutLog"
    Write-Warning "  $StderrLog"
}
