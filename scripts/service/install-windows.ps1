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
#   AppParameters    : node_modules\tsx\dist\cli.mjs watch
#                        apps\server\src\start-dev-supervised.ts  (default / watch)
#                      apps\server\dist\start-prod.js             (MCA_PROD=1)
#   AppDirectory     : <repo root>
#   AppEnvironmentExtra : PORT, WEB_PORT, MCA_WEB_ORIGIN, MCA_WEB_DIR,
#                         MCA_PROJECT_ROOT, MCA_SUPERVISE_WEB=1,
#                         and per profile: NODE_ENV + (dev) MCA_WEB_DEV=1
#
# Profiles (see README "Run modes"):
#   default (watch/HMR) -- `tsx watch` (server auto-restart) + `next dev` (web
#                          Fast Refresh). Edits appear instantly, no rebuild or
#                          restart. Best for a machine you develop on. Force
#                          explicitly with MCA_WATCH=1.
#   MCA_PROD=1          -- `node dist/start-prod.js` (`next start`) against the
#                          production build: optimised bundle, rebuild+restart on
#                          change. Use for real deployments.
#
# Opt-in safety knobs (dev profile only; ignored under MCA_PROD=1):
#   MCA_WATCH_SAFE=1    -- run under plain `tsx` (NO --watch) and let the
#                          in-process WatchSafeRestarter own the restart:
#                          waits for active chat turns to finish AND runs a
#                          `tsc --noEmit` precheck before swapping. Prevents
#                          "swap onto broken candidate" (2026-06-10 class of
#                          incident). Process exit triggers NSSM to relaunch.
#   MCA_DEV_PRECHECK=1  -- (compatible with the default `tsx watch`) run a
#                          tsc precheck BEFORE importing index.js in the
#                          supervised entry. Fails fast on broken candidates
#                          with a focused tsc diagnostic instead of a
#                          half-initialised ESM load.
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
#   $env:MCA_PROD            = "1"   # use the production build instead of dev fast-refresh

$ErrorActionPreference = "Stop"

# ---- Config from env / defaults ----
$ServiceName    = if ($env:MCA_SERVICE_NAME)    { $env:MCA_SERVICE_NAME }    else { "MyCodingAssistant" }
$ServiceDisplay = if ($env:MCA_SERVICE_DISPLAY) { $env:MCA_SERVICE_DISPLAY } else { "MyCodingAssistant" }
$ApiPort        = if ($env:MCA_PORT)            { $env:MCA_PORT }            else { "7641" }
$WebPort        = if ($env:MCA_WEB_PORT)        { $env:MCA_WEB_PORT }        else { "7642" }
# Profile: watch/HMR by default; set MCA_PROD=1 for the production build.
# MCA_WATCH=1 selects watch explicitly (it's also the default).
$ProdMode    = ($env:MCA_PROD -eq "1")
$WatchMode   = (-not $ProdMode)
$WatchSafe   = ((-not $ProdMode) -and ($env:MCA_WATCH_SAFE -eq "1"))
$DevPrecheck = ((-not $ProdMode) -and ($env:MCA_DEV_PRECHECK -eq "1"))

# ---- Admin check ----
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error "This script must be run from an elevated PowerShell. Right-click PowerShell -> Run as administrator, cd to this repo, then re-run."
    exit 1
}

# ---- Resolve repo + entrypoint (profile-dependent) ----
$RepoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
# Resolve how NSSM launches node, per profile:
#   watch/HMR: node <tsx cli> watch apps\server\src\start-dev-supervised.ts
#   prod:      node apps\server\dist\start-prod.js   (needs a prior build)
if ($ProdMode) {
    $ProdEntry = Join-Path $RepoRoot "apps\server\dist\start-prod.js"
    if (-not (Test-Path $ProdEntry)) {
        Write-Error "Cannot find $ProdEntry. Run ``npm run build`` from the repo root first."
        exit 1
    }
    $AppArgs = """$ProdEntry"""
} else {
    $TsxCli   = Join-Path $RepoRoot "node_modules\tsx\dist\cli.mjs"
    $SrcEntry = Join-Path $RepoRoot "apps\server\src\start-dev-supervised.ts"
    if (-not (Test-Path $TsxCli)) {
        Write-Error "Cannot find tsx at $TsxCli. Run ``npm install`` from the repo root first."
        exit 1
    }
    if (-not (Test-Path $SrcEntry)) { Write-Error "Cannot find $SrcEntry."; exit 1 }
    if ($WatchSafe) {
        # No `watch` flag: plain `tsx` runs the entry once; the in-process
        # WatchSafeRestarter owns reload (with the precheck gate). When it
        # decides to restart it calls process.exit(0) and NSSM relaunches us.
        $AppArgs = """$TsxCli"" ""$SrcEntry"""
    } else {
        $AppArgs = """$TsxCli"" watch ""$SrcEntry"""
    }
}
$ProfileLabel = if ($ProdMode) { 'prod (next start, built)' }
                elseif ($WatchSafe) { 'watch-safe (in-process gate + precheck) + next dev' }
                else { 'watch/HMR (tsx watch + next dev)' }
Write-Host ("Profile     : " + $ProfileLabel)
if ($DevPrecheck) { Write-Host "DevPrecheck : enabled (tsc --noEmit before import)" }

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
# We try NSSM first (the right path for an NSSM-managed service). If it
# bails -- which it does for services NOT installed by NSSM, e.g. one left
# behind by the older sc.exe-based installer -- we fall back to sc.exe delete
# so a single "reinstall" pass actually replaces *whatever* is there.
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Existing service '$ServiceName' found ($($existing.Status)) -- removing..."

    # Stop first (best effort). Stop-Service handles both NSSM and sc.exe
    # registrations because it just talks to the SCM.
    if ($existing.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        # NSSM-managed services sometimes need NSSM stop too to clean up the
        # wrapped child process; harmless on sc.exe-only services.
        & $Nssm stop $ServiceName confirm 2>$null | Out-Null
        Start-Sleep -Seconds 2
    }

    # Try NSSM remove. Capture its exit code rather than relying on
    # $ErrorActionPreference, because NSSM writes its diagnostics on stderr
    # and exits non-zero on "not managed by this NSSM" without throwing a
    # PowerShell exception.
    & $Nssm remove $ServiceName confirm 2>$null | Out-Null
    $removeExit = $LASTEXITCODE

    Start-Sleep -Seconds 1
    $stillThere = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($stillThere) {
        Write-Host "NSSM declined to remove the existing service (likely sc.exe-installed; nssm exit $removeExit). Falling back to sc.exe delete..."
        & sc.exe delete $ServiceName | Out-Null
        Start-Sleep -Seconds 2
        if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
            Write-Error "Could not remove existing service '$ServiceName' with either NSSM or sc.exe. Reboot or manually delete via 'sc.exe delete $ServiceName' and re-run."
            exit 1
        }
    }
    Write-Host "Removed."
}

# ---- Install + configure via NSSM ----
Write-Host ""
Write-Host "Registering service:"
Write-Host "  Name        : $ServiceName"
Write-Host "  DisplayName : $ServiceDisplay"
Write-Host "  App         : $Node"
Write-Host "  Arguments   : $AppArgs"
Write-Host "  AppDirectory: $RepoRoot"
Write-Host "  API port    : $ApiPort   (env PORT)"
Write-Host "  Web port    : $WebPort   (env WEB_PORT, propagated to WebSupervisor)"
Write-Host "  Stdout log  : $StdoutLog"
Write-Host "  Stderr log  : $StderrLog"
Write-Host ""

# install <servicename> <app>; set arguments separately so multi-arg profiles
# (node <tsx cli> watch <entry>) are stored cleanly.
& $Nssm install $ServiceName $Node | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "nssm install failed (exit $LASTEXITCODE)."; exit 1 }
& $Nssm set $ServiceName AppParameters $AppArgs | Out-Null

# Friendly metadata in services.msc.
& $Nssm set $ServiceName DisplayName $ServiceDisplay      | Out-Null
& $Nssm set $ServiceName Description "MyCodingAssistant API server + supervised Next.js web (built from $RepoRoot)." | Out-Null
& $Nssm set $ServiceName Start SERVICE_AUTO_START         | Out-Null

# Working directory matches the repo root.
& $Nssm set $ServiceName AppDirectory $RepoRoot           | Out-Null

# Environment: NSSM takes one big string of "KEY=VALUE" pairs joined by `r`n.
# Listing each on its own line keeps the registry value readable.
#
# USERPROFILE/HOMEDRIVE/HOMEPATH are forwarded explicitly. The service
# runs as LocalSystem by default, whose home dir is
# C:\Windows\System32\config\systemprofile -- which means the Pi SDK's
# os.homedir() lookup misses the user's ~/.pi/agent/auth.json and the
# /api/models call returns 0 models. Forwarding the installing user's
# USERPROFILE makes the SDK pick up the real auth file without having
# to copy auth.json into systemprofile or run the service as the user
# account (which would need a password).
$UserProfile = if ($env:USERPROFILE) { $env:USERPROFILE } else { "$env:HOMEDRIVE$env:HOMEPATH" }
$envBlock = (@(
    "PORT=$ApiPort",
    "WEB_PORT=$WebPort",
    "MCA_WEB_ORIGIN=http://localhost:$WebPort",
    "MCA_WEB_DIR=$(Join-Path $RepoRoot 'apps\web')",
    "MCA_PROJECT_ROOT=$RepoRoot",
    "MCA_SUPERVISE_WEB=1",
    $(if ($ProdMode) { "NODE_ENV=production" } else { "NODE_ENV=development" }),
    $(if ($ProdMode) { "MCA_WEB_DEV=0" } else { "MCA_WEB_DEV=1" }),
    $(if ($WatchSafe)   { "MCA_WATCH_SAFE=1" }   else { "MCA_WATCH_SAFE=0" }),
    $(if ($DevPrecheck) { "MCA_DEV_PRECHECK=1" } else { "MCA_DEV_PRECHECK=0" }),
    "USERPROFILE=$UserProfile",
    "HOMEDRIVE=$(($UserProfile -split ':')[0]):",
    "HOMEPATH=$(($UserProfile -replace '^[A-Za-z]:', ''))"
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

# Graceful shutdown: send Ctrl-C/Ctrl+Break, give the app a short window to
# exit cleanly, then kill the process tree. The server's own shutdown handler
# exits in well under a second (it closes WebSockets so httpServer.close()
# resolves immediately), so 3 s per method is plenty. Keeping these SMALL is
# important: a slow stop makes `Restart-Service` time out and never issue the
# start, which looks like "the service stopped and never came back".
& $Nssm set $ServiceName AppStopMethodConsole 3000        | Out-Null
& $Nssm set $ServiceName AppStopMethodWindow  3000        | Out-Null
& $Nssm set $ServiceName AppStopMethodThreads 3000        | Out-Null
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
