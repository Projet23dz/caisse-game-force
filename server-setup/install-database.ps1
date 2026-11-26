<#
  CashPro — Installation de la base de données sur le serveur Windows
  Prérequis : PostgreSQL 16 installé (https://www.postgresql.org/download/windows/)
  Exécuter dans PowerShell en administrateur :
      powershell -ExecutionPolicy Bypass -File .\install-database.ps1
#>
param(
  [string]$PgBin = "C:\Program Files\PostgreSQL\16\bin",
  [string]$DbName = "cashpro",
  [string]$SqlDir = (Join-Path $PSScriptRoot "..\database")
)
$ErrorActionPreference = "Stop"
$psql = Join-Path $PgBin "psql.exe"
if (-not (Test-Path $psql)) { throw "psql introuvable : $psql — vérifiez le chemin d'installation de PostgreSQL." }

Write-Host "=== CashPro : installation de la base ===" -ForegroundColor Yellow
$pgPass = Read-Host "Mot de passe du superutilisateur 'postgres'" -AsSecureString
$env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($pgPass))

function New-StrongPassword([int]$len = 32) {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] $len
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}

$exists = & $psql -U postgres -h localhost -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName'"
if ($exists -eq "1") { throw "La base '$DbName' existe déjà. Installation annulée pour ne rien écraser." }

& $psql -U postgres -h localhost -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DbName ENCODING 'UTF8' TEMPLATE template0"
if ($LASTEXITCODE -ne 0) { throw "Création de la base échouée" }

$files = @("01_schema.sql","02_logic.sql","03_security.sql","04_reports.sql","05_seed.sql","06_api.sql") +
  @(Get-ChildItem $SqlDir -Filter "*.sql" | Where-Object { $_.Name -match '^(0[7-9]|[1-9]\d)_' } | Sort-Object Name | ForEach-Object { $_.Name })
foreach ($f in $files) {
  Write-Host "  -> $f"
  & $psql -U postgres -h localhost -d $DbName -v ON_ERROR_STOP=1 -q -f (Join-Path $SqlDir $f) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Erreur dans $f" }
}

# Mots de passe forts pour les rôles applicatifs
$appPass = New-StrongPassword
$bkpPass = New-StrongPassword
& $psql -U postgres -h localhost -d $DbName -v ON_ERROR_STOP=1 -q -c "ALTER ROLE cashpro_app PASSWORD '$appPass'; ALTER ROLE cashpro_backup PASSWORD '$bkpPass';"

# Fichier de configuration de l'API (lisible par l'administrateur uniquement)
$confDir = "C:\CashPro\config"
New-Item -ItemType Directory -Force -Path $confDir, "C:\CashPro\attachments", "C:\CashPro\backups", "C:\CashPro\logos" | Out-Null
$jwt = New-StrongPassword 64
@"
DATABASE_URL=postgresql://cashpro_app:$appPass@localhost:5432/$DbName
BACKUP_DATABASE_URL=postgresql://cashpro_backup:$bkpPass@localhost:5432/$DbName
JWT_SECRET=$jwt
JWT_TTL=12h
HOST=0.0.0.0
PORT=4600
DATA_DIR=C:\CashPro
ATTACHMENTS_DIR=C:\CashPro\attachments
LOGOS_DIR=C:\CashPro\logos
BACKUP_DIR=C:\CashPro\backups
"@ | Set-Content -Path (Join-Path $confDir "cashpro.env") -Encoding UTF8
icacls $confDir /inheritance:r /grant:r "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null

# Fichier .pgpass pour la sauvegarde automatique (compte SYSTEM)
$pgpassDir = "C:\Windows\System32\config\systemprofile\AppData\Roaming\postgresql"
New-Item -ItemType Directory -Force -Path $pgpassDir | Out-Null
"localhost:5432:${DbName}:cashpro_backup:$bkpPass" | Set-Content -Path (Join-Path $pgpassDir "pgpass.conf") -Encoding ASCII

Remove-Item Env:\PGPASSWORD
Write-Host ""
Write-Host "Installation terminée." -ForegroundColor Green
Write-Host "  Configuration : $confDir\cashpro.env"
Write-Host "  Connexion initiale : admin / CashPro@2026  (changement obligatoire à la 1re connexion)"
Write-Host "  Étapes suivantes : .\install-api.ps1 puis .\schedule-backup.ps1"
