<#
Registra la tarea "didevVpnRenewal" para TODOS los usuarios (logon + cada
12h): la ejecuta el instalador (MSI) como custom action elevada, una sola
vez durante la instalacion. Ver APPS/Windows/NOTAS-prompt-12-en-pausa.md,
punto 8: hace falta el XML completo (no el "/sc ONLOGON" simple de schtasks)
para poder combinar un LogonTrigger sin UserId (aplica a cualquier usuario
del grupo) con un TimeTrigger de repeticion cada 12h en la MISMA tarea.
#>
param(
    [Parameter(Mandatory = $true)][string]$ExecutablePath
)
$ErrorActionPreference = 'Stop'

$taskName = 'didevVpnRenewal'
$taskXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Renueva el certificado de didev VPN si toca, para cualquier usuario que inicie sesion.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT12H</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2026-01-01T03:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <GroupId>S-1-5-32-545</GroupId>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT5M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>"$ExecutablePath"</Command>
      <Arguments>--renew-silent</Arguments>
    </Exec>
  </Actions>
</Task>
"@

$taskXmlPath = Join-Path $env:TEMP "didev-vpn-task-$([guid]::NewGuid().ToString('N')).xml"
try {
    # UTF-16 LE con BOM: es lo que exige schtasks /xml para archivos de definicion de tareas.
    [System.IO.File]::WriteAllText($taskXmlPath, $taskXml, [System.Text.Encoding]::Unicode)
    schtasks /create /tn $taskName /xml $taskXmlPath /f | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "schtasks /create devolvio el codigo $LASTEXITCODE"
    }
    Write-Host "Tarea '$taskName' registrada para todos los usuarios."
}
finally {
    Remove-Item -Path $taskXmlPath -ErrorAction SilentlyContinue
}
