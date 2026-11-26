<#
  CashPro — lance l'installation silencieuse d'une mise à jour du serveur.
  Appelé par l'API (compte SYSTEM) après téléchargement vérifié et sauvegarde réussie.
  L'installateur tourne dans une tâche planifiée distincte : il continue après l'arrêt de l'API,
  puis setup-server.ps1 redémarre les services. Les données de C:\CashPro sont conservées.
#>
param([Parameter(Mandatory = $true)][string]$Installer)
$ErrorActionPreference = "Stop"
if (-not (Test-Path $Installer)) { throw "Installateur introuvable : $Installer" }
$sig = Get-AuthenticodeSignature $Installer   # information seulement (installateur non signé)
Write-Host "$(Get-Date -Format s)  Mise à jour : $Installer ($($sig.Status))"
$task = "CashPro - Mise a jour"
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
$action    = New-ScheduledTaskAction -Execute $Installer -Argument "/S"
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $task -Action $action -Principal $principal -Settings $settings | Out-Null
Start-ScheduledTask -TaskName $task
Write-Host "$(Get-Date -Format s)  Installation lancée (tâche « $task »)."
exit 0
