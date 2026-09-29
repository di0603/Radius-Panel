# didev-vpn-windows

Cliente VPN generico de bandeja para Windows, basado en el cliente nativo
IKEv2/EAP-TLS de Windows (RAS/VpnClient). No implementa IPsec ni modifica
`libcharon`. Mantiene los avisos de copyright y la licencia GPLv2 de los
componentes derivados de strongSwan.

Al abrir `didev-vpn.exe` aparece la ventana de conexiones. Al cerrarla, la
app queda en el area de notificacion; abrir el MSI solo instala la app y no
abre su ventana. Tras instalar, inicia didev VPN desde el acceso directo del
menu Inicio.

La aplicacion no contiene ninguna clave, certificado ni servidor de didev.
Puede guardar varias conexiones en `%LOCALAPPDATA%\didev-vpn`; cada una
conserva su certificado, estado y ancla de confianza.

## Primera conexion y confianza TOFU

Para obtener el fichero, en el panel abre **VPN > Dispositivos**, crea o
selecciona el dispositivo y pulsa **Generar token de alta**. Descarga el
perfil `.didevvpn` desde esa ficha cuando aparezca. El perfil lleva un token
de un solo uso y caduca junto al token; guardalo solo hasta importarlo. Si el
panel no ofrece el fichero, necesita tener configurada
`VPN_PROFILE_SIGNING_KEY` y la version de aprovisionamiento actualizada.

1. Abre didev VPN, pulsa **Añadir conexión** y selecciona el fichero
   `.didevvpn` descargado.
2. La app comprueba que el sobre `full` sea conocido, no este caducado, que
   `signerPublicKey` verifique la firma y que `signerKeySha256` corresponda
   exactamente a su SPKI DER. Tambien valida la cadena y `rootCaSha256`.
3. Para un servidor sin ancla aparece la pantalla con servidor, codigo corto
   y huellas completas del panel y de la raiz. El texto es: "Compara estas
   huellas con las que muestra el panel. Si no coinciden, cancela".
4. Solo al confirmar se guarda el ancla y se instala la raiz en
   `LocalMachine\Root` con una unica elevacion UAC. Si se cancela, no se crea
   la conexion ni se conserva el ancla.
5. Las importaciones y renovaciones posteriores del mismo servidor deben
   coincidir exactamente con ambas huellas. Un cambio muestra "la identidad
   del panel ha cambiado"; hay que quitar la conexion y volver a anadirla.

La variante `qr` no se acepta en esta app de Windows porque no contiene la
cadena completa; la app Android usa el mismo contrato y obtiene `/cacerts`.
El TLS de EST siempre se valida con la raiz del ancla.

## Estructura

`code/DidevVpn.Core` contiene verificacion de perfiles y logica portable.
`code/DidevVpn.App` contiene bandeja, RAS, certificados, renovacion y UI.
`code/DidevVpn.Tests` contiene los tests de la parte nueva y
`code/DidevVpn.Installer` el proyecto WiX. La lista de ficheros derivados de
strongSwan modificados se mantiene en `code/STRONGSWAN-FILES.md`.

## Compilar en Windows

Requiere .NET SDK 8 y, para el MSI, WiX v4/v5 con la extension Util. No se
necesita ningun fichero secreto del panel:

```powershell
cd APPS/Windows/code
dotnet tool install --global wix
wix extension add WixToolset.Util.wixext --global
./build.ps1 -Version 0.1.0
```

El script ejecuta los tests, publica el EXE self-contained single-file y la
variante para MSI, intenta generar el MSI y escribe `SHA256SUMS.txt`. Sin
`-SigningCertThumbprint` o `-SigningCertPath`, los artefactos quedan sin
firmar y el script lo avisa.

## Compilar en Linux

Con .NET SDK 8, `zip`, `sha256sum` y WiX disponible para .NET:

```bash
cd APPS/Windows/code
./build.sh 0.1.0
```

El script pasa `EnableWindowsTargeting=true` a `dotnet publish`. Si WiX no
puede crear el MSI fuera de Windows, se generan igualmente EXE, ZIP y hashes.
En Windows se puede repetir exactamente:

```powershell
./build.ps1 -Version 0.1.0
```

Los binarios de `APPS/Windows/ejecutables/` estan ignorados por git. El
portable se ejecuta desde cualquier carpeta; el MSI registra renovacion e
inicio automatico. La renovacion periodica consulta `/status` y bloquea el
alta o la renovacion si `minAppVersion` exige actualizar.

## Asociacion de la clave CNG al certificado (sin exportar la clave)

`CertificateEnrollmentService.AssociatePrivateKey` enlaza el certificado
emitido por EST a la clave CNG del dispositivo con
`CertSetCertificateContextProperty`/`CERT_KEY_PROV_INFO_PROP_ID`, sin pasar
por `CopyWithPrivateKey`/exportar a PKCS#12: una clave de TPM es
deliberadamente no exportable, y `CopyWithPrivateKey` fuerza justo eso
internamente. Antes de asociar se comparan las coordenadas publicas de la
clave y del certificado; despues de instalar en `CurrentUser\My`, se
comprueba que Windows recupera la clave privada y que una firma con ella
verifica contra el certificado. `DidevVpn.App.Tests` (proyecto `net8.0-windows`
aparte, no `DidevVpn.Tests`: necesita las APIs de Windows/CNG de verdad)
cubre esto con una clave de software y, si hay TPM en la maquina de build,
con una clave de TPM real.

## Comprobaciones manuales pendientes

En un Windows real hay que probar importacion confirmada y cancelada, cambio
de clave o raiz, UAC e instalacion de raiz, conexion y desconexion RAS,
renovacion con la VPN activa e inactiva, tarea del MSI y desinstalacion.
Tambien hay que comprobar SmartScreen y los mensajes de error con un panel
de pruebas (la asociacion de la clave CNG al certificado ya tiene cobertura
automatizada real, ver arriba).
