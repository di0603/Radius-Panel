<#
Instala didev-root-ca.cer en LocalMachine\Root durante la instalacion
elevada del MSI, para que no haga falta ningun UAC en tiempo de ejecucion en
la variante instalada (a diferencia de la portable, que lo pide la primera
vez que hace falta). Idempotente: Import-Certificate no duplica si ya esta.
#>
param(
    [Parameter(Mandatory = $true)][string]$CertificatePath
)
$ErrorActionPreference = 'Stop'
Import-Certificate -FilePath $CertificatePath -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
Write-Host "Raiz de didev instalada en LocalMachine\Root."
