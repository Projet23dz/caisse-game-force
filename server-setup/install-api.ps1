<#
  CashPro — Installation de l'API sur le serveur Windows (après install-database.ps1)
  Prérequis : Node.js 22 LTS ou plus récent (https://nodejs.org)
  Exécuter dans PowerShell en administrateur, depuis le dossier server-setup :
      powershell -ExecutionPolicy Bypass -File .\install-api.ps1

  Ce que fait le script :
    1. copie l'API (C:\CashPro\api) et l'interface (C:\CashPro\client), installe les dépendances et compile les deux ;
    2. crée la tâche planifiée « CashPro API » (démarre avec Windows, compte SYSTEM, redémarre si arrêt) ;
    3. ouvre le port 4600 dans le pare-feu, uniquement pour le réseau local et Tailscale ;
    4. vérifie que l'API répond.
#>
param(
  [string]$Source = (Join-Path $PSScriptRoot "..\api"),
  [string]$ClientSource = (Join-Path $PSScriptRoot "..\client"),
  [string]$Target = "C:\CashPro\api",
  [int]$Port = 4600
)
$ErrorActionPreference = "Stop"
Write-Host "=== CashPro : installation de l'API ===" -ForegroundColor Yellow

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "Node.js introuvable. Installez Node.js 22 LTS puis relancez." }
$major = [int]((& node -p "process.versions.node.split('.')[0]"))
if ($major -lt 22) { throw "Node.js $major détecté : la version 22 ou plus est requise." }
if (-not (Test-Path "C:\CashPro\config\cashpro.env")) { throw "C:\CashPro\config\cashpro.env manquant : lancez d'abord install-database.ps1" }

# 1. Copie + dépendances + compilation
New-Item -ItemType Directory -Force -Path $Target | Out-Null
robocopy $Source $Target /E /XD node_modules dist data /NFL /NDL /NJH /NJS | Out-Null
# Interface (servie par l'API) : C:\CashPro\client — l'API la cherche en ..\..\client\public depuis dist
robocopy $ClientSource (Join-Path (Split-Path $Target -Parent) "client") /E /XD js /NFL /NDL /NJH /NJS | Out-Null
Push-Location $Target
try {
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { & npm install --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { throw "npm install a échoué" }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw "Compilation échouée" }
} finally { Pop-Location }

# 2. Tâche planifiée : démarrage automatique + redémarrage en cas d'arrêt
$taskName = "CashPro API"
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
$action   = New-ScheduledTaskAction -Execute $node -Argument "`"$Target\dist\server.js`"" -WorkingDirectory $Target
$trigger  = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
            -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
Start-ScheduledTask -TaskName $taskName

# 3. Pare-feu : réseau privé (LAN) + plage Tailscale 100.64.0.0/10 ; jamais Internet public
Get-NetFirewallRule -DisplayName "CashPro API*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "CashPro API (LAN)" -Direction Inbound -Protocol TCP -LocalPort $Port -Profile Private -Action Allow | Out-Null
New-NetFirewallRule -DisplayName "CashPro API (Tailscale)" -Direction Inbound -Protocol TCP -LocalPort $Port -RemoteAddress "100.64.0.0/10" -Action Allow | Out-Null

# 4. Vérification
Start-Sleep -Seconds 4
try {
  $h = Invoke-RestMethod -Uri "http://localhost:$Port/api/health" -TimeoutSec 10
  Write-Host ""
  Write-Host "API opérationnelle : CashPro $($h.version)" -ForegroundColor Green
  $ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" }).IPAddress
  Write-Host "  Adresses à saisir dans l'application :"
  foreach ($ip in $ips) { Write-Host "    http://${ip}:$Port" }
  Write-Host "    http://cashpro-server:$Port   (Tailscale MagicDNS)"
  Write-Host "  Interface web (navigateur / téléphone) : même adresse." 
} catch {
  Write-Host "L'API ne répond pas encore. Vérifiez : Get-ScheduledTask -TaskName '$taskName' | Get-ScheduledTaskInfo" -ForegroundColor Red
  throw
}
