$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'runtime_manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$logPath = Join-Path $root 'runtime_fetch_log.txt'
$errorPath = Join-Path $root 'runtime_fetch_errors.txt'
if (Test-Path $logPath) { Remove-Item $logPath -Force }
if (Test-Path $errorPath) { Remove-Item $errorPath -Force }
$failures = @()
foreach ($entry in $manifest.files) {
    $target = Join-Path $root $entry.path
    $dir = Split-Path -Parent $target
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $success = $false
    foreach ($url in $entry.urls) {
        try {
            Write-Host "Downloading $($entry.path) from $url" -ForegroundColor Cyan
            Add-Content -Path $logPath -Value "TRY  $($entry.path) <- $url"
            Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing
            $size = (Get-Item $target).Length
            if ($size -gt 0) {
                Write-Host "OK  $($entry.path) ($size bytes)" -ForegroundColor Green
                Add-Content -Path $logPath -Value "OK   $($entry.path) ($size bytes) <- $url"
                $success = $true
                break
            }
        } catch {
            $msg = $_.Exception.Message
            Write-Host "FAILED $($entry.path) from $url" -ForegroundColor Yellow
            Add-Content -Path $logPath -Value "FAIL $($entry.path) <- $url :: $msg"
        }
    }
    if (-not $success) {
        $failures += $entry.path
        Add-Content -Path $errorPath -Value $entry.path
    }
}
if ($failures.Count -gt 0) {
    Write-Host "Runtime fetch finished with missing files:" -ForegroundColor Red
    $failures | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    exit 1
}
Write-Host "Runtime download complete." -ForegroundColor Green
