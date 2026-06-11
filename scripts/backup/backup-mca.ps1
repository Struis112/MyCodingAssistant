# Nightly MCA backup — durability net for a single-disk deployment.
#
# What it protects (the things that exist nowhere else):
#   1. Git history  -> git bundle of ALL refs (works even when GitHub auth is
#      down, which is exactly when we need a net) + best-effort push to origin.
#   2. Agent state  -> ~/.pi/agent for BOTH profiles (Administrator + SYSTEM):
#      sessions, auth, custom models.json.
#   3. App state    -> logs/*.json (tabs, healing events, model health) and the
#      LAN access key.
#
# Output: C:\Backups\MyCodingAssistant\mca-<timestamp>.zip (+ .bundle), keep 14.
# Scheduled daily via the 'MyCodingAssistant Backup' task (03:30).

$ErrorActionPreference = "Continue"
$RepoDir   = "C:\Users\Administrator\Repositories\myCodingAssistant"
$BackupDir = "C:\Backups\MyCodingAssistant"
$Stamp     = Get-Date -Format "yyyyMMdd-HHmm"
$Keep      = 14

New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$log = Join-Path $BackupDir "backup.log"
function Note($m) { "$(Get-Date -Format s) $m" | Tee-Object -FilePath $log -Append }

Note "=== backup $Stamp start ==="

# 1a. Git bundle (all refs incl. rescue branches + live). Local, no auth needed.
$bundle = Join-Path $BackupDir "mca-$Stamp.bundle"
git -C $RepoDir -c safe.directory=* bundle create $bundle --all 2>&1 | Out-Null
if (Test-Path $bundle) { Note "git bundle ok: $bundle" } else { Note "git bundle FAILED" }

# 1b. Best-effort push (succeeds once GitHub auth is restored; harmless until).
# GIT_TERMINAL_PROMPT=0: a broken credential helper must FAIL, not hang the
# whole backup waiting for a prompt no one will ever see.
# Note: Windows PowerShell 5.1 runs this — no ternary / null-coalescing syntax.
$env:GIT_TERMINAL_PROMPT = "0"
$env:GCM_INTERACTIVE = "Never"
git -C $RepoDir -c safe.directory=* push origin staging 2>&1 | Out-Null
if ($LASTEXITCODE -eq 0) { Note "git push: ok" } else { Note "git push: skipped/failed" }

# 2+3. Zip the state directories. Sessions can be tens of MB — fine nightly.
$staging = Join-Path $env:TEMP "mca-backup-$Stamp"
New-Item -ItemType Directory -Force -Path $staging | Out-Null
$sources = @(
    @{ src = "C:\Users\Administrator\.pi\agent";                              dst = "pi-agent-administrator" },
    @{ src = "C:\Windows\System32\config\systemprofile\.pi\agent";            dst = "pi-agent-system" },
    @{ src = Join-Path $RepoDir "logs";                                       dst = "logs" }
)
foreach ($s in $sources) {
    if (Test-Path $s.src) {
        # /XF *.log: operational logs are bulky and rotate on their own.
        robocopy $s.src (Join-Path $staging $s.dst) /E /R:1 /W:1 /XF *.log | Out-Null
        Note "staged $($s.src)"
    } else {
        Note "missing (skipped): $($s.src)"
    }
}
$zip = Join-Path $BackupDir "mca-$Stamp.zip"
Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zip -Force
Remove-Item -Recurse -Force $staging
if (Test-Path $zip) { Note "state zip ok: $zip" } else { Note "state zip FAILED" }

# Retention: keep the newest $Keep of each artifact type.
foreach ($pattern in @("mca-*.zip", "mca-*.bundle")) {
    Get-ChildItem $BackupDir -Filter $pattern | Sort-Object Name -Descending |
        Select-Object -Skip $Keep | Remove-Item -Force
}

Note "=== backup $Stamp done ==="
