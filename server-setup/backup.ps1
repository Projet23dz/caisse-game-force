<#
  CashPro — Sauvegarde quotidienne : base PostgreSQL + pièces jointes + logos
  Lancée chaque soir par le Planificateur de tâches (voir schedule-backup.ps1).
  Rétention : N jours de sauvegardes quotidiennes + 1 par mois pendant M mois.
  Copie hors serveur : disque externe / dossier synchronisé (OffsitePath).
  Sans -OffsitePath : dossier choisi dans CashPro (Paramètres → Google Drive), lu dans app_settings.backup.offsite_path
  (ex. C:\Users\palm 1\My Drive : Google Drive pour ordinateur en mode « Mise en miroir »). Copie dans <dossier>\CashPro-Backups.
#>
param(
  [string]$PgBin = "C:\Program Files\PostgreSQL\16\bin",
  [string]$DbName = "cashpro",
  [int]$Port = 5432,
  [string]$BackupDir = "C:\CashPro\backups",
  [string]$DataDirs = "C:\CashPro\attachments;C:\CashPro\logos",
  [string]$OffsitePath = "",          # ex : "E:\CashPro-Backups" ou dossier Google Drive / OneDrive
  [int]$KeepDays = 30,
  [int]$KeepMonths = 12
)
$ErrorActionPreference = "Stop"
# Le mot de passe vient de pgpass.conf (compte SYSTEM) : ignorer un PGPASSWORD hérité de l'environnement
Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
$OffsiteSub = ""
if (-not $OffsitePath) {
  # dossier choisi dans l'application (Google Drive) — chemin en UTF-8 (nom d'utilisateur accentué / arabe)
  try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $env:PGCLIENTENCODING = "UTF8"
    $v = & (Join-Path $PgBin "psql.exe") -h localhost -p $Port -U cashpro_backup -d $DbName -tA -c "SELECT coalesce(value->>'offsite_path', '') FROM cashpro.app_settings WHERE key = 'backup'" 2>$null
    if ($LASTEXITCODE -eq 0 -and "$v".Trim()) { $OffsitePath = "$v".Trim(); $OffsiteSub = "CashPro-Backups" }
  } catch { }
}
$stamp = Get-Date -Format "yyyy-MM-dd_HHmm"
$target = Join-Path $BackupDir $stamp
New-Item -ItemType Directory -Force -Path $target | Out-Null
$log = Join-Path $BackupDir "backup.log"

function Log($m) { "$(Get-Date -Format s)  $m" | Add-Content $log; Write-Host $m }

try {
  # 1. Base de données (format compressé, restaurable avec pg_restore)
  & (Join-Path $PgBin "pg_dump.exe") -h localhost -p $Port -U cashpro_backup -d $DbName -Fc -Z 9 `
      --no-owner -f (Join-Path $target "cashpro.dump")
  if ($LASTEXITCODE -ne 0) { throw "pg_dump a échoué ($LASTEXITCODE)" }

  # 2. Vérification de lisibilité du dump
  & (Join-Path $PgBin "pg_restore.exe") -l (Join-Path $target "cashpro.dump") | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Dump illisible" }

  # 3. Pièces jointes et logos
  foreach ($d in $DataDirs.Split(';')) {
    if (Test-Path $d) {
      $name = Split-Path $d -Leaf
      Compress-Archive -Path (Join-Path $d '*') -DestinationPath (Join-Path $target "$name.zip") -Force -ErrorAction SilentlyContinue
    }
  }

  # 4. Empreintes SHA-256
  Get-ChildItem $target -File | ForEach-Object {
    "{0}  {1}" -f (Get-FileHash $_.FullName -Algorithm SHA256).Hash, $_.Name
  } | Set-Content (Join-Path $target "SHA256SUMS.txt")

  # 5. Copie hors serveur
  $offDir = if ($OffsiteSub) { Join-Path $OffsitePath $OffsiteSub } else { $OffsitePath }
  if ($OffsitePath -and (Test-Path $OffsitePath)) {
    New-Item -ItemType Directory -Force -Path $offDir | Out-Null
    Copy-Item $target -Destination $offDir -Recurse -Force
    Log "Copie hors serveur : $offDir\$stamp"
  } elseif ($OffsitePath) {
    Log "ATTENTION : emplacement hors serveur indisponible ($OffsitePath)"
  }

  # 6. Rétention : garder les $KeepDays derniers jours + la 1re sauvegarde de chaque mois
  $all = Get-ChildItem $BackupDir -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{4}$' } | Sort-Object Name
  $monthlyKeep = $all | Group-Object { $_.Name.Substring(0,7) } | ForEach-Object { $_.Group[0].Name } | Select-Object -Last $KeepMonths
  $limit = (Get-Date).AddDays(-$KeepDays).ToString("yyyy-MM-dd")
  $all | Where-Object { $_.Name.Substring(0,10) -lt $limit -and $monthlyKeep -notcontains $_.Name } |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force; Log "Supprimé (rétention) : $($_.Name)" }
  # même rétention pour la copie hors serveur (Google Drive : espace limité)
  if ($OffsitePath -and (Test-Path $offDir)) {
    $kept = Get-ChildItem $BackupDir -Directory | ForEach-Object { $_.Name }
    Get-ChildItem $offDir -Directory | Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}_\d{4}$' -and $kept -notcontains $_.Name } |
      ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue; Log "Supprimé hors serveur (rétention) : $($_.Name)" }
  }

  Log "Sauvegarde OK : $target"
} catch {
  Log "ERREUR SAUVEGARDE : $_"
  exit 1
}
