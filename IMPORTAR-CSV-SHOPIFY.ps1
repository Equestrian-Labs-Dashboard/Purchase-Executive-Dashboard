# Uso en Windows PowerShell desde la carpeta raíz de Inventory:
# .\IMPORTAR-CSV-SHOPIFY.ps1 -Store corro -Month 2026-02 -Adjustments "C:\Reportes\ajustes.csv" -Sales "C:\Reportes\ventas.csv"
param(
  [Parameter(Mandatory=$true)][ValidateSet('corro','cavali')][string]$Store,
  [Parameter(Mandatory=$true)][ValidatePattern('^20\d{2}-(0[1-9]|1[0-2])$')][string]$Month,
  [Parameter(Mandatory=$true)][string]$Adjustments,
  [Parameter(Mandatory=$true)][string]$Sales
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
if(-not (Test-Path -LiteralPath $Adjustments -PathType Leaf)){throw "No se encontró el CSV de ajustes: $Adjustments"}
if(-not (Test-Path -LiteralPath $Sales -PathType Leaf)){throw "No se encontró el CSV de ventas: $Sales"}
if(-not (Get-Command node -ErrorAction SilentlyContinue)){throw 'Instala Node.js 24 antes de importar los CSV'}
Push-Location $root
try {
  & node scripts/shopifyql-csv-import.mjs --store $Store --month $Month --adjustments (Resolve-Path -LiteralPath $Adjustments).Path --sales (Resolve-Path -LiteralPath $Sales).Path
  if($LASTEXITCODE -ne 0){throw "Falló el importador ShopifyQL (código $LASTEXITCODE)"}
  Write-Host "Listo: sube data/shopifyql-import/$Store/$Month.json al GitHub OFICIAL de Inventory." -ForegroundColor Green
  if ($Store -eq 'corro') { Write-Host "Corro: sube el mismo JSON tambien al GitHub Purchase, en data/shopifyql-import/corro/$Month.json." -ForegroundColor Yellow }
  else { Write-Host "Cavali: NO subir a Purchase (solo Inventory)." -ForegroundColor Yellow }
} finally { Pop-Location }
