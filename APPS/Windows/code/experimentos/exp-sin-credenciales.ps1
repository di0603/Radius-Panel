<#
.SYNOPSIS
    Experimento: hace falta guardar las credenciales EAP (RasSetEapUserData)
    para que rasdial conecte sin dialogo cuando solo hay UN candidato

.DESCRIPTION
    Clona una conexion ya existente de la app -mismo XML EAP, mismo servidor,
    mismos parametros IPsec que aplica la app- en una entrada de prueba SIN
    credenciales EAP guardadas, lanza `rasdial` y borra la entrada de prueba.
    No toca la conexion original ni ningun certificado. No lee ni escribe
    claves, tokens ni contrasenas.

    Resultado:
      exit=0 y estado Connected  -> con un solo candidato NO hace falta guardar
                                    las credenciales (el filtro por emisor y
                                    SimpleCertSelection bastan).
      exit=703                   -> Windows necesito el selector: guardarlas SI
                                    aporta algo en este caso.
      exit=798                   -> no hay certificado utilizable (cadena sin
                                    raiz de confianza, o caducado).

    Para el caso de DOS candidatos del mismo emisor ver el test
    DidevVpn.App.Tests\SameIssuerTwoConnectionsTests (requiere administrador).

    NOTA: conecta de verdad con el servidor de la conexion clonada (una vez, y
    se desconecta al terminar). Medido el 2026-10-01: exit=0.

.PARAMETER RealConnection
    Nombre de la conexion existente que se clona (p.ej. vpn-diego-portatil-hp).

.EXAMPLE
    .\exp-sin-credenciales.ps1 -RealConnection vpn-diego-portatil-hp
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RealConnection
)

$ErrorActionPreference = 'Stop'
$experiment = 'didev-exp-sincreds'
$disconnect = '/disconnect'

& rasdial.exe $RealConnection $disconnect | Out-Null
$source = Get-VpnConnection -Name $RealConnection
$candidates = @(Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.HasPrivateKey }).Count
"Certificados con clave privada en CurrentUser\My: $candidates (ojo: el experimento solo es limpio si hay UN candidato del emisor)"

try {
    if (Get-VpnConnection -Name $experiment -ErrorAction SilentlyContinue) {
        Remove-VpnConnection -Name $experiment -Force
    }
    Add-VpnConnection -Name $experiment -ServerAddress $source.ServerAddress -TunnelType Ikev2 `
        -AuthenticationMethod Eap -EapConfigXmlStream $source.EapConfigXmlStream -Force
    Set-VpnConnectionIPsecConfiguration -ConnectionName $experiment `
        -AuthenticationTransformConstants GCMAES256 -CipherTransformConstants GCMAES256 `
        -EncryptionMethod GCMAES256 -IntegrityCheckMethod SHA384 -DHGroup ECP384 -PfsGroup ECP384 -Force

    $output = & rasdial.exe $experiment 2>&1 | Out-String
    $exit = $LASTEXITCODE
    "rasdial SIN credenciales EAP guardadas: exit=$exit"
    ($output -replace '\s+', ' ').Trim()
    'Estado: ' + (Get-VpnConnection -Name $experiment).ConnectionStatus
}
finally {
    & rasdial.exe $experiment $disconnect | Out-Null
    Remove-VpnConnection -Name $experiment -Force -ErrorAction SilentlyContinue
    'Entrada de prueba borrada: ' + (-not (Get-VpnConnection -Name $experiment -ErrorAction SilentlyContinue))
}
