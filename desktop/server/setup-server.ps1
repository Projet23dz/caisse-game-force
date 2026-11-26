<#
  CashPro — installation complète du serveur (lancée par CashPro-Server-Setup.exe, en administrateur).
  1. PostgreSQL (binaires fournis) : initialisation, service Windows « CashPro-PostgreSQL », écoute locale uniquement
  2. Base « cashpro » : schéma, règles, sécurité, rapports, données initiales (Game Force + ETP)
  3. Rôles applicatifs à mots de passe aléatoires + compte admin (mot de passe à changer à la 1re connexion)
  4. API + interface : tâche « CashPro API » au démarrage de Windows (port 4600)
  5. Sauvegarde quotidienne, pare-feu (réseau local + plage VPN Tailscale), vérification finale
  Réinstallation / mise à jour : les données existantes (C:\CashPro) sont conservées.
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [string]$DataRoot = "C:\CashPro",
  [string]$TailnetName = "",                 # obsolète (Tailscale intégré retiré en 1.2.0), gardé pour compatibilité
  [string]$TailnetControl = "",              # obsolète
  [int]$ApiPort = 4600
)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path $Root).Path
$logs = Join-Path $DataRoot "logs"
New-Item -ItemType Directory -Force -Path $DataRoot, $logs, "$DataRoot\config", "$DataRoot\attachments", "$DataRoot\logos", "$DataRoot\backups" | Out-Null
Start-Transcript -Path (Join-Path $logs ("install-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")) -Force | Out-Null
# Dossier temporaire propre à CashPro : %TEMP% peut être un chemin court 8.3 (C:\Users\PALM1~1\...)
# quand le nom d'utilisateur contient un espace, ce que PowerShell 5.1 résout mal (Remove-Item).
$tmp = Join-Path $DataRoot "tmp"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
# administrateurs + SYSTEM + compte qui installe : initdb s'exécute avec un jeton restreint (groupe Administrateurs inactif)
$meSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls $tmp /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*${meSid}:(OI)(CI)F" /Q | Out-Null
$env:TEMP = $tmp; $env:TMP = $tmp
if ([Environment]::OSVersion.Version.Major -lt 10) {
  Write-Host "ERREUR : Windows 10 / Server 2016 ou plus récent requis pour le serveur (PostgreSQL 16, Node.js 22). Version détectée : $([Environment]::OSVersion.VersionString)"
  Stop-Transcript | Out-Null
  exit 2
}

$pgBin   = Join-Path $Root "pgsql\bin"
$node    = Join-Path $Root "node\node.exe"
$api     = Join-Path $Root "api"
$sqlDir  = Join-Path $Root "database"
$pgData  = Join-Path $DataRoot "pgdata"
$envFile = Join-Path $DataRoot "config\cashpro.env"
$svcName = "CashPro-PostgreSQL"
$DbName  = "cashpro"

function Step($m) { Write-Host ""; Write-Host "==> $m" }
function Run([string]$exe, [string[]]$argv, [string]$what) {
  & $exe @argv
  if ($LASTEXITCODE -ne 0) { throw "$what a échoué (code $LASTEXITCODE)" }
}
function New-Secret([int]$len = 32) {
  $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] $len
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  -join ($bytes | ForEach-Object { $chars[$_ % $chars.Length] })
}
function Test-PortFree([int]$p) {
  try { $l = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $p); $l.Start(); $l.Stop(); return $true } catch { return $false }
}
function Remove-FileQuiet([string]$p) { try { if ([IO.File]::Exists($p)) { [IO.File]::Delete($p) } } catch { } }
function Write-PartialEnv([int]$port, [string]$pass) {
  # Écrit tout de suite les accès PostgreSQL : si une étape suivante échoue, une réinstallation peut reprendre.
  @("# CashPro — configuration partielle (installation en cours)", "PG_SUPERUSER_PASSWORD=$pass", "PG_PORT=$port", "PG_BIN=$pgBin") |
    Set-Content -Path $envFile -Encoding UTF8
}
function Test-PgDataEmpty {
  # Une base neuve ne contient que template1 (1), template0 (4) et postgres (5) dans base\
  $dirs = @(Get-ChildItem (Join-Path $pgData "base") -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  return (@($dirs | Where-Object { $_ -notin @("1", "4", "5") }).Count -eq 0)
}
function Read-Env {
  $h = @{}
  if (Test-Path $envFile) { Get-Content $envFile | ForEach-Object { if ($_ -match '^([A-Z_]+)=(.*)$') { $h[$matches[1]] = $matches[2] } } }
  return $h
}

try {
  foreach ($f in @("$pgBin\initdb.exe", "$pgBin\pg_ctl.exe", "$pgBin\psql.exe", $node, "$api\dist\server.js")) {
    if (-not (Test-Path $f)) { throw "Fichier manquant dans l'installation : $f" }
  }
  $cfg = Read-Env

  # ------------------------------------------------------------------ 1. PostgreSQL
  Step "PostgreSQL"
  $fresh = -not (Test-Path (Join-Path $pgData "PG_VERSION"))
  if (-not $fresh -and (-not $cfg.PG_PORT -or -not $cfg.PG_SUPERUSER_PASSWORD)) {
    # Reste d'une installation interrompue : sans le mot de passe, la base est inutilisable.
    if (Get-Service $svcName -ErrorAction SilentlyContinue) {
      Stop-Service $svcName -Force -ErrorAction SilentlyContinue
      & "$pgBin\pg_ctl.exe" unregister -N $svcName | Out-Null
    }
    Get-Process postgres -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$Root*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    if (Test-PgDataEmpty) {
      $aside = "$pgData-echec-" + (Get-Date -Format "yyyyMMdd-HHmmss")
      Start-Sleep -Seconds 2
      Rename-Item $pgData $aside
      Write-Host "Installation précédente interrompue (base vide) : dossier déplacé vers $aside, nouvelle initialisation."
      $fresh = $true
    } else {
      throw ("Le dossier $pgData contient des bases de données mais la configuration $envFile est absente ou incomplète. " +
             "Rien n'a été modifié. Restaurez le fichier cashpro.env (sauvegarde) ou déplacez ce dossier si ces données ne sont pas utiles. " +
             "/ المجلد $pgData يحتوي على بيانات لكن ملف الإعداد ناقص. لم يُغيَّر شيء: استرجع cashpro.env من نسخة احتياطية أو انقل المجلد إن لم تكن بياناته مهمة.")
    }
  }
  if ($fresh) {
    $pgPort = 5432
    while (-not (Test-PortFree $pgPort)) { $pgPort++ ; if ($pgPort -gt 5450) { throw "Aucun port libre pour PostgreSQL (5432-5450)" } }
    $superPass = New-Secret 32
    $pwFile = Join-Path $tmp ("cp-" + [guid]::NewGuid().ToString() + ".txt")
    [IO.File]::WriteAllText($pwFile, $superPass)
    try {
      Run "$pgBin\initdb.exe" @("-D", $pgData, "-U", "postgres", "-E", "UTF8", "--no-locale", "--auth=scram-sha-256", "--pwfile=$pwFile") "Initialisation PostgreSQL"
    } finally { Remove-FileQuiet $pwFile }
    Write-PartialEnv $pgPort $superPass
    Add-Content -Path (Join-Path $pgData "postgresql.conf") -Value @(
      "", "# --- CashPro ---", "listen_addresses = 'localhost'", "port = $pgPort", "timezone = 'Africa/Algiers'",
      "log_timezone = 'Africa/Algiers'", "max_connections = 50", "shared_buffers = 256MB")
  } else {
    $pgPort = [int]$cfg.PG_PORT
    $superPass = $cfg.PG_SUPERUSER_PASSWORD
    Write-Host "Base existante conservée ($pgData)."
  }
  # Le service tourne sous NetworkService (SID S-1-5-20, indépendant de la langue de Windows)
  & icacls $pgData /grant "*S-1-5-20:(OI)(CI)M" /T /Q | Out-Null
  if (Get-Service $svcName -ErrorAction SilentlyContinue) {
    Stop-Service $svcName -Force -ErrorAction SilentlyContinue
    & "$pgBin\pg_ctl.exe" unregister -N $svcName | Out-Null
  }
  Run "$pgBin\pg_ctl.exe" @("register", "-N", $svcName, "-U", "NT AUTHORITY\NetworkService", "-D", $pgData, "-S", "auto", "-w") "Enregistrement du service PostgreSQL"
  Start-Service $svcName
  $env:PGPASSWORD = $superPass
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) { & "$pgBin\pg_isready.exe" -h localhost -p $pgPort -q; if ($LASTEXITCODE -eq 0) { $ok = $true; break }; Start-Sleep -Seconds 1 }
  if (-not $ok) { throw "PostgreSQL ne répond pas sur le port $pgPort" }
  $psql = @("-h", "localhost", "-p", "$pgPort", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q")

  # ------------------------------------------------------------------ 2-3. Base, rôles, données initiales
  Step "Base de données"
  $exists = & "$pgBin\psql.exe" -h localhost -p $pgPort -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname='$DbName'"
  if ($exists -ne "1") {
    Run "$pgBin\psql.exe" ($psql + @("-c", "CREATE DATABASE $DbName ENCODING 'UTF8' TEMPLATE template0")) "Création de la base"
    foreach ($f in "01_schema.sql", "02_logic.sql", "03_security.sql", "04_reports.sql", "05_seed.sql", "06_api.sql") {
      Write-Host "  -> $f"
      Run "$pgBin\psql.exe" ($psql + @("-d", $DbName, "-f", (Join-Path $sqlDir $f))) "Script $f"
    }
    $appPass = New-Secret 32; $bkpPass = New-Secret 32; $jwt = New-Secret 64
    Run "$pgBin\psql.exe" ($psql + @("-d", $DbName, "-c", "ALTER ROLE cashpro_app PASSWORD '$appPass'; ALTER ROLE cashpro_backup PASSWORD '$bkpPass';")) "Mots de passe des rôles"
  } else {
    Write-Host "Base « $DbName » déjà présente : données conservées."
    $appPass = $cfg.APP_DB_PASSWORD; $bkpPass = $cfg.BACKUP_DB_PASSWORD; $jwt = $cfg.JWT_SECRET
    if (-not $appPass -or -not $bkpPass -or -not $jwt) {
      # Installation précédente interrompue après la création de la base : nouveaux secrets (le superutilisateur est connu)
      Write-Host "Configuration incomplète : régénération des mots de passe des rôles applicatifs."
      $appPass = New-Secret 32; $bkpPass = New-Secret 32; $jwt = New-Secret 64
      Run "$pgBin\psql.exe" ($psql + @("-d", $DbName, "-c", "ALTER ROLE cashpro_app PASSWORD '$appPass'; ALTER ROLE cashpro_backup PASSWORD '$bkpPass';")) "Mots de passe des rôles"
    }
  }

  # Mises à jour de la base (scripts 07 et suivants, rejouables) : appliquées à chaque installation / mise à jour
  Get-ChildItem $sqlDir -Filter "*.sql" | Where-Object { $_.Name -match '^(0[7-9]|[1-9]\d)_' } | Sort-Object Name | ForEach-Object {
    Write-Host "  -> mise à jour $($_.Name)"
    Run "$pgBin\psql.exe" ($psql + @("-d", $DbName, "-f", $_.FullName)) "Mise à jour $($_.Name)"
  }

  # Dossier de configuration lisible seulement par les administrateurs et SYSTEM (SID, indépendant de la langue).
  # Les droits sont posés sur le DOSSIER ; le fichier les hérite (icacls /reset).
  & icacls "$DataRoot\config" /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" /Q | Out-Null
  @"
# CashPro — configuration du serveur (générée par l'installateur). Ne pas partager.
DATABASE_URL=postgresql://cashpro_app:$appPass@localhost:$pgPort/$DbName
BACKUP_DATABASE_URL=postgresql://cashpro_backup:$bkpPass@localhost:$pgPort/$DbName
APP_DB_PASSWORD=$appPass
BACKUP_DB_PASSWORD=$bkpPass
PG_SUPERUSER_PASSWORD=$superPass
PG_PORT=$pgPort
PG_BIN=$pgBin
JWT_SECRET=$jwt
JWT_TTL=12h
HOST=::
PORT=$ApiPort
DATA_DIR=$DataRoot
"@ | Set-Content -Path $envFile -Encoding UTF8
  & icacls $envFile /reset /Q | Out-Null

  # .pgpass du compte SYSTEM pour la sauvegarde automatique
  $pgpassDir = "C:\Windows\System32\config\systemprofile\AppData\Roaming\postgresql"
  New-Item -ItemType Directory -Force -Path $pgpassDir | Out-Null
  "localhost:${pgPort}:${DbName}:cashpro_backup:$bkpPass" | Set-Content -Path (Join-Path $pgpassDir "pgpass.conf") -Encoding ASCII

  # ------------------------------------------------------------------ 3b. Paquet de mise à jour des postes Windows
  Step "Mise à jour des postes (installateur client)"
  Unregister-ScheduledTask -TaskName "CashPro - Mise a jour" -Confirm:$false -ErrorAction SilentlyContinue
  $updSrc = Join-Path $Root "updates\client"
  $updDst = Join-Path $DataRoot "updates\client"
  if (Test-Path (Join-Path $updSrc "latest.yml")) {
    New-Item -ItemType Directory -Force -Path $updDst | Out-Null
    Get-ChildItem $updDst -File -ErrorAction SilentlyContinue | ForEach-Object { Remove-FileQuiet $_.FullName }
    Copy-Item (Join-Path $updSrc "*") $updDst -Force
    Write-Host "  Postes : $((Get-Content (Join-Path $updDst 'latest.yml') | Select-String '^version:') -replace 'version:\s*','')"
  } else {
    Write-Host "  Aucun installateur client dans ce paquet : étape ignorée"
  }
  # anciens installateurs serveur téléchargés : on garde les deux plus récents
  Get-ChildItem (Join-Path $DataRoot "updates\server") -Filter "CashPro-Server-Setup-*.exe" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -Skip 2 | ForEach-Object { Remove-FileQuiet $_.FullName }

  # ------------------------------------------------------------------ 4. API + interface
  Step "Service CashPro API"
  $task = "CashPro API"
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*$api*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  # Lanceur : sortie de l'API journalisée dans C:\CashPro\logs\api.log
  $launcher = Join-Path $Root "setup\run-api.cmd"
  @(
    "@echo off",
    "cd /d `"$api`"",
    "`"$node`" `"$api\dist\server.js`" >> `"$logs\api.log`" 2>&1"
  ) | Set-Content -Path $launcher -Encoding ASCII
  $action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$launcher`"`"" -WorkingDirectory $api
  $trigger   = New-ScheduledTaskTrigger -AtStartup
  $settings  = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) `
               -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
  Start-ScheduledTask -TaskName $task

  # ------------------------------------------------------------------ 4b. Ancien Tailscale intégré (≤ 1.1.x) : retiré
  # Depuis 1.2.0, la connexion à distance passe par un VPN installé à part (Tailscale officiel, ZeroTier…).
  $tnTask = "CashPro Tailscale"
  if (Get-ScheduledTask -TaskName $tnTask -ErrorAction SilentlyContinue) {
    Step "Retrait de l'ancien Tailscale intégré"
    Stop-ScheduledTask -TaskName $tnTask -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $tnTask -Confirm:$false -ErrorAction SilentlyContinue
  }
  Get-Process cashpro-tailnet -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $DataRoot "bin\cashpro-tailnet.exe") -Force -ErrorAction SilentlyContinue

  # ------------------------------------------------------------------ 5. Sauvegarde + pare-feu
  Step "Sauvegarde quotidienne (23:30)"
  $bkTask = "CashPro - Sauvegarde quotidienne"
  Unregister-ScheduledTask -TaskName $bkTask -Confirm:$false -ErrorAction SilentlyContinue
  $bkArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$Root\setup\backup.ps1`" -PgBin `"$pgBin`" -Port $pgPort"
  Register-ScheduledTask -TaskName $bkTask -Action (New-ScheduledTaskAction -Execute "powershell.exe" -Argument $bkArgs) `
    -Trigger (New-ScheduledTaskTrigger -Daily -At "23:30") -Principal $principal `
    -Settings (New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 2)) | Out-Null

  Step "Pare-feu (réseau local + Tailscale)"
  Get-NetFirewallRule -DisplayName "CashPro API*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
  New-NetFirewallRule -DisplayName "CashPro API (LAN)" -Direction Inbound -Protocol TCP -LocalPort $ApiPort -Profile Private, Domain -Action Allow | Out-Null
  New-NetFirewallRule -DisplayName "CashPro API (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort $ApiPort -RemoteAddress "100.64.0.0/10" -Action Allow | Out-Null

  # ------------------------------------------------------------------ vérification
  Step "Vérification"
  $h = $null
  for ($i = 0; $i -lt 60; $i++) {
    try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/api/health" -TimeoutSec 5; if ($h.ok) { break } } catch { }
    Start-Sleep -Seconds 1
  }
  if (-not $h -or -not $h.ok) {
    if (Test-Path "$logs\api.log") { Write-Host "--- api.log ---"; Get-Content "$logs\api.log" -Tail 40 }
    Get-ScheduledTaskInfo -TaskName $task | Format-List LastRunTime, LastTaskResult
    throw "L'API ne répond pas sur http://127.0.0.1:$ApiPort (voir $logs)"
  }
  $ips = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }).IPAddress
  # VPN installé à part (Tailscale officiel) : adresse du serveur sur ce réseau
  $vpn = @()
  $tsCli = @("$env:ProgramFiles\Tailscale\tailscale.exe", "${env:ProgramFiles(x86)}\Tailscale\tailscale.exe") | Where-Object { Test-Path $_ } | Select-Object -First 1
  if ($tsCli) {
    $tsIp = $null
    try { $tsIp = (& $tsCli ip -4 2>&1 | Where-Object { "$_" -match '^100\.' } | Select-Object -First 1) } catch {}
    if ($tsIp) { $vpn = @("  http://${tsIp}:$ApiPort (Tailscale)", "  http://$($env:COMPUTERNAME.ToLower()):$ApiPort (Tailscale MagicDNS)") }
  } else {
    $vpn = @("", "Accès à distance : installer Tailscale (https://tailscale.com/download) sur ce serveur et sur les postes / téléphones.")
  }
  $lines = @("CashPro $($h.version) installé et démarré.", "", "Adresse des autres postes :") + ($ips | ForEach-Object { "  http://${_}:$ApiPort" }) + $vpn + @("", "Première connexion : admin / CashPro@2026 (changement obligatoire)")
  $lines | Set-Content -Path (Join-Path $DataRoot "LISEZ-MOI.txt") -Encoding UTF8
  $lines | ForEach-Object { Write-Host $_ }
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Stop-Transcript | Out-Null
  exit 0
} catch {
  Write-Host "ERREUR : $_" -ForegroundColor Red
  Write-Host "  (ligne $($_.InvocationInfo.ScriptLineNumber) : $($_.InvocationInfo.Line.Trim()))"
  Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
  Stop-Transcript | Out-Null
  exit 1
}
