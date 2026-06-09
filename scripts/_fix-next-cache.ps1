$ErrorActionPreference = 'Stop'
$svc = 'MyCodingAssistant'
$nextDir = 'C:\Users\Administrator\Repositories\myCodingAssistant\apps\web\.next'

Write-Host "Stopping $svc ..." -ForegroundColor Cyan
Stop-Service -Name $svc -Force
# Wait for it to fully stop
$tries = 0
while ((Get-Service -Name $svc).Status -ne 'Stopped' -and $tries -lt 30) {
    Start-Sleep -Milliseconds 500
    $tries++
}
Write-Host ("Status: " + (Get-Service -Name $svc).Status)

# Give node a moment to release file handles
Start-Sleep -Seconds 2

if (Test-Path $nextDir) {
    Write-Host "Removing $nextDir ..." -ForegroundColor Cyan
    try {
        Remove-Item -Recurse -Force -LiteralPath $nextDir
    } catch {
        Write-Host "First remove failed ($_), retrying after 3s..." -ForegroundColor Yellow
        Start-Sleep -Seconds 3
        Remove-Item -Recurse -Force -LiteralPath $nextDir
    }
    Write-Host ".next removed." -ForegroundColor Green
} else {
    Write-Host ".next not present, nothing to clean." -ForegroundColor Yellow
}

Write-Host "Starting $svc ..." -ForegroundColor Cyan
Start-Service -Name $svc
$tries = 0
while ((Get-Service -Name $svc).Status -ne 'Running' -and $tries -lt 30) {
    Start-Sleep -Milliseconds 500
    $tries++
}
Write-Host ("Status: " + (Get-Service -Name $svc).Status) -ForegroundColor Green
Write-Host "Done. First page load will take a few seconds while Next rebuilds." -ForegroundColor Green
