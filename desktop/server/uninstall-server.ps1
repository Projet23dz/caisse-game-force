<#
  CashPro — arrêt des services avant désinstallation ou mise à jour.
  Les DONNÉES (C:\CashPro : base, pièces jointes, sauvegardes, configuration) sont CONSERVÉES.
#>
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = "Continue"
if (Test-Path $Root) { $Root = (Resolve-Path $Root).Path }
$pgBin = Join-Path $Root "pgsql\bin"
foreach ($t in "CashPro API", "CashPro Tailscale", "CashPro - Sauvegarde quotidienne") {
  Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
}
Get-Process cashpro-tailnet -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$Root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (Get-Service "CashPro-PostgreSQL" -ErrorAction SilentlyContinue) {
  Stop-Service "CashPro-PostgreSQL" -Force -ErrorAction SilentlyContinue
  if (Test-Path "$pgBin\pg_ctl.exe") { & "$pgBin\pg_ctl.exe" unregister -N "CashPro-PostgreSQL" } else { & sc.exe delete "CashPro-PostgreSQL" | Out-Null }
}
Get-NetFirewallRule -DisplayName "CashPro API*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
exit 0
