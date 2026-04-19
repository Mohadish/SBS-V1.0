$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'runtime_manifest.json'
$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$missing = @()
foreach ($entry in $manifest.files) {
    $target = Join-Path $root $entry.path
    if (-not (Test-Path $target)) {
        $missing += $entry.path
        continue
    }
    $size = (Get-Item $target).Length
    if ($size -le 0) { $missing += $entry.path }
}
if ($missing.Count -gt 0) {
    Write-Host 'Missing runtime files:' -ForegroundColor Red
    $missing | ForEach-Object { Write-Host " - $_" -ForegroundColor Red }
    exit 1
}
Write-Host 'Runtime looks complete.' -ForegroundColor Green
