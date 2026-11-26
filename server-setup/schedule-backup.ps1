<#
  CashPro — Programme la sauvegarde quotidienne (Planificateur de tâches Windows)
  À exécuter une fois, en administrateur.
#>
param(
  [string]$Time = "23:30",
  [string]$OffsitePath = ""   # ex : "E:\CashPro-Backups"
)
$script = Join-Path $PSScriptRoot "backup.ps1"
$taskArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$script`""
if ($OffsitePath) { $taskArgs += " -OffsitePath `"$OffsitePath`"" }
$action  = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName "CashPro - Sauvegarde quotidienne" -Action $action -Trigger $trigger `
  -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null
Write-Host "Sauvegarde programmée chaque jour à $Time." -ForegroundColor Green
Write-Host "Test immédiat : Start-ScheduledTask -TaskName 'CashPro - Sauvegarde quotidienne'"
