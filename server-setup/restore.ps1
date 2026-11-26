<#
  CashPro — Restauration d'une sauvegarde
  Restaure d'abord dans une base de vérification (cashpro_restore) ;
  le remplacement de la base de production se fait seulement après confirmation.
  Usage : powershell -ExecutionPolicy Bypass -File .\restore.ps1 -BackupFolder "C:\CashPro\backups\2026-11-24_2330"
#>
param(
  [Parameter(Mandatory = $true)][string]$BackupFolder,
  [string]$PgBin = "C:\Program Files\PostgreSQL\16\bin",
  [string]$DbName = "cashpro"
)
$ErrorActionPreference = "Stop"
$psql = Join-Path $PgBin "psql.exe"
$dump = Join-Path $BackupFolder "cashpro.dump"
if (-not (Test-Path $dump)) { throw "cashpro.dump introuvable dans $BackupFolder" }

# Vérification des empreintes
Get-Content (Join-Path $BackupFolder "SHA256SUMS.txt") | ForEach-Object {
  $hash, $file = $_ -split '\s+', 2
  if ((Get-FileHash (Join-Path $BackupFolder $file) -Algorithm SHA256).Hash -ne $hash) { throw "Fichier corrompu : $file" }
}
Write-Host "Empreintes vérifiées." -ForegroundColor Green

$pgPass = Read-Host "Mot de passe 'postgres'" -AsSecureString
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pgPass))

# 1. Restauration de contrôle
& $psql -U postgres -h localhost -q -c "DROP DATABASE IF EXISTS cashpro_restore" -c "CREATE DATABASE cashpro_restore TEMPLATE template0 ENCODING 'UTF8'"
& (Join-Path $PgBin "pg_restore.exe") -U postgres -h localhost -d cashpro_restore --no-owner --role=postgres $dump
& $psql -U postgres -h localhost -d cashpro_restore -c "SELECT b.name AS entreprise, count(t.*) AS operations, max(t.transaction_date) AS derniere FROM cashpro.businesses b LEFT JOIN cashpro.transactions t ON t.business_id = b.id GROUP BY b.name"

$ok = Read-Host "Les données ci-dessus sont-elles correctes ? Tapez RESTAURER pour remplacer la base de production"
if ($ok -ne "RESTAURER") { Write-Host "Annulé. La base de contrôle 'cashpro_restore' reste disponible."; exit 0 }

# 2. Remplacement : l'ancienne base est conservée sous un autre nom
Write-Host "Arrêtez le service CashPro API avant de continuer (Entrée pour poursuivre)..."; Read-Host | Out-Null
$old = "cashpro_before_restore_" + (Get-Date -Format "yyyyMMdd_HHmm")
& $psql -U postgres -h localhost -q -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname IN ('$DbName','cashpro_restore') AND pid <> pg_backend_pid()"
& $psql -U postgres -h localhost -q -c "ALTER DATABASE $DbName RENAME TO $old" -c "ALTER DATABASE cashpro_restore RENAME TO $DbName"
& $psql -U postgres -h localhost -d $DbName -q -c "GRANT CONNECT ON DATABASE $DbName TO cashpro_app, cashpro_backup"

# 3. Pièces jointes
foreach ($z in "attachments","logos") {
  $zip = Join-Path $BackupFolder "$z.zip"
  if (Test-Path $zip) { Expand-Archive $zip -DestinationPath "C:\CashPro\$z" -Force }
}
Remove-Item Env:\PGPASSWORD
Write-Host "Restauration terminée. Ancienne base conservée : $old" -ForegroundColor Green
