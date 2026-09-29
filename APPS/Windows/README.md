# didev-vpn-windows

Aplicacion de bandeja del sistema (C# / .NET 8, WinForms) que configura y
mantiene la VPN IKEv2/EAP-TLS de didev usando el cliente nativo de Windows
(RAS / cmdlets `VpnClient`) — no implementa IPsec por su cuenta. Se
distribuye en dos variantes generadas desde el mismo codigo:

- **Instalador** (`didev-vpn-setup-<version>.msi`): instala en
  `Program Files`, confia en la raiz de didev y registra la tarea de
  renovacion para todos los usuarios en una unica elevacion.
- **Portable** (`didev-vpn-portable-<version>.zip`): un unico
  `didev-vpn.exe` autocontenido, sin instalar nada — salvo una elevacion
  puntual (UAC) la primera vez que hace falta confiar en la raiz.

El perfil que consume esta app (`.didevvpn`) es el que genera el panel al
crear el token de alta de un dispositivo — ver la seccion **"Aprovisionamiento
de apps"** del README del panel para el formato exacto, las dos variantes del
perfil (`full`/`qr`) y el contrato de confianza por huella SHA-256. Esta app
**solo acepta la variante `full`** (la que trae la cadena de CA completa); la
variante `qr` es para la futura app de Android.

## Antes de compilar: dos ficheros de configuracion obligatorios

Ninguno de los dos se genera en este proyecto ni se incrusta a mano en el
codigo. **El build falla a proposito** mientras sigan siendo el placeholder
del repositorio — es intencional, nunca debe salir un `.exe`/`.msi` que no
pueda verificar la firma de un perfil:

1. **`DidevVpn.App/SigningKey/vpn-profile-signing-ed25519.pub.pem`**: la
   clave publica Ed25519 del panel (ver su README, "Aprovisionamiento de
   apps", pasos 1-3: `openssl genpkey`/`openssl pkey -pubout` en la `.28`).
   Sustituye el fichero completo por la salida de `openssl pkey -pubout`.
   Comprobado en **tiempo de compilacion** (`ValidateProfileSigningKey` en
   `DidevVpn.App.csproj`): si el placeholder sigue ahi, `dotnet build`/
   `dotnet publish` fallan con un mensaje claro señalando este fichero.
2. **`DidevVpn.Installer/didev-root-ca.cer`**: el certificado (DER binario,
   `.cer`) de la raiz offline "didev Root CA" — es anterior a este modulo y
   a este repositorio (ver `CLAUDE.md` del panel), no la genera nada de
   este codigo. Solo lo usa el **instalador**, para confiar en ella durante
   la instalacion elevada sin pedir un UAC aparte en tiempo de ejecucion.
   A diferencia del anterior, **esto no se comprueba en tiempo de
   compilacion** (validar un DER binario arbitrario sin una tarea de MSBuild
   a medida no es fiable): si se deja el placeholder, el `.msi` compila
   igual, pero el paso de instalacion que confia en la raiz falla en el
   momento de instalar (`Import-Certificate` no puede leer el placeholder
   como certificado). Verificalo a mano antes de distribuir el `.msi`.

La app en si **nunca** confia ciegamente en `didev-root-ca.cer`: cada vez
que importa un perfil, valida la raiz que trae por su huella SHA-256 contra
`rootCaSha256` del propio perfil firmado (ver `ProfileVerifier`/
`EnrollmentOrchestrator` en el codigo). Ese fichero solo evita un UAC
redundante en la variante instalada.

## Estructura de la solucion

```
APPS/Windows/
  code/                           <- todo el codigo (en git)
    DidevVpn.slnx
    DidevVpn.Core/                <- logica pura, sin APIs de Windows: perfil,
                                     verificacion Ed25519, mapeo de propuestas
                                     IPsec. Se prueba en cualquier SO.
    DidevVpn.App/                 <- la app en si (WinForms, bandeja):
                                     servicios de Windows (CNG/TPM, VpnClient,
                                     EST, Task Scheduler, almacenes de
                                     certificados) + orquestacion + UI.
    DidevVpn.Tests/                <- xUnit, cubre DidevVpn.Core a fondo.
    DidevVpn.Installer/            <- proyecto WiX (instalador .msi).
    build.ps1                      <- compila las dos variantes, firma, empaqueta.
  ejecutables/                    <- SOLO LOCAL (.gitignore): build.ps1 deja
                                     aqui el .msi, el .zip y SHA256SUMS.txt.
```

## Compilar

Requisitos: .NET SDK 8 (o superior: el repo se probo tambien con SDK 9/10
apuntando a `net8.0`/`net8.0-windows`), y para el instalador el
[WiX Toolset](https://wixtoolset.org/) v4 o superior como herramienta de
`dotnet` (`dotnet tool install --global wix`) mas su extension Util
(`wix extension add WixToolset.Util.wixext --global`, en la MISMA version
mayor que el `wix` instalado).

```powershell
cd APPS/Windows/code
dotnet tool install --global wix
wix extension add WixToolset.Util.wixext --global   # ajusta la version si hace falta

# Rellena antes los dos ficheros de la seccion anterior, luego:
./build.ps1 -Version 1.0.0
```

Sin `-SigningCertThumbprint`/`-SigningCertPath`, `build.ps1` construye igual
pero avisa por pantalla y deja el `.exe`/`.msi` **sin firmar** (valido para
pruebas locales, nunca para distribuir). Con un certificado de firma de
codigo ya instalado en el almacen del equipo de build:

```powershell
./build.ps1 -Version 1.0.0 -SigningCertThumbprint AB12CD34EF56...
```

`build.ps1`, en orden: corre los tests de `DidevVpn.Tests`; publica la app
dos veces (self-contained normal para el MSI, self-contained single-file
para el portable); firma el `.exe` portable; lo empaqueta en el `.zip`;
compila el instalador WiX contra la primera publicacion; firma el `.msi`;
genera `SHA256SUMS.txt`. Todo queda en `APPS/Windows/ejecutables/` (no se
sube a git).

### Firma de codigo

Un certificado de firma de codigo (EV o OV, de una CA publica) es un gasto
recurrente y un tramite de verificacion de identidad aparte de este
proyecto — no lo cubre este repositorio. Sin firmar, Windows SmartScreen
avisara de "editor desconocido" tanto en el `.exe` portable como al ejecutar
el `.msi`; con un certificado EV, esa reputacion es practicamente inmediata,
con uno OV puede tardar en acumularse. `build.ps1` acepta el certificado por
huella (ya instalado, p.ej. en un token USB o un HSM) o por fichero `.pfx` +
contraseña.

## Diferencias entre variantes

| | Instalador (MSI) | Portable (.zip) |
|---|---|---|
| Instala en Program Files / HKLM | Si | No (nada fuera de `%LOCALAPPDATA%\didev-vpn` y el propio `.exe`) |
| Confianza en la raiz de didev | Durante la instalacion (una elevacion) | La primera vez que hace falta (una elevacion UAC puntual, ver mas abajo) |
| Tarea de renovacion | Para **todos los usuarios** (logon + cada 12h), registrada por el instalador | Opcional, por el usuario actual (menu "Renovar aunque la app este cerrada") |
| Inicio automatico en la bandeja | Si (`HKLM\...\Run`, todos los usuarios) | No (hay que abrirla a mano, o usar la tarea programada de renovacion, que solo renueva, no abre la bandeja) |
| Requiere permisos de administrador | Para instalar/desinstalar | Solo para ese unico paso de la raiz, si hace falta |
| Actualizacion | `MajorUpgrade` in situ, conserva perfiles VPN y certificados de cada usuario | Sustituir el `.exe`; los datos en `%LOCALAPPDATA%\didev-vpn` no cambian |
| Desinstalacion | Quita la tarea, el inicio automatico y los propios ficheros; **no** toca las conexiones VPN/certificados de cada usuario (usa "Quitar de este equipo" en la app antes, por cada usuario) ni la raiz de confianza (se deja, por si otro dispositivo de la maquina depende de ella; retirala a mano con `certmgr.msc` si hiciera falta) | "Quitar de este equipo" desde el propio menu: conexion, tarea, certificado (a elegir) y configuracion |

**Limitacion conocida y deliberada**: el desinstalador del MSI no recorre los
perfiles de cada usuario de la maquina para borrar la conexion VPN de cada
uno (technicamente dificil de hacer bien desde un contexto elevado sin
suplantar a cada usuario, y no se ha podido probar en un entorno real
multiusuario). Antes de una desinstalacion completa en un equipo compartido,
pide a cada usuario que use "Quitar de este equipo" primero.

## La clave del dispositivo no viaja entre equipos (variante portable)

La clave privada del dispositivo se genera en el TPM (o, sin TPM, con el
proveedor de software de Windows) **de ese equipo concreto**, no exportable.
El `.exe` portable no lleva consigo ninguna identidad: si lo copias a otro
PC, ese PC necesita su propia alta (con un token de alta nuevo del panel, y
normalmente un nombre de dispositivo distinto). Esto se avisa tambien en la
pantalla de alta de la app.

## Riesgos e incognitas heredados de la investigacion previa

Antes de escribir este codigo se investigaron a fondo las APIs de Windows 11
necesarias (ver el historial de `APPS/Windows/NOTAS-prompt-12-en-pausa.md`
para el detalle completo, fuentes incluidas). Puntos que siguen sin poder
verificarse en una maquina Windows 11 real con TPM y contra el strongSwan/EST
reales de didev -toda la logica de perfil/firma SI esta probada de verdad,
ver mas abajo-:

1. **El certificado del gateway IKE (no solo el de RADIUS) necesita la raiz
   en `LocalMachine\Root`** casi con toda seguridad (documentacion oficial
   solo antigua, pero coincidente con toda guia de terceros): por eso la
   variante portable SI pide una elevacion para ese paso, no se ha intentado
   evitarla con `CurrentUser\Root`.
2. Si `CurrentUser\Root` bastaria ADEMAS para el certificado del servidor
   EAP-TLS (RADIUS) en concreto sigue sin confirmar — no cambia nada de la
   implementacion actual (el punto 1 ya obliga a `LocalMachine\Root` de
   todas formas), pero seria relevante si en el futuro se quisiera evitar
   tambien ESE paso en algun escenario.
3. `GCMAES256` como `EncryptionMethod` de la fase IKE (no solo de ESP) esta
   documentado por terceros (proveedores de VPN), no en la documentacion
   oficial de Microsoft: pruebalo de verdad contra el strongSwan real de
   didev antes de dar por sentado que negocia.
4. Los metodos CIM/WMI subyacentes a los cmdlets `VpnClient`
   (`root\Microsoft\Windows\RemoteAccess\Client`) no se han usado
   directamente: `VpnConnectionService` invoca los cmdlets de PowerShell
   documentados (via un subproceso `powershell.exe`), reutilizando ademas la
   misma plantilla de XML EAP que ya usa con exito el paquete de conexion
   existente del panel (`server/src/services/vpnClientPackages.ts`,
   `WINDOWS_INSTALL_PS1`) en vez de reinventarla.
5. El instalador WiX **si se ha compilado y enlazado de verdad** (WiX
   Toolset v5, `wix build` real, ICE incluidas) durante el desarrollo, pero
   sus custom actions (confiar en la raiz, registrar la tarea) no se han
   ejecutado en una instalacion elevada real todavia.

## Que SI esta verificado de verdad (no solo escrito)

- **Firma y verificacion Ed25519**: `DidevVpn.Tests` incluye un vector de
  interoperabilidad generado con `openssl genpkey -algorithm ED25519` /
  `openssl pkeyutl -sign -rawin` -una implementacion totalmente
  independiente de la libreria usada aqui (BouncyCastle)-, verificado de
  verdad por esta app. Tambien: firma manipulada byte a byte rechazada,
  variante incorrecta rechazada, version de esquema no soportada rechazada,
  perfil caducado rechazado, y que el QR compacto/perfil completo son sobres
  independientes con firmas independientes.
- **Compilacion real de las tres capas** (`DidevVpn.Core`, `DidevVpn.App`,
  `DidevVpn.Tests`) contra .NET 8, sin advertencias.
- **El `.exe` arranca de verdad**: se ha ejecutado el binario compilado (no
  solo compilado) y confirmado que crea su carpeta de datos
  (`%LOCALAPPDATA%\didev-vpn`) y se mantiene en la bandeja sin excepciones
  no controladas.
- **El build falla quimicamente donde debe**: se ha comprobado, con el
  placeholder real del repositorio, que `dotnet build`/`publish` de
  `DidevVpn.App` fallan con el mensaje esperado; y que con una clave de
  prueba real (generada con `openssl genpkey`) compilan y arrancan bien.
- **`build.ps1` completo, sin firmar**: tests + las dos publicaciones +
  compilacion del `.msi` con WiX real + empaquetado del `.zip` +
  `SHA256SUMS.txt`, de principio a fin.

## Probar en una VM limpia de Windows 11

No hay forma de sustituir esto por nada automatizado dado lo anterior. Como
minimo, antes de dar el modulo por terminado de verdad:

1. **VM limpia, sin .NET instalado** (para confirmar que el self-contained
   de verdad no depende de tenerlo puesto): instala el `.msi` y comprueba
   que aparece la conexion "didev VPN", la raiz en
   `certlm.msc` (Equipo local → Entidades de certificacion raiz de
   confianza), la tarea en el Programador de tareas (raiz, no en una
   subcarpeta) y el inicio automatico (`Run` de HKLM, o
   `shell:common startup` si se cambiara a un acceso directo).
2. **Alta real** contra el panel: genera un token de alta de un dispositivo
   de prueba, descarga el `.didevvpn`, importalo desde la app. Confirma en
   el TPM (o software, en una VM sin TPM virtual) que la clave no es
   exportable (`certutil -store -user My` no deberia poder exportar la
   privada) y que el certificado queda en `CurrentUser\My`.
3. **Conectar/desconectar** desde el menu de la bandeja; confirmar la IP
   asignada visible en "Ver estado...".
4. **Renovar a mano** ("Renovar ahora") y dejar pasar el ciclo de 12h para
   confirmar la renovacion automatica (o baja `renew_after_days` en el panel
   para no esperar tanto).
5. **Variante portable**, en OTRA VM limpia (sin instalar nada): copia solo
   el `.exe`, ejecutalo, repite el alta con un dispositivo distinto y
   confirma que pide la elevacion UAC solo para la raiz (una vez), no para
   nada mas.
6. **Desinstalar** el MSI y confirmar que la tarea y el inicio automatico
   desaparecen, y que un `MajorUpgrade` (instalar una version `X.Y.Z+1`
   encima) conserva la conexion y el certificado sin tocarlos.

Documenta cualquier discrepancia con lo descrito arriba (sobre todo los
puntos 1-4 de "riesgos e incognitas") en
`APPS/Windows/NOTAS-prompt-12-en-pausa.md` o en un fichero nuevo, para que
quede recogido para la app de Android (prompt 13), que comparte el mismo
contrato de perfil y varias de las mismas dudas (Root en el almacen del
sistema para EAP-TLS, versiones minimas de app...).
