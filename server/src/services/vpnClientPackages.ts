import { TarArchive, ZipArchive, type Archiver, type ArchiverOptions } from 'archiver';
import { conflict } from '../lib/http.js';
import { x509 } from '../lib/x509.js';
import { getCaChainPem } from './pki.js';
import { getDeviceDetail, type VpnDeviceDetail } from './vpnDevices.js';
import { getVpnSettings, type VpnSettings } from './vpnSettings.js';

/**
 * Paquete de conexion descargable desde la ficha del dispositivo: deja el
 * cliente (Windows o Linux/VPS) configurado para darse de alta y renovarse
 * solo por EST (RFC 7030). Nunca incluye claves ni el token de alta (el
 * token se pide por pantalla al ejecutar el script de alta); solo datos
 * publicos (ajustes de panel_vpn_settings, cadena de la CA) y el nombre del
 * dispositivo.
 */

const WINDOWS_CONNECTION_NAME = 'Casa';
/** Unico rango que enruta el modo "split" (VPS/servidores): la LAN de casa, ver CLAUDE.md. */
const HOME_LAN_CIDR = '192.168.10.0/24';
const FULL_TUNNEL_TS = '0.0.0.0/0,::/0';

interface PackageContext {
  username: string;
  tunnelMode: 'full' | 'split';
  vpnFqdn: string;
  aaaId: string;
  estBase: string;
  rootPem: string;
  intermediatePems: string[];
  chainPem: string;
}

/** Comilla simple para bash: cierra, escapa la comilla como '\'' y reabre. */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Distingue la raiz (autofirmada) de las intermedias en la cadena publicada por /pki/ca-chain.pem. */
function splitCaChain(chainPem: string): { rootPem: string; intermediatePems: string[] } {
  const certs = x509.PemConverter.decode(chainPem).map((der) => new x509.X509Certificate(der));
  const root = certs.find((c) => c.subject === c.issuer);
  if (!root) throw new Error('La cadena de la PKI no incluye ninguna raiz autofirmada');
  return {
    rootPem: root.toString(),
    intermediatePems: certs.filter((c) => c !== root).map((c) => c.toString()),
  };
}

async function buildContext(username: string): Promise<{ device: VpnDeviceDetail; ctx: PackageContext }> {
  const device = await getDeviceDetail(username);
  if (device.status === 'decommissioned') {
    throw conflict(`El dispositivo "${username}" esta dado de baja: no se puede generar un paquete`);
  }
  const settings: VpnSettings = await getVpnSettings();
  const chainPem = await getCaChainPem();
  if (!chainPem) throw conflict('La CA de la VPN todavia no esta configurada');
  const { rootPem, intermediatePems } = splitCaChain(chainPem);
  return {
    device,
    ctx: {
      username: device.username,
      tunnelMode: device.tunnelMode,
      vpnFqdn: settings.vpnFqdn,
      aaaId: settings.aaaId,
      estBase: `${settings.estUrl}/.well-known/est`,
      rootPem,
      intermediatePems,
      chainPem,
    },
  };
}

/* --------------------------------- Windows -------------------------------- */

function windowsConfigJson(ctx: PackageContext): string {
  const aaaCn = ctx.aaaId.replace(/^CN=/i, '');
  return JSON.stringify(
    {
      connectionName: WINDOWS_CONNECTION_NAME,
      server: ctx.vpnFqdn,
      serverName: aaaCn,
      splitTunnel: ctx.tunnelMode === 'split',
      username: ctx.username,
      estBase: ctx.estBase,
    },
    null,
    2,
  );
}

/**
 * Bloque [NewRequest] de certreq: clave ECDSA P-256 no exportable. `Provider`
 * se intenta primero con el TPM ("Microsoft Platform Crypto Provider") y,
 * si certreq falla (equipo sin TPM o sin acceso a el), con el proveedor de
 * software del propio Windows -la clave sigue sin ser exportable, solo que
 * no vive en el TPM.
 */
const CERTREQ_INF_TEMPLATE = String.raw`[NewRequest]
Subject = "CN=$($config.username)"
KeyAlgorithm = ECDSA_P256
KeyLength = 256
ProviderName = "$Provider"
KeyUsage = 0x80
MachineKeySet = true
Exportable = false
Silent = true
[EnhancedKeyUsageExtension]
OID = 1.3.6.1.5.5.7.3.2
`;

const WINDOWS_INSTALL_PS1 = String.raw`#Requires -RunAsAdministrator
<#
Instala la conexion IKEv2/EAP-TLS de este paquete (generado por Radius
Panel). No contiene ninguna clave privada ni el token de alta: eso lo pide
enroll.ps1, que se ejecuta despues de este script.
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content (Join-Path $here 'config.json') -Raw | ConvertFrom-Json

Write-Host "Importando la CA raiz en el almacen de confianza del equipo (LocalMachine\Root)..."
$rootCert = Import-Certificate -FilePath (Join-Path $here 'ca-root.pem') -CertStoreLocation Cert:\LocalMachine\Root

Get-ChildItem $here -Filter 'ca-intermediate-*.pem' | Sort-Object Name | ForEach-Object {
  Write-Host "Importando intermedia $($_.Name) en Cert:\LocalMachine\CA..."
  Import-Certificate -FilePath $_.FullName -CertStoreLocation Cert:\LocalMachine\CA | Out-Null
}

# Esquema EapHostConfig/EapTlsConnectionPropertiesV1 de Microsoft (EAP tipo 13
# = EAP-TLS). TrustedRootCA fija la huella de la raiz que se acaba de
# importar; ServerNames tiene que coincidir con el CN del certificado de
# FreeRADIUS (panel_vpn_settings.aaa_id) para que el cliente no acepte
# cualquier servidor que presente un certificado firmado por esa raiz.
$eapXml = @"
<EapHostConfig xmlns="http://www.microsoft.com/provisioning/EapHostConfig">
  <EapMethod>
    <Type xmlns="http://www.microsoft.com/provisioning/EapCommon">13</Type>
    <VendorId xmlns="http://www.microsoft.com/provisioning/EapCommon">0</VendorId>
    <VendorType xmlns="http://www.microsoft.com/provisioning/EapCommon">0</VendorType>
    <AuthorId xmlns="http://www.microsoft.com/provisioning/EapCommon">0</AuthorId>
  </EapMethod>
  <Config xmlns="http://www.microsoft.com/provisioning/EapHostConfig">
    <Eap xmlns="http://www.microsoft.com/provisioning/BaseEapConnectionPropertiesV1">
      <Type>13</Type>
      <EapType xmlns="http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV1">
        <CredentialsSource>
          <CertificateStore>
            <SimpleCertSelection>true</SimpleCertSelection>
          </CertificateStore>
        </CredentialsSource>
        <ServerValidation>
          <DisableUserPromptForServerValidation>true</DisableUserPromptForServerValidation>
          <ServerNames>$($config.serverName)</ServerNames>
          <TrustedRootCA>$($rootCert.Thumbprint)</TrustedRootCA>
        </ServerValidation>
        <DifferentUsername>false</DifferentUsername>
        <PerformServerValidation xmlns="http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV2">true</PerformServerValidation>
        <AcceptServerName xmlns="http://www.microsoft.com/provisioning/EapTlsConnectionPropertiesV2">true</AcceptServerName>
      </EapType>
    </Eap>
  </Config>
</EapHostConfig>
"@

if (Get-VpnConnection -Name $config.connectionName -AllUserConnection -ErrorAction SilentlyContinue) {
  Write-Host "Ya existe una conexion '$($config.connectionName)': se borra para recrearla con esta configuracion."
  Remove-VpnConnection -Name $config.connectionName -AllUserConnection -Force
}

Write-Host "Creando la conexion '$($config.connectionName)' hacia $($config.server)..."
$vpnParams = @{
  Name = $config.connectionName
  ServerAddress = $config.server
  TunnelType = 'Ikev2'
  AuthenticationMethod = 'Eap'
  EapConfigXmlStream = $eapXml
  SplitTunneling = [bool]$config.splitTunnel
  AllUserConnection = $true
  Force = $true
}
Add-VpnConnection @vpnParams

# GCMAES256 / SHA384 / ECP384 en las dos fases (IKE y ESP), a juego con el
# perfil ECDSA P-384 de la CA y el suite aes256gcm16-prfsha384-ecp384 del
# lado strongSwan.
$ipsecParams = @{
  ConnectionName = $config.connectionName
  AllUserConnection = $true
  AuthenticationTransformConstants = 'GCMAES256'
  CipherTransformConstants = 'GCMAES256'
  EncryptionMethod = 'GCMAES256'
  IntegrityCheckMethod = 'SHA384'
  DHGroup = 'ECP384'
  PfsGroup = 'ECP384'
  Force = $true
}
Set-VpnConnectionIPsecConfiguration @ipsecParams

Write-Host ""
Write-Host "Conexion creada. Ejecuta ahora .\enroll.ps1 (con el token de alta) para pedir el certificado del dispositivo."
`;

const WINDOWS_ENROLL_PS1 = String.raw`<#
Da de alta el certificado del dispositivo por EST (RFC 7030, simpleenroll):
genera la clave en el TPM (no exportable) y pide el certificado con el
token de alta de un solo uso. Ejecutar una vez, despues de install.ps1.
#>
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content (Join-Path $here 'config.json') -Raw | ConvertFrom-Json
$stateDir = Join-Path $env:ProgramData 'didev-vpn'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$stateFile = Join-Path $stateDir 'state.json'

function New-DeviceCsr {
  param([string]$Provider)
  $inf = New-TemporaryFile
  $csrPath = "$inf.csr"
  @"
${CERTREQ_INF_TEMPLATE}"@ | Set-Content -Path $inf -Encoding ASCII
  certreq -q -new $inf $csrPath | Out-Null
  Remove-Item $inf -ErrorAction SilentlyContinue
  return $csrPath
}

function ConvertTo-Pkcs10Base64 {
  param([string]$Path)
  (Get-Content $Path | Where-Object { $_ -notmatch '-----' }) -join ''
}

Write-Host "Generando la clave del dispositivo (se intenta primero en el TPM)..."
try {
  $csrPath = New-DeviceCsr -Provider 'Microsoft Platform Crypto Provider'
} catch {
  Write-Warning "No se pudo usar el TPM (Microsoft Platform Crypto Provider): $($_.Exception.Message)"
  Write-Warning 'Se usara el proveedor de software (la clave sigue sin ser exportable, pero no vive en el TPM).'
  $csrPath = New-DeviceCsr -Provider 'Microsoft Software Key Storage Provider'
}

$csrBase64 = ConvertTo-Pkcs10Base64 -Path $csrPath

$securePassword = Read-Host -Prompt "Token de alta para $($config.username)" -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $token = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
}
$authHeader = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$($config.username):$token"))
$token = $null

Write-Host 'Enviando la peticion de alta (simpleenroll)...'
$enrollParams = @{
  Uri = "$($config.estBase)/simpleenroll"
  Method = 'Post'
  Headers = @{ Authorization = $authHeader }
  ContentType = 'application/pkcs10'
  Body = $csrBase64
}
$response = Invoke-WebRequest @enrollParams

$p7bPath = "$csrPath.p7b"
[IO.File]::WriteAllBytes($p7bPath, [Convert]::FromBase64String($response.Content))
certreq -q -accept $p7bPath | Out-Null

$cert = Get-ChildItem Cert:\LocalMachine\My |
  Where-Object { $_.Subject -eq "CN=$($config.username)" } |
  Sort-Object NotBefore -Descending | Select-Object -First 1
if (-not $cert) { throw 'El certificado no aparece en Cert:\LocalMachine\My tras certreq -accept.' }

@{ username = $config.username; thumbprint = $cert.Thumbprint } |
  ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
Remove-Item $csrPath, $p7bPath -ErrorAction SilentlyContinue

Write-Host "Certificado instalado (huella $($cert.Thumbprint)). La conexion '$($config.connectionName)' ya puede usarlo."

$renewScript = Join-Path $here 'renew.ps1'
$renewArgs = '-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $renewScript
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $renewArgs
$triggers = @(
  New-ScheduledTaskTrigger -Daily -At 3am
  New-ScheduledTaskTrigger -AtLogOn
)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$taskParams = @{
  TaskName = 'Didev VPN - renovar certificado'
  Action = $action
  Trigger = $triggers
  Principal = $principal
  Force = $true
}
Register-ScheduledTask @taskParams | Out-Null
Write-Host "Tarea programada 'Didev VPN - renovar certificado' registrada (diaria a las 03:00 y al iniciar sesion)."
`;

const WINDOWS_RENEW_PS1 = String.raw`<#
Renueva el certificado del dispositivo por EST (simplereenroll) si el
servidor indica que toca (GET /status). Pensado para el Programador de
tareas (lo registra enroll.ps1); no pide nada por pantalla.
#>
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$config = Get-Content (Join-Path $here 'config.json') -Raw | ConvertFrom-Json
$stateDir = Join-Path $env:ProgramData 'didev-vpn'
$stateFile = Join-Path $stateDir 'state.json'
$logFile = Join-Path $stateDir 'renew.log'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null

function Write-Log([string]$msg) {
  "$(Get-Date -Format s) $msg" | Add-Content -Path $logFile
}

function New-DeviceCsr {
  param([string]$Provider)
  $inf = New-TemporaryFile
  $csrPath = "$inf.csr"
  @"
${CERTREQ_INF_TEMPLATE}"@ | Set-Content -Path $inf -Encoding ASCII
  certreq -q -new $inf $csrPath | Out-Null
  Remove-Item $inf -ErrorAction SilentlyContinue
  return $csrPath
}

function ConvertTo-Pkcs10Base64 {
  param([string]$Path)
  (Get-Content $Path | Where-Object { $_ -notmatch '-----' }) -join ''
}

try {
  if (-not (Test-Path $stateFile)) { throw 'No hay ningun certificado dado de alta todavia (ejecuta enroll.ps1 primero).' }
  $state = Get-Content $stateFile -Raw | ConvertFrom-Json
  $oldCert = Get-Item "Cert:\LocalMachine\My\$($state.thumbprint)" -ErrorAction Stop

  $status = Invoke-RestMethod -Uri "$($config.estBase)/status" -Certificate $oldCert
  if (-not $status.renewDue) {
    Write-Log "Certificado $($state.thumbprint) todavia vigente (caduca $($status.notAfter)): nada que hacer."
    exit 0
  }
  Write-Log "Toca renovar (caduca $($status.notAfter)). Generando clave nueva..."

  try {
    $csrPath = New-DeviceCsr -Provider 'Microsoft Platform Crypto Provider'
  } catch {
    Write-Log 'Sin TPM disponible, se usa el proveedor de software.'
    $csrPath = New-DeviceCsr -Provider 'Microsoft Software Key Storage Provider'
  }
  $csrBase64 = ConvertTo-Pkcs10Base64 -Path $csrPath

  $reenrollParams = @{
    Uri = "$($config.estBase)/simplereenroll"
    Method = 'Post'
    Certificate = $oldCert
    ContentType = 'application/pkcs10'
    Body = $csrBase64
  }
  $response = Invoke-WebRequest @reenrollParams

  $p7bPath = "$csrPath.p7b"
  [IO.File]::WriteAllBytes($p7bPath, [Convert]::FromBase64String($response.Content))
  certreq -q -accept $p7bPath | Out-Null

  $newCert = Get-ChildItem Cert:\LocalMachine\My |
    Where-Object { $_.Subject -eq "CN=$($config.username)" -and $_.Thumbprint -ne $oldCert.Thumbprint } |
    Sort-Object NotBefore -Descending | Select-Object -First 1
  if (-not $newCert) { throw 'El certificado renovado no aparece en Cert:\LocalMachine\My.' }

  @{ username = $config.username; thumbprint = $newCert.Thumbprint } |
    ConvertTo-Json | Set-Content -Path $stateFile -Encoding UTF8
  Remove-Item $csrPath, $p7bPath -ErrorAction SilentlyContinue

  Write-Log "Renovado: $($oldCert.Thumbprint) -> $($newCert.Thumbprint). El nuevo ya esta instalado: se borra el anterior."
  Remove-Item "Cert:\LocalMachine\My\$($oldCert.Thumbprint)" -DeleteKey -ErrorAction SilentlyContinue
  Write-Log 'Renovacion completada.'
} catch {
  Write-Log "ERROR: $($_.Exception.Message)"
  throw
}
`;

const WINDOWS_README = `Paquete de conexion VPN (IKEv2 / EAP-TLS) para este dispositivo
================================================================

Contenido:
- config.json                          datos publicos de conexion (sin secretos)
- ca-root.pem / ca-intermediate-*.pem  cadena de la CA de la VPN (publica)
- install.ps1                          crea la conexion VPN (una vez, como Administrador)
- enroll.ps1                           pide el certificado del dispositivo (una vez, con el token de alta)
- renew.ps1                            renueva el certificado automaticamente (lo programa enroll.ps1)

Pasos:
1. Clic derecho sobre PowerShell > "Ejecutar como administrador".
2. Ve a la carpeta donde has descomprimido este paquete (cd ...).
3. .\\install.ps1
4. .\\enroll.ps1   (te pedira el token de alta: pegalo y pulsa Intro)

La clave privada del dispositivo se genera en el TPM del equipo (o, si no
hay TPM, con el proveedor de software de Windows) y no es exportable: nunca
sale del equipo. Este paquete no contiene ninguna clave ni el token de
alta; el token se pide por pantalla al ejecutar enroll.ps1 y no se guarda
en ningun sitio.

Registro de renovaciones: %ProgramData%\\didev-vpn\\renew.log
`;

async function buildWindowsPackage(ctx: PackageContext): Promise<Buffer> {
  return archiveToBuffer('zip', { zlib: { level: 9 } }, (archive) => {
    archive.append(windowsConfigJson(ctx), { name: 'config.json' });
    archive.append(WINDOWS_INSTALL_PS1, { name: 'install.ps1' });
    archive.append(WINDOWS_ENROLL_PS1, { name: 'enroll.ps1' });
    archive.append(WINDOWS_RENEW_PS1, { name: 'renew.ps1' });
    archive.append(WINDOWS_README, { name: 'README.txt' });
    archive.append(ctx.rootPem, { name: 'ca-root.pem' });
    ctx.intermediatePems.forEach((pem, i) => {
      archive.append(pem, { name: `ca-intermediate-${i + 1}.pem` });
    });
  });
}

/* ---------------------------------- Linux ---------------------------------- */

function linuxConfigSh(ctx: PackageContext): string {
  const keyFile = `/etc/swanctl/ecdsa/${ctx.username}.pem`;
  const certFile = `/etc/swanctl/x509/${ctx.username}.pem`;
  const caFile = '/etc/swanctl/x509ca/ca-chain.pem';
  return `# Generado por Radius Panel. Datos publicos de conexion, sin secretos.
USERNAME=${shQuote(ctx.username)}
EST_BASE=${shQuote(ctx.estBase)}
VPN_FQDN=${shQuote(ctx.vpnFqdn)}
KEY_FILE=${shQuote(keyFile)}
CERT_FILE=${shQuote(certFile)}
CA_FILE=${shQuote(caFile)}
`;
}

function renderCasaConf(ctx: PackageContext): string {
  const remoteTs = ctx.tunnelMode === 'split' ? HOME_LAN_CIDR : FULL_TUNNEL_TS;
  const remoteId = ctx.aaaId.replace(/"/g, '\\"');
  return `connections {
   casa {
      version = 2
      remote_addrs = ${ctx.vpnFqdn}
      local {
         auth = eap-tls
         eap_id = ${ctx.username}
         certs = ${ctx.username}.pem
      }
      remote {
         auth = pubkey
         id = "${remoteId}"
      }
      vips = 0.0.0.0
      children {
         casa {
            remote_ts = ${remoteTs}
            esp_proposals = aes256gcm16-prfsha384-ecp384
         }
      }
      proposals = aes256gcm16-prfsha384-ecp384
   }
}
`;
}

const LINUX_ENROLL_SH = String.raw`#!/usr/bin/env bash
# Da de alta el certificado del dispositivo por EST (RFC 7030, simpleenroll).
# El token de alta se lee de la entrada estandar (nunca como argumento: no
# debe quedar en el historial de la shell ni ser visible con "ps").
set -euo pipefail
here="$(cd "$(dirname "$BASH_SOURCE")" && pwd)"
# shellcheck source=config.sh
. "$here/config.sh"

umask 077
mkdir -p "$(dirname "$KEY_FILE")" "$(dirname "$CERT_FILE")"

csr_file="$(mktemp)"
resp_file="$(mktemp)"
trap 'rm -f "$csr_file" "$resp_file"' EXIT

echo "Generando la clave ECDSA P-384 del dispositivo en $KEY_FILE..."
openssl ecparam -name secp384r1 -genkey -noout -out "$KEY_FILE"
chmod 600 "$KEY_FILE"

openssl req -new -key "$KEY_FILE" -subj "/CN=$USERNAME" -out "$csr_file"
csr_b64="$(grep -v -- '-----' "$csr_file" | tr -d '\n')"

read -r -s -p "Token de alta para $USERNAME: " token
echo
auth="$(printf '%s:%s' "$USERNAME" "$token" | base64 -w0)"
unset token

curl -sS --fail --cacert "$CA_FILE" \
  -H "Authorization: Basic $auth" \
  -H 'Content-Type: application/pkcs10' \
  --data "$csr_b64" \
  "$EST_BASE/simpleenroll" -o "$resp_file"
unset auth

base64 -d "$resp_file" | openssl pkcs7 -inform DER -print_certs -out "$CERT_FILE"

echo "Certificado instalado en $CERT_FILE. Cargando credenciales en strongSwan..."
swanctl --load-creds
echo 'Alta completada.'
`;

const LINUX_RENEW_SH = String.raw`#!/usr/bin/env bash
# Renueva el certificado del dispositivo por EST (simplereenroll) si el
# servidor indica que toca (GET /status). Pensado para vpn-renew.timer; no
# pide nada por pantalla. Conserva la clave y el certificado anteriores
# hasta comprobar que la conexion "casa" arranca con los nuevos, y solo
# entonces los borra; si no arranca, los restaura.
set -euo pipefail
here="$(cd "$(dirname "$BASH_SOURCE")" && pwd)"
# shellcheck source=config.sh
. "$here/config.sh"

if [ ! -s "$KEY_FILE" ] || [ ! -s "$CERT_FILE" ]; then
  echo 'No hay ningun certificado dado de alta todavia (ejecuta vpn-enroll primero).' >&2
  exit 1
fi

status_json="$(curl -sS --fail --cacert "$CA_FILE" --cert "$CERT_FILE" --key "$KEY_FILE" "$EST_BASE/status")"
renew_due="$(printf '%s' "$status_json" | grep -o '"renewDue":[a-z]*' | cut -d: -f2)"

if [ "$renew_due" != 'true' ]; then
  echo 'Certificado todavia vigente: nada que hacer.'
  exit 0
fi

echo 'Toca renovar. Generando clave nueva...'
umask 077
new_key="$(mktemp)"
csr_file="$(mktemp)"
resp_file="$(mktemp)"
new_cert="$(mktemp)"
trap 'rm -f "$new_key" "$csr_file" "$resp_file" "$new_cert"' EXIT

openssl ecparam -name secp384r1 -genkey -noout -out "$new_key"
chmod 600 "$new_key"
openssl req -new -key "$new_key" -subj "/CN=$USERNAME" -out "$csr_file"
csr_b64="$(grep -v -- '-----' "$csr_file" | tr -d '\n')"

curl -sS --fail --cacert "$CA_FILE" --cert "$CERT_FILE" --key "$KEY_FILE" \
  -H 'Content-Type: application/pkcs10' \
  --data "$csr_b64" \
  "$EST_BASE/simplereenroll" -o "$resp_file"

base64 -d "$resp_file" | openssl pkcs7 -inform DER -print_certs -out "$new_cert"

old_key_backup="$KEY_FILE.old"
old_cert_backup="$CERT_FILE.old"
cp "$KEY_FILE" "$old_key_backup"
cp "$CERT_FILE" "$old_cert_backup"

mv "$new_key" "$KEY_FILE"
chmod 600 "$KEY_FILE"
mv "$new_cert" "$CERT_FILE"
swanctl --load-creds

if swanctl --initiate --child casa --timeout 15 >/dev/null 2>&1; then
  echo 'Certificado renovado y verificado (conexion "casa" establecida). Borrando el certificado anterior.'
  rm -f "$old_key_backup" "$old_cert_backup"
else
  echo 'No se pudo establecer la conexion con el certificado nuevo: se restaura el anterior.' >&2
  mv "$old_key_backup" "$KEY_FILE"
  mv "$old_cert_backup" "$CERT_FILE"
  swanctl --load-creds
  exit 1
fi
`;

const LINUX_SYSTEMD_SERVICE = `[Unit]
Description=Renovacion automatica del certificado VPN (EST)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/opt/vpn-client/vpn-renew
`;

const LINUX_SYSTEMD_TIMER = `[Unit]
Description=Comprueba a diario si toca renovar el certificado VPN

[Timer]
OnCalendar=daily
RandomizedDelaySec=3600
Persistent=true

[Install]
WantedBy=timers.target
`;

const LINUX_README = `Paquete de conexion VPN (IKEv2 / EAP-TLS) para este dispositivo
================================================================

Contenido:
- config.sh                       datos publicos de conexion (sin secretos)
- ca-chain.pem                    cadena de la CA de la VPN (publica)
- casa.conf                       fragmento de swanctl.conf para esta conexion
- vpn-enroll                      pide el certificado del dispositivo (una vez, con el token de alta)
- vpn-renew                       renueva el certificado si toca (pensado para el timer)
- vpn-renew.service / .timer      unidades systemd para automatizar vpn-renew

Instalacion (como root):

  mkdir -p /opt/vpn-client
  cp config.sh vpn-enroll vpn-renew /opt/vpn-client/
  chmod 700 /opt/vpn-client/vpn-enroll /opt/vpn-client/vpn-renew
  mkdir -p /etc/swanctl/x509ca
  cp ca-chain.pem /etc/swanctl/x509ca/
  cp casa.conf /etc/swanctl/conf.d/
  cp vpn-renew.service vpn-renew.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now vpn-renew.timer

Alta (una vez):

  /opt/vpn-client/vpn-enroll

Pide el token de alta por la entrada estandar (nunca como argumento, para
que no quede en el historial de la shell ni sea visible con \`ps\`). La
clave privada se genera en este mismo host (ECDSA P-384, permisos 600) y no
sale de aqui; este paquete no contiene ninguna clave ni el token de alta.

Nota: si tu strongSwan tiene activo el plugin "resolve" y no recibe el DNS
del servidor, anade en strongswan.conf: charon.plugins.resolve.load = no
`;

async function buildLinuxPackage(ctx: PackageContext): Promise<Buffer> {
  return archiveToBuffer('tar', { gzip: true, gzipOptions: { level: 9 } }, (archive) => {
    const dir = 'vpn-client';
    archive.append(linuxConfigSh(ctx), { name: `${dir}/config.sh` });
    archive.append(renderCasaConf(ctx), { name: `${dir}/casa.conf` });
    archive.append(LINUX_ENROLL_SH, { name: `${dir}/vpn-enroll`, mode: 0o700 });
    archive.append(LINUX_RENEW_SH, { name: `${dir}/vpn-renew`, mode: 0o700 });
    archive.append(LINUX_SYSTEMD_SERVICE, { name: `${dir}/vpn-renew.service` });
    archive.append(LINUX_SYSTEMD_TIMER, { name: `${dir}/vpn-renew.timer` });
    archive.append(LINUX_README, { name: `${dir}/README.txt` });
    archive.append(ctx.chainPem, { name: `${dir}/ca-chain.pem` });
  });
}

/* -------------------------------- Empaquetado ------------------------------- */

function archiveToBuffer(
  format: 'zip' | 'tar',
  options: ArchiverOptions,
  build: (archive: Archiver) => void,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const archive = format === 'zip' ? new ZipArchive(options) : new TarArchive(options);
    const chunks: Buffer[] = [];
    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('warning', (err) => {
      if (err.code !== 'ENOENT') reject(err);
    });
    archive.on('error', reject);
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    build(archive);
    void archive.finalize();
  });
}

export interface DevicePackage {
  filename: string;
  contentType: string;
  buffer: Buffer;
}

/**
 * Genera el paquete de conexion para un dispositivo windows/linux. Android
 * no tiene paquete descargable todavia (se configura a mano en la app de
 * strongSwan): pide uno y devuelve 409.
 */
export async function buildDevicePackage(username: string): Promise<DevicePackage> {
  const { device, ctx } = await buildContext(username);

  if (device.platform === 'windows') {
    return {
      filename: `vpn-${device.username}-windows.zip`,
      contentType: 'application/zip',
      buffer: await buildWindowsPackage(ctx),
    };
  }
  if (device.platform === 'linux') {
    return {
      filename: `vpn-${device.username}-linux.tar.gz`,
      contentType: 'application/gzip',
      buffer: await buildLinuxPackage(ctx),
    };
  }
  throw conflict(
    `Los dispositivos "${device.platform}" todavia no tienen un paquete de conexion: configura la app de strongSwan a mano`,
  );
}

// Exportado solo para los tests (snapshot de las plantillas sin pasar por archiver).
export const __testing = {
  windowsConfigJson,
  linuxConfigSh,
  renderCasaConf,
  splitCaChain,
  WINDOWS_INSTALL_PS1,
  WINDOWS_ENROLL_PS1,
  WINDOWS_RENEW_PS1,
  WINDOWS_README,
  LINUX_ENROLL_SH,
  LINUX_RENEW_SH,
  LINUX_SYSTEMD_SERVICE,
  LINUX_SYSTEMD_TIMER,
  LINUX_README,
};
