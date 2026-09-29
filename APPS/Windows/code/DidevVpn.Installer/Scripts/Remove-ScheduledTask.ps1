<#
Contrapartida de Install-ScheduledTask.ps1: se llama en la desinstalacion
(REMOVE="ALL"). No falla la desinstalacion si la tarea ya no existe.
#>
$ErrorActionPreference = 'SilentlyContinue'
schtasks /delete /tn 'didevVpnRenewal' /f | Out-Null
exit 0
