# PowerShell in root of Purchase project. Corro only.
# .\IMPORTAR-HISTORICO-SIN-ACTIONS.ps1 -Months '2026-07,2026-08,2026-09,2026-10' -CsvDir 'C:\ShopifyReports' -Through '2026-10-19'
param(
  [Parameter(Mandatory=$true)][string]$Months,
  [Parameter(Mandatory=$true)][string]$CsvDir,
  [Parameter(Mandatory=$true)][ValidatePattern('^20\d\d-\d\d-\d\d$')][string]$Through
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path -LiteralPath $CsvDir -PathType Container)) { throw "CSV directory missing: $CsvDir" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 first.' }
$tempFile = Join-Path $env:TEMP ("manual-purchase-" + [guid]::NewGuid().ToString('N') + '.json')
$previousSource = $env:INVENTORY_SOURCE_FILE
$previousStores = $env:INVENTORY_REQUIRED_STORES
Push-Location $root
try {
  & node scripts/import-manual-shopify-history.mjs --store corro --months $Months --csv-dir (Resolve-Path -LiteralPath $CsvDir).Path --output $tempFile --through $Through
  if ($LASTEXITCODE -ne 0) { throw 'Shopify CSV validation failed.' }
  $env:INVENTORY_SOURCE_FILE = $tempFile
  $env:INVENTORY_REQUIRED_STORES = 'corro'
  & node scripts/export-portable-inventory.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Portable data export failed.' }
  & node scripts/prune-portable-inventory.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Portable pruning failed.' }
  & node scripts/build.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Dashboard build failed.' }
  Write-Host 'SUCCESS - Purchase Corro data generated with NO GitHub Actions.' -ForegroundColor Green
  Write-Host 'Upload data/shopify-export/ and data/shopifyql-import/corro/ to PURCHASE GitHub.' -ForegroundColor Green
} finally {
  $env:INVENTORY_SOURCE_FILE = $previousSource
  $env:INVENTORY_REQUIRED_STORES = $previousStores
  Pop-Location
  Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
}
