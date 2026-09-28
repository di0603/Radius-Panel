# Prompt 12 (app de Windows) — en pausa, esperando al prompt 11

Esta rama (`feat/vpn-12-windows-wip`) existe solo para no perder la
investigacion de APIs hecha antes de darnos cuenta de que el prompt 12
depende del 11 (aprovisionamiento en el panel: modelo usuario + dispositivo,
clave Ed25519 de firma, perfil `.didevvpn` **por dispositivo** — no generico
como se penso al principio — generado por un admin al crear el token de
alta, mostrado una vez como fichero + QR, caduco a las 24h igual que el
token actual).

**No hay codigo de la app todavia.** Solo se creo la rama y se lanzo la
investigacion de abajo antes de pausar. No fusionar esta rama a `vpn` ni a
`main` hasta que el prompt 11 este hecho y el prompt 12 se retome de verdad.

## Que hace falta del prompt 11 antes de poder seguir aqui

- Clave Ed25519 generada en la `.28` (procedimiento ya dado al usuario:
  `openssl genpkey -algorithm ED25519`, fuera del arbol de git, ruta via
  variable de entorno nueva, nunca la clave privada en claro en ningun
  sitio).
- Modelo de datos para "perfil por dispositivo": generado junto al token de
  alta (no como fichero generico de ajustes), firmado con esa clave,
  mostrado una vez (fichero `.didevvpn` + QR) y con la misma caducidad de
  24h que ya tiene `panel_vpn_enroll_tokens`.
- La clave publica correspondiente, para incrustarla en el codigo de la app
  cuando se retome este prompt.

## Investigacion de APIs de Windows 11 (hecha, valida para cuando se retome)

Pendiente de verificar en la practica (son los puntos de mayor riesgo antes
de comprometerse a la arquitectura), pero investigado a fondo contra
Microsoft Learn, los XSD del propio Windows y el codigo fuente de
dotnet/runtime. **Esto es un informe de un subagente de investigacion, no
codigo verificado por mi contra una build real de la app** — antes de
apoyarse en el a fondo, revisar las fuentes citadas.

### 1. Cmdlets de VPN y acceso desde C#

- No existen `Connect-VpnConnection`/`Disconnect-VpnConnection`: para
  conectar/desconectar hay que usar `rasdial "<nombre>"` /
  `rasdial "<nombre>" /disconnect`, o la API Win32 `RasDial`/`RasHangUp`
  (`rasapi32.dll`).
- `New-EapConfiguration` esta en el modulo `VpnClient`, no en `NetworkAdapter`.
- Alta: `Add-VpnConnection -Name X -ServerAddress fqdn -TunnelType Ikev2
  -AuthenticationMethod Eap -EapConfigXmlStream <XmlDocument>
  -EncryptionLevel Required [-SplitTunneling] [-AllUserConnection]`.
- IPsec: `Set-VpnConnectionIPsecConfiguration -ConnectionName X
  -AuthenticationTransformConstants GCMAES256 -CipherTransformConstants
  GCMAES256 -EncryptionMethod GCMAES256 -IntegrityCheckMethod SHA384
  -DHGroup ECP384 -PfsGroup ECP384 -Force`. Los seis parametros son
  obligatorios en el conjunto "CustomPolicy". **GCMAES256 como
  EncryptionMethod de IKE solo aparece documentado en guias de terceros
  (Netgate), no en la documentacion oficial de Microsoft — probar de verdad
  contra strongSwan (`ike=aes256gcm16-prfsha384-ecp384`) antes de darlo por
  bueno.**
- Desde C# sin pasar por PowerShell: los cmdlets son wrappers CDXML sobre
  WMI en `root\Microsoft\Windows\RemoteAccess\Client`
  (`PS_VpnConnection.Add(...)`, `PS_VpnConnectionIPsecConfiguration.SetByCustomPolicy(...)`
  con enums UInt32 — valores confirmados en la maquina de pruebas:
  AuthTransform GCMAES256=5, Cipher GCMAES256=8, EncryptionMethod
  GCMAES256=6, Integrity SHA384=3, DHGroup ECP384=5, PfsGroup ECP384=5, "None"
  de cualquiera = 0xFFFFFFFF). Se invocan via
  `Microsoft.Management.Infrastructure` (`CimSession.InvokeMethod`).
- Alternativas descartadas: WinRT `Windows.Networking.Vpn.VpnManagementAgent`
  (pensado para apps empaquetadas, exige la capacidad restringida
  `networkingVpnProvider` — sin verificar del todo).
- Fuentes: learn.microsoft.com/powershell/module/vpnclient/,
  .../set-vpnconnectionipsecconfiguration,
  learn.microsoft.com/previous-versions/windows/desktop/vpnclientpsprov/add-ps-vpnconnection,
  learn.microsoft.com/windows/win32/api/ras/nf-ras-rasdiala.

### 2. Elevacion para crear el perfil

- Perfil por usuario (por defecto, sin `-AllUserConnection`): se escribe en
  `%AppData%\Microsoft\Network\Connections\Pbk\rasphone.pbk`, sin admin.
- `-AllUserConnection`: escribe en `%ProgramData%\...\Pbk\rasphone.pbk` y
  falla sin elevar ("Access is denied"). No documentado oficialmente,
  confirmado por evidencia de comunidad + las ACL de `ProgramData`.

### 3. XML de configuracion EAP-TLS

- XSD real en `C:\Windows\schemas\EAPMethods\eaptlsconnectionpropertiesv1.xsd`.
- `ServerNames`: lista separada por `;`, contra el subject del certificado
  de RADIUS; admite regex si lleva `*`. Usar el nombre DNS plano
  (`radius.vpn.vlc.didev.es`), no `CN=...`. Vacio = solo se comprueba la CA
  emisora.
- `TrustedRootCA`: huella **SHA-1** del root (no SHA-256), repetible,
  formato hexadecimal en pares separados por espacio en los perfiles de
  Microsoft.
- Obligatorio: `PerformServerValidation=true`, `AcceptServerName=true`,
  `DisableUserPromptForServerValidation=true`.
- Filtro del certificado de cliente:
  `FilteringInfo/CAHashList Enabled="true"/IssuerHash` (SHA-1 de la CA
  emisora) + `ClientAuthEKUList Enabled="true"`. El certificado debe estar en
  `CurrentUser\My` para un tunel de usuario.
- Fuentes: learn.microsoft.com/windows/client-management/mdm/eap-configuration,
  learn.microsoft.com/windows-server/networking/technologies/extensible-authentication-protocol/network-access.

### 4. CurrentUser\Root vs LocalMachine\Root — el riesgo mas gordo

- **Certificado del gateway IKE (strongSwan)**: lo valida IKEEXT/RasMan y
  necesita `LocalMachine\Root` (admin). Documentacion oficial solo antigua
  (Server 2008 R2, sigue citada como valida): "el certificado de la CA raiz
  debe instalarse... en el almacen **por equipo**", y la validacion del lado
  cliente no se puede desactivar. **No hay confirmacion oficial para Windows
  11**, pero toda guia de proveedores (Netgate, comunidad strongSwan) usa
  `LocalMachine\Root`. **Implicacion directa para la variante portable: si
  la raiz de didev no es una CA publica, la variante sin admin no puede
  evitar la elevacion para este paso.**
- **Certificado del servidor EAP-TLS (FreeRADIUS)**: lo valida EapHost en el
  contexto del usuario. Microsoft dice que la lista de raices de confianza
  "se construye con las CA raiz de confianza instaladas en el equipo Y en
  los almacenes del usuario" — apunta a que `CurrentUser\Root` SI valdria
  aqui, pero ningun documento lo confirma explicitamente. **Sin verificar,
  probarlo de verdad antes de comprometerse.**
- Anadir a `CurrentUser\Root` desde codigo muestra igualmente un dialogo de
  confirmacion de Windows ("Advertencia de seguridad"), sin poder evitarlo
  por API (evidencia de comunidad, no documentado).
- Fuentes: learn.microsoft.com/previous-versions/windows/it-pro/windows-server-2008-R2-and-2008/dd941612(v=ws.10),
  learn.microsoft.com/troubleshoot/windows-server/networking/troubleshoot-always-on-vpn.

### 5. Clave no exportable en el TPM + CSR, en C# puro

- `CngKey.Create(CngAlgorithm.ECDsaP256, "<nombre>", new
  CngKeyCreationParameters { Provider =
  CngProvider.MicrosoftPlatformCryptoProvider })` — `ExportPolicy` por
  defecto ya es "ninguno" (no exportable). Dar siempre un nombre a la clave
  para que persista.
- `new ECDsaCng(key)` → `new CertificateRequest(new
  X500DistinguishedName("CN=..."), ecdsa, HashAlgorithmName.SHA256)`. SAN
  con `SubjectAlternativeNameBuilder{AddDnsName(cn)}.Build()`. CSR con
  `CreateSigningRequestPem()` (.NET 7+).
- **Usar claves de usuario, no de maquina**: hay un bug abierto de
  dotnet/runtime (#45759) donde `CngKey.IsMachineKey` devuelve `false` para
  claves PCP de maquina, lo que rompe `CopyWithPrivateKey` — coincide ademas
  con que una clave de usuario es lo correcto para un certificado de tunel
  de usuario en `CurrentUser\My`.
- P-384 en el TPM depende del firmware del TPM; P-256 es la opcion segura
  (coincide con lo pedido: ECDSA P-256).
- Fallback si esto fallara en la practica: `certreq -new` con un INF
  (`ProviderName="Microsoft Platform Crypto Provider"`,
  `KeyAlgorithm=ECDSA_P256`, `Exportable=FALSE`, `MachineKeySet=FALSE`, SAN
  via `[Extensions] 2.5.29.17`) — el mismo patron que ya usa el paquete de
  conexion de Windows existente (`server/src/services/vpnClientPackages.ts`,
  `enroll.ps1`), pero no deberia hacer falta si el CNG directo funciona.

### 6. Instalar el certificado emitido

- La respuesta de EST es PKCS7 "certs-only" en base64 (RFC 7030): decodificar
  primero.
- En .NET 9+, `X509Certificate2Collection.Import`/constructores por
  `byte[]` estan obsoletos (SYSLIB0057); usar `SignedCms` (paquete
  `System.Security.Cryptography.Pkcs`) → `Decode()` → `.Certificates`.
- `cert.CopyWithPrivateKey(ecdsaCng)`: si la `CngKey` tiene nombre (persistida,
  como en el punto 5), esto enlaza el certificado a la clave del TPM via
  `CERT_KEY_PROV_INFO_PROP_ID` — sin necesidad de `certreq -accept` (eso solo
  hace falta si la clave se creo con `certreq`).
- Anadir a `new X509Store(StoreName.My, StoreLocation.CurrentUser)`.

### 7. Tarea programada por usuario, sin elevar

- Funciona, pero con una trampa: `schtasks /create /sc ONLOGON` sin mas falla
  sin elevar ("Access is denied") porque el trigger no queda ligado a un
  usuario. Hace falta:
  - `LogonTrigger` con `UserId` puesto al usuario actual.
  - `TimeTrigger` con `Repetition Interval=PT12H` para el ciclo de 12h.
  - Principal con `LogonType=InteractiveToken`.
  - Registrar via `schtasks /create /xml`, COM `ITaskService`, o el paquete
    NuGet `TaskScheduler` (dahall, 2.12.2).
- Sin verificar: crear subcarpetas de tareas puede necesitar admin — registrar
  en la raiz (`\`).
- Fuente: learn.microsoft.com/windows/win32/taskschd/logontrigger-userid.

### 8. Tarea programada para todos los usuarios, desde el instalador (MSI)

- WiX no tiene un elemento nativo para tareas programadas: hace falta
  `WixQuietExec` (extension `WixToolset.Util.wixext`) llamando a
  `schtasks.exe /create /xml ... /f` como `CustomAction` diferida, con la
  accion inversa (`/delete /tn ... /f`) condicionada a `REMOVE="ALL"` para la
  desinstalacion.
- Para "todos los usuarios" con logon interactivo, la tarea necesita un
  principal de grupo (`S-1-5-32-545`, "Users") con un `LogonTrigger` sin
  `UserId`.
- **WiX v7.0.0 es la version estable actual** (v6 en adelante tiene licencia
  "Open Source Maintenance Fee": organizaciones con mas de 10k$/ano de
  ingresos deben patrocinar la licencia — revisar si aplica antes de fijar
  la version a usar).

### 9. MajorUpgrade

- `<MajorUpgrade DowngradeErrorMessage="..." />` dentro de `<Package>`,
  mismo `UpgradeCode`, `Version` incrementada (solo cuentan los 3 primeros
  campos). Windows Installer solo toca lo que el mismo instalo: los
  perfiles VPN por usuario, los certificados de `CurrentUser\My`, las claves
  del TPM y las tareas por usuario sobreviven tanto a la actualizacion como
  a la desinstalacion — hay que limpiarlos a mano si se quiere una
  desinstalacion completa (ya contemplado en el enunciado original).

### 10. Publicacion single-file self-contained (WinForms, win-x64)

- `dotnet publish -r win-x64 --self-contained true -p:PublishSingleFile=true`
  funciona para WinForms con `NotifyIcon`. **No usar trimming**: no esta
  soportado para WinForms (error del SDK NETSDK1175).
- Con `IncludeNativeLibrariesForSelfExtract=true` las nativas se extraen a
  `%TEMP%\.net` en cada arranque (configurable con
  `DOTNET_BUNDLE_EXTRACT_BASE_DIR`).
- `Assembly.Location` devuelve cadena vacia en single-file: usar
  `AppContext.BaseDirectory` o `Environment.ProcessPath`.
- `<ApplicationIcon>` se incrusta con normalidad.

### 11. Verificacion de firmas Ed25519 desde C#

- **.NET no tiene soporte nativo de Ed25519** (ni en 8, 9 ni 10, en ninguna
  plataforma) — la propuesta de API (dotnet/runtime#63174) esta aprobada
  pero sin fecha ("Future").
- Recomendado: **BouncyCastle.Cryptography** (2.7.0),
  `Org.BouncyCastle.Crypto.Signers.Ed25519Signer` o
  `Math.EC.Rfc8032.Ed25519.Verify` — codigo puramente managed, sin binarios
  nativos, compatible sin problemas con single-file.
- Descartado NSec (necesita libsodium nativo, complica el single-file).

## Riesgos a resolver antes de escribir codigo de verdad (cuando retomemos)

1. El certificado del **gateway IKE** necesita la raiz en `LocalMachine\Root`
   (admin) casi con toda seguridad — la variante portable sin admin solo
   evitaria esto si la raiz de didev fuera una CA publica, que no lo es.
2. Si `CurrentUser\Root` basta para el certificado del **servidor EAP-TLS**
   (FreeRADIUS) esta sin confirmar — probarlo en una maquina real antes de
   diseñar la variante portable en torno a esa suposicion.
3. GCMAES256 como `EncryptionMethod` de IKE (no solo de ESP) solo esta
   documentado por terceros — probar contra el strongSwan real de didev.
4. Usar siempre claves CNG de **usuario**, nunca de maquina, para el TPM
   (bug conocido de dotnet/runtime).
5. El trigger de la tarea programada por usuario debe llevar `UserId`
   explicito — `schtasks /sc ONLOGON` a secas falla sin elevar.
