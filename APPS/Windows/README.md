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

## Rendimiento (prompt 12.7)

La app iba muy lenta: cada consulta de estado (existe/conectada/IP) lanzaba
un `powershell.exe` nuevo (con el modulo `VpnClient`), en el hilo de
interfaz, varias veces por conexion y varias veces por minuto (el menu de la
bandeja, la ventana cada 5s, la bandeja cada 15s). Con 3 conexiones, un solo
refresco podia tardar varios segundos y congelar la ventana.

- **Estado sin PowerShell**: `RasStateReader`
  (`DidevVpn.App/Services/Ras/`) usa P/Invoke directo a `rasapi32.dll`
  (`RasEnumConnectionsW`, `RasGetConnectStatusW`, `RasGetProjectionInfoW`
  para la IP, `RasEnumEntriesW` para saber si la conexion existe en la
  agenda). `VpnConnectionService.ConnectionExists`/`IsConnected`/
  `GetAssignedIPv4Address` lo usan primero, y solo caen de vuelta al camino
  antiguo por PowerShell si el P/Invoke fallara alguna vez (recordado para
  el resto de esa sesion de la app, no se reintenta en cada refresco).
  Conectar/desconectar ya no pasa por `powershell.exe` tampoco: llama a
  `rasdial.exe` directamente (un proceso en vez de dos). PowerShell queda
  SOLO para crear/actualizar/borrar la conexion (`Add-`/`Set-VpnConnection`),
  que solo ocurre en el alta.
  - **Hallazgo real verificado en esta maquina**: `RasEnumConnectionsW` y
    `RasEnumEntriesW` son tristemente estrictas con `dwSize` -a diferencia
    de casi cualquier otra API de Windows, NO aceptan "cualquier tamano
    igual o mayor que el minimo": exigen que coincida EXACTAMENTE con uno
    de varios tamanos de struct que reconocen, o devuelven
    `ERROR_INVALID_SIZE` (632)-. Los tamanos de `RasInterop.cs` estan
    verificados de verdad con un programa de sondeo (no versionado) que
    probo un rango de `dwSize` en esta maquina hasta encontrar los
    aceptados; con ellos se obtuvieron datos reales (la agenda de RAS de
    este equipo, con las conexiones VPN ya configuradas aqui, y `count=0`
    correctamente con ninguna conexion activa en ese momento).
    `RasGetConnectStatusW`/`RasGetProjectionInfoW` no mostraron el mismo
    problema (aceptaron el tamano, fallaron por "handle invalido" al
    probarlas sin ninguna conexion activa) pero **no se han podido probar
    contra una conexion realmente activa** en este entorno: si alguna vez
    fallaran con una VPN de verdad conectada, `VpnConnectionService` cae de
    vuelta a PowerShell automaticamente, nunca deja de funcionar.
- **Nada bloqueante en el hilo de interfaz**: conectar/desconectar, importar
  un perfil (alta completa) y renovar van en `Task.Run`, con el boton/menu
  correspondiente deshabilitado y "Trabajando..." mientras dura; la ventana
  sigue respondiendo (se puede mover, cambiar de conexion seleccionada,
  etc.) durante una operacion larga.
- **Refresco por eventos, cache compartida**: `ConnectionStateService` es
  la UNICA fuente del estado de todas las conexiones, para la bandeja y la
  ventana a la vez (antes cada una sondeaba por su cuenta). Se refresca con
  `NetworkChange.NetworkAddressChanged`/`NetworkAvailabilityChanged`
  (con un debounce de ~500ms: `DidevVpn.Core.Net.Debouncer`, varios eventos
  seguidos al reconectar un adaptador solo disparan un refresco) mas un
  temporizador de respaldo cada 30s. El refresco en si corre en un hilo de
  fondo; el resultado se entrega al hilo de interfaz con
  `SynchronizationContext`.
- **Sin parpadeo**: `ConnectionManagerForm.RefreshConnections` ya no hace
  `Controls.Clear()` + reconstruir todo en cada refresco -eso era buena
  parte de la sensacion de lentitud, aparte del propio coste de PowerShell-:
  solo anade/quita filas si la LISTA de conexiones cambia (alta/baja, raro),
  y actualiza los mismos `Label` en el sitio (`Text`/`ForeColor`) cuando
  solo cambia el estado (lo normal, en cada evento).
- **Arranque**: `PublishReadyToRun=true` en `DidevVpn.App.csproj` (aplica en
  las dos variantes, ya que las dos publican con `-r win-x64`). El portable
  single-file ya extraia solo los NATIVOS a `%TEMP%\.net\didev-vpn\` (nunca
  el bundle completo) desde antes de este prompt; se ha confirmado de nuevo
  con `IncludeNativeLibrariesForSelfExtract=true`: solo ~8MB (6 DLLs) en el
  primer arranque, cacheados entre ejecuciones de la misma version (no se
  repite en arranques siguientes).

### Medido de verdad en esta maquina (antes/despues)

**Arranque** (`WaitForInputIdle`, 5 ejecuciones cada uno, variante instalada
multi-fichero):

| | Sin ReadyToRun | Con ReadyToRun |
|---|---|---|
| Media | ~360 ms | ~241 ms |
| `didev-vpn.dll` | 116 KB | 300 KB (nativo embebido) |

Variante portable single-file: parecido en caliente (~250 ms las dos, el
coste dominante ahi es la extraccion/hosting de single-file, no el JIT), la
`.exe` sale ~15% mas grande con ReadyToRun (168 MB -> 194 MB): es el
compromiso pedido explicitamente (arranque vs tamano de descarga).

**Un refresco completo** (`EntryExists` + `GetState` por conexion; antes,
`Get-VpnConnection`/`.ConnectionStatus` por PowerShell):

| Conexiones | Antes (PowerShell) | Despues (RAS nativo) |
|---|---|---|
| 1 | ~1,1 s | ~14 ms |
| 3 | ~6,3 s | ~10 ms |

(La cifra "antes" son mediciones reales de `powershell.exe` + `Get-VpnConnection`/
`ConnectionStatus` en esta misma maquina, no una estimacion.)

## Comprobaciones manuales pendientes

En un Windows real hay que probar importacion confirmada y cancelada, cambio
de clave o raiz, UAC e instalacion de raiz, conexion y desconexion RAS,
renovacion con la VPN activa e inactiva, tarea del MSI y desinstalacion.
Tambien hay que comprobar SmartScreen y los mensajes de error con un panel
de pruebas (la asociacion de la clave CNG al certificado ya tiene cobertura
automatizada real, ver arriba). Del prompt 12.7 en concreto, queda sin
probar contra una conexion RAS **activa** de verdad: `RasGetConnectStatusW`/
`RasGetProjectionInfoW` (el camino nativo tiene un respaldo automatico por
PowerShell si fallaran, pero no se ha podido forzar ese caso aqui) y que el
estado "conectado"/la IP se reflejen correctamente en la bandeja y la
ventana con una VPN real conectada.
