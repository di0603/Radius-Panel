# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Este proyecto usa versionado semantico.

## [No publicado]

### Anadido

- **Prompt 12.7 (Windows: rendimiento)**: la app iba muy lenta -cada
  consulta de estado lanzaba un `powershell.exe` nuevo (con el modulo
  `VpnClient`), en el hilo de interfaz, varias veces por conexion y varias
  veces por minuto (menu de bandeja, ventana cada 5s, bandeja cada 15s)-.
  - Nuevo `RasStateReader` (`DidevVpn.App/Services/Ras/`): P/Invoke directo
    a `rasapi32.dll` (`RasEnumConnectionsW`, `RasGetConnectStatusW`,
    `RasGetProjectionInfoW` para la IP, `RasEnumEntriesW` para si existe en
    la agenda), milisegundos en vez de segundos, sin crear ningun proceso.
    `VpnConnectionService` cae de vuelta a PowerShell automaticamente si el
    P/Invoke fallara alguna vez. Conectar/desconectar usa `rasdial.exe`
    directamente (ya no via `powershell.exe`). PowerShell queda solo para
    crear/actualizar/borrar la conexion (el alta).
  - **Hallazgo real verificado en esta maquina**: `RasEnumConnectionsW`/
    `RasEnumEntriesW` exigen que `dwSize` coincida EXACTAMENTE con uno de
    varios tamanos de struct reconocidos (`ERROR_INVALID_SIZE` si no,
    a diferencia de la mayoria de APIs de Windows). Los tamanos de
    `RasInterop.cs` se verificaron con un programa de sondeo (no
    versionado) contra esta maquina real hasta encontrar los aceptados; con
    ellos se obtuvieron datos reales (la agenda RAS de este equipo).
    `RasGetConnectStatusW`/`RasGetProjectionInfoW` no mostraron el mismo
    problema, pero no se han podido probar contra una conexion activa de
    verdad (respaldo automatico por PowerShell si hiciera falta).
  - Nada bloqueante en el hilo de interfaz: conectar/desconectar, importar
    perfil y renovar van en `Task.Run`, con el control correspondiente
    deshabilitado y "Trabajando..." mientras dura.
  - Nuevo `ConnectionStateService`: cache UNICA del estado de todas las
    conexiones para la bandeja y la ventana a la vez (antes cada una
    sondeaba por su cuenta). Refresco por `NetworkChange.*` con debounce de
    ~500ms (`DidevVpn.Core.Net.Debouncer`) + temporizador de respaldo cada
    30s, en un hilo de fondo.
  - `ConnectionManagerForm.RefreshConnections` ya no hace `Controls.Clear()`
    + reconstruir todo: solo anade/quita filas si cambia la LISTA de
    conexiones, actualiza los mismos `Label` en el sitio si solo cambia el
    estado. Sin parpadeo.
  - `PublishReadyToRun=true` en las dos variantes; confirmado que el
    portable single-file solo extrae ~8MB de nativos a
    `%TEMP%\.net\didev-vpn\` (nunca el bundle completo), cacheados entre
    ejecuciones de la misma version.
  - **Medido de verdad en esta maquina**: arranque ~360ms -> ~241ms
    (variante instalada, con ReadyToRun); un refresco completo con 3
    conexiones, ~6,3s (PowerShell) -> ~10ms (RAS nativo). El `.exe` portable
    sale ~15% mas grande con ReadyToRun (168MB -> 194MB): compromiso pedido
    explicitamente (arranque vs tamano).
  - Tests: `DidevVpn.Tests` (`DebouncerTests`, con ventanas reales
    pequenas) y `DidevVpn.App.Tests` (`RasStateReaderTests` contra RAS real
    -sin lanzar con nombres que no existen-, `ConnectionStateServiceTests`
    con un `IVpnConnectionService` falso: refresco, debounce, y que una
    conexion que lanza no bloquea el refresco de las demas). 70 tests en
    verde (62+8).
  - Version 0.1.6 compilada de verdad (`build.ps1`), en
    `APPS/Windows/ejecutables/` (fuera de git): `.msi`/`.exe`/`.zip` sin
    firmar + `SHA256SUMS.txt`. Ejecutado de verdad (no solo compilado):
    arranca, tray+ventana aparecen, sin excepciones en el log tras varios
    segundos.
  - `deploy/vpn-gateway-agent.sh`, `deploy/freeradius-vpn-ca-sync.sh` y
    `deploy/deploy.sh` marcados en git con modo 100755 (`git update-index
    --chmod=+x`): se habian subido como 644 desde Windows y systemd no podia
    ejecutarlos.
  - `deploy/freeradius-vpn-ca-sync.sh` (prompt 12.7, sobre lo entregado en
    los prompts 14/14.5): con `X509_V_FLAG_PARTIAL_CHAIN` activo en
    FreeRADIUS, tener el certificado de la CA intermedia dentro de `ca_path`
    hacia que la cadena terminara ahi -la raiz nunca entraba en la
    validacion- y la comprobacion de revocacion de la PROPIA intermedia
    fallaba con `unable to get certificate CRL` (bug real, reproducido con
    `openssl verify`). Arreglado: la intermedia se guarda ahora en
    `INTERMEDIATE_DIR`, siempre fuera de `ca_path` (`ca_path` solo lleva la
    CRL de la intermedia, nunca su certificado ni un enlace `.0`); el
    script limpia cualquier `panel-intermediate-*.pem` que hubiera quedado
    dentro de `ca_path` por el esquema anterior. La comprobacion de
    `TLS_CONFIG_FILE` ahora resuelve `${certdir}`/`${confdir}` si `ca_path`
    los usa (antes exigia coincidencia literal) y avisa (sin fallar) si no
    encuentra una linea `ca_file` (raiz + su propia CRL, requerida ademas de
    `ca_path` para poder validar la revocacion de la intermedia). El hash de
    cambios se versiono (`"v2\n"` de prefijo) para forzar exactamente una
    resincronizacion en el primer arranque del script corregido, aunque el
    contenido de la CA/CRL no haya cambiado -si no, un host ya sincronizado
    con el bug se quedaria con el esquema viejo hasta la siguiente rotacion
    real-. Documentado en el propio script y en el `.example` que
    `tls-config tls-vpn` necesita ademas `ecdh_curve =
    "secp384r1:prime256v1"` (las claves TPM/cliente son P-256; con solo
    `secp384r1` FreeRADIUS corta con "wrong curve").
  - Tests nuevos en `server/src/lib/deployScripts.test.ts`: el camino feliz
    ahora comprueba que la intermedia queda fuera de `ca_path` (antes
    comprobaba lo contrario) y que `openssl rehash` solo genera un enlace
    `.r0` (CRL), nunca `.0`; nuevo test que reproduce el bug con `openssl
    verify -partial_chain -untrusted <intermedia> -crl_check_all` (falla con
    el esquema antiguo, pasa con el nuevo con `-CAfile` para la raiz+su
    CRL); los tres tests de rechazo tambien comprueban que `INTERMEDIATE_DIR`
    queda vacio.
  - README actualizado (seccion "Sincronizacion de la CA intermedia con
    FreeRADIUS"): nuevo esquema `ca_path`/`INTERMEDIATE_DIR`/`ca_file`,
    ejemplo de `openssl verify` y pasos de "volver atras" al dia.
  - Rama `feat/vpn-12.7-windows-rendimiento`, pendiente de revision.

- **Prompt 12.6 (Windows: asociar la clave CNG sin exportarla)**: el alta
  fallaba con "Clave no valida para utilizar en el estado especificado" justo
  tras `simpleenroll` (con el token de un solo uso ya consumido):
  `CertificateEnrollmentService` enlazaba el certificado a la clave CNG con
  `X509Certificate2.CopyWithPrivateKey` y lo reinstalaba via PKCS#12, y
  `CopyWithPrivateKey` fuerza una exportacion que una clave de TPM
  ("Microsoft Platform Crypto Provider") deliberadamente no permite. Nueva
  `AssociatePrivateKey` usa `CertSetCertificateContextProperty`/
  `CERT_KEY_PROV_INFO_PROP_ID` (la propiedad documentada por Microsoft para
  esto) sin exportar nada; compara antes las coordenadas publicas de la clave
  y del certificado, y tras instalar comprueba que Windows recupera la clave
  privada y que firma de verdad. `EnrollmentOrchestrator` usa la misma
  asociacion para la comprobacion de `/status` (version minima) antes de
  instalar. Nuevo proyecto `DidevVpn.App.Tests` (net8.0-windows, aparte de
  `DidevVpn.Tests`: necesita APIs de Windows/CNG reales) con dos tests de
  integracion real -clave de software y, si hay TPM disponible en la maquina
  de build, clave de TPM real-, verificados en una maquina con TPM real
  (57 + 2 tests en verde). Tambien: la lista de conexiones se refresca al
  completar un alta, y el error de importacion avisa explicitamente si el
  token de alta puede haberse consumido (EST emitio, pero el alta fallo
  despues). Rama `feat/vpn-12.6-windows-cng`, pendiente de revision.

- **Prompt 14 + 14.5 (sincronizacion de la CA con FreeRADIUS)**: FreeRADIUS
  valida EAP-TLS con `ca_path` + `check_crl`/`check_all_crl = yes` en su
  propio modulo `eap_vpn` (`tls-config tls-vpn`, distinto del `eap` de la
  WiFi), y ahi solo estaba la raiz offline (puesta a mano): cualquier
  certificado firmado por la CA intermedia del panel se rechazaba. Nuevo
  `deploy/freeradius-vpn-ca-sync.sh` (timer cada 15 min): descarga
  `GET /pki/ca-chain.pem`/`crl.pem` por loopback, NUNCA confia en la raiz de
  esa respuesta (valida contra la raiz ya presente en `ca_path`, por su
  huella SHA-256 fija en config), verifica cada intermedia contra esa raiz y
  cada CRL contra su intermedia (comprobando el TEXTO de `openssl crl
  -CAfile` — "verify OK" presente, "verify failure" ausente, nunca solo el
  codigo de salida) y que no haya caducado, comprueba que `TLS_CONFIG_FILE`
  (el `eap_vpn` real) contiene de verdad el `ca_path` configurado, y solo
  entonces escribe `panel-intermediate-N.pem`/`panel-crl.pem` (nunca toca
  los ficheros de la raiz) y reindexa con `openssl rehash`. Idempotente.
  - **Recarga (corregido en 14.5)**: en FreeRADIUS 3 un `reload` (HUP) NO
    vuelve a cargar los contextos TLS de `rlm_eap` -una CRL nueva no se
    aplicaria-, asi que se ha quitado ese camino por completo. Si
    `tls-config tls-vpn` ya tiene `ca_path_reload_interval` (FreeRADIUS
    3.2+, confirmado en la documentacion oficial), el script no reinicia
    nada; si no, hace `freeradius -XC` (nunca reiniciar con una
    configuracion rota) y solo entonces `systemctl restart` (nunca
    `reload`), solo cuando hay cambios.
  - **Etiqueta PEM de la CRL (corregida en el panel, 14.5)**: `@peculiar/x509`
    exportaba las CRL como `-----BEGIN CRL-----`, no
    `-----BEGIN X509 CRL-----` (RFC 7468 §4, la unica que `openssl crl`/
    `PEM_read_bio_X509_CRL` reconocen). Nueva `crlToPem()` en `lib/x509.ts`,
    usada por `services/pki.ts` al guardar `crl_pem`: `GET /pki/crl.pem` ya
    sirve siempre la etiqueta correcta. El `sed` del script se deja como
    tolerancia hacia paneles desplegados antes de este fix (comentado en el
    propio script), ya no hace falta contra uno al dia.
  - Tests: `server/src/lib/deployScripts.test.ts` ampliado con shellcheck
    (si esta disponible) y una integracion real de extremo a extremo contra
    una CA de prueba generada con `@peculiar/x509`: sincroniza con exito, es
    idempotente en una segunda pasada, rechaza si la raiz local no coincide
    con la huella esperada, rechaza una intermedia que no cuelga de esa
    raiz aunque el "servidor" traiga su propia raiz en la respuesta, y
    rechaza una CRL ya caducada. Nuevos tests en `services/pki.test.ts`
    (`crlToPem`) confirmando con `openssl crl` real que la salida se lee
    sin ninguna conversion.
  - README: instalacion completa (con `ROOT_CERT_FILE`/`ROOT_CERT_SHA256`
    reales de esta instalacion), como activar `ca_path_reload_interval`,
    verificacion con `openssl verify -CApath ... -crl_check_all` contra un
    certificado de dispositivo real, y como volver atras.
  - Rama `feat/vpn-14-freeradius-sync`, pendiente de revision.

- **Prompt 12.5 (huellas del panel, lado servidor)**: cambio de diseno para
  que las apps (Windows/Android) puedan ser clientes GENERICOS, como
  FortiClient, compilados sin ninguna clave de didev incrustada, con
  confianza fijada por servidor en el primer uso (TOFU) en vez de una clave
  publica fija en el binario.
  - El sobre firmado (`payload`, `signature`, `keyId`) gana un cuarto campo,
    `signerPublicKey`: la clave publica Ed25519 del panel, SPKI DER en
    base64url, la MISMA en las dos variantes (`full`/`qr`). Va fuera del
    payload firmado a proposito (es publica: quien firmo, no parte de lo
    firmado).
  - El payload firmado gana `signerKeySha256`: SHA-256 hex del SPKI DER de
    `signerPublicKey`. Al ir DENTRO de lo firmado, liga esa clave al
    payload — un sobre no puede traer una `signerPublicKey` que no sea la
    que realmente firmo sin que la firma deje de verificar.
    `server/src/lib/vpnProfileSigning.ts`: nuevas
    `getSignerPublicKeySpkiBase64Url()`/`getSignerPublicKeySha256Hex()`.
  - **Huellas visibles para comparar a ojo**: junto al QR/fichero al generar
    un token de alta, y en la nueva seccion "Huellas de confianza" de
    **VPN > Ajustes** (`GET /vpn-settings`), el panel muestra "Huella del
    panel" (`signerKeySha256`) y "Huella de la raiz" (`rootCaSha256`), cada
    una en grupos de 4 caracteres hex en MAYUSCULAS, completa, mas un
    "codigo corto" (los primeros 8 grupos) para comparar de un vistazo.
    Formato nuevo en `server/src/lib/fingerprint.ts`
    (`formatFingerprint`), usado por `generateEnrollToken` (nuevos
    `panelKeyFingerprint`/`rootCaFingerprint` en la respuesta) y por la
    ruta `GET /vpn-settings`.
  - Frontend: nuevo componente `web/src/components/FingerprintDisplay.tsx`
    (codigo corto grande + huella completa debajo), usado en el modal de
    "Token de alta generado" (`VpnDevices.tsx`) y en la pagina de Ajustes
    VPN (`VpnSettings.tsx`).
  - El QR compacto (variante `qr`) sube de version ~25 a ~27 por los dos
    campos nuevos (`signerPublicKey` en el sobre, `signerKeySha256` en el
    payload): sigue siendo razonablemente escaneable, ya no tan holgado
    como antes.
  - Documentado en el README el contrato completo de confianza en el primer
    uso (verificacion de autoconsistencia en la primera importacion,
    confirmacion explicita del usuario comparando huellas, anclaje por
    servidor, y rechazo sin opcion de aceptar si un servidor ya conocido
    cambia de identidad) — es el contrato que debe implementar cualquier
    app (Windows del prompt 12.5, Android del futuro prompt 13).
  - Tests: `signerPublicKey`/`signerKeySha256` verificados en
    `vpnProfileSigning.test.ts`, `vpnProvisioning.test.ts` y
    `vpnDevices.test.ts` (incluida la consistencia entre el sobre, el
    payload firmado y las huellas formateadas de la respuesta); nuevo
    `fingerprint.test.ts` para el formato de agrupacion.
  - Solo el lado del panel: la reescritura de `didev-vpn-windows` como
    cliente generico con TOFU (mismo prompt 12.5) va en
    `feat/vpn-12-windows-wip`, no en esta rama.
- **Prompt 12 (app de Windows)**: `didev-vpn-windows`
  (`APPS/Windows/code/`), app de bandeja en C#/.NET 8 WinForms que configura
  y mantiene la conexion VPN IKEv2/EAP-TLS de didev usando el cliente nativo
  de Windows (RAS/cmdlets `VpnClient`, invocados via `powershell.exe`; sin
  IPsec propio), en dos variantes generadas desde el mismo codigo:
  - **Instalador** (`didev-vpn-setup-<version>.msi`, WiX v5): Program Files,
    raiz "didev Root CA" en `LocalMachine\Root` y tarea de renovacion para
    todos los usuarios en una unica elevacion; `MajorUpgrade` in situ.
  - **Portable** (`didev-vpn-portable-<version>.zip`): un unico `.exe`
    self-contained, sin instalar nada salvo una elevacion UAC puntual la
    primera vez que hace falta confiar en la raiz (necesaria en
    `LocalMachine\Root` porque el propio certificado del gateway IKE, no
    solo el de RADIUS, lo exige ahi).
  - Importa y verifica el perfil `.didevvpn` (variante `full` de los
    prompts 11/11.5: firma Ed25519 con BouncyCastle, `caChainPem`,
    `rootCaSha256`), comprobando ademas que el `keyId` del sobre coincida
    con `ProfileVerifier.ExpectedKeyId` (mensaje claro de "actualiza la
    app" si el panel rota de clave, en vez de un generico "firma
    invalida") y que `variant` sea exactamente `"full"`.
  - Alta: clave ECDSA P-256 no exportable en el TPM (CNG, "Microsoft
    Platform Crypto Provider"; confirmacion explicita si hay que caer a
    software), CSR con CN y SAN dNSName = `cn` del perfil, `simpleenroll`
    con el token de un solo uso. Version minima de app: como el perfil no
    trae `minAppVersion` (solo lo sabe `GET /status`, que exige TLS mutuo),
    se comprueba justo DESPUES de `simpleenroll` -con el certificado recien
    emitido, aun sin instalar- y ANTES de instalar el certificado o tocar
    la conexion VPN; si el panel exige actualizar, el alta se aborta sin
    dejar nada a medias (el token ya consumido: hace falta uno nuevo).
  - Renovacion: `GET /status` con TLS mutuo al abrir la app/cada 12h/a mano;
    si toca, clave nueva en el TPM, `simplereenroll`, e instala el
    certificado nuevo borrando el anterior. Bloquea si `minAppVersion` del
    panel supera la version instalada.
  - Icono de bandeja: conectar/desconectar, estado, IP asignada, caducidad
    del certificado, ultimo error, variante+version, "Quitar de este
    equipo" (borra conexion/tarea/configuracion, pregunta por el
    certificado).
  - Validacion TLS de EST fijada a la raiz+intermedia del propio perfil
    (`X509ChainTrustMode.CustomRootTrust`), nunca al almacen de confianza
    general de Windows.
  - Desinstalacion del MSI: una custom action interactiva
    (`UninstallCleanupCmd`, inmediata, `--uninstall-cleanup --uilevel=N`)
    pregunta, si la desinstalacion no es silenciosa, si borrar el
    certificado/conexion del usuario que desinstala, y -solo si, tras eso,
    ningun otro perfil de usuario de la maquina (`C:\Users\*\AppData\Local\
    didev-vpn\device.json`) sigue teniendo un dispositivo dado de alta- si
    retirar tambien la raiz de confianza. Limitacion que queda: no puede
    tocar la conexion/certificado de OTROS usuarios de la maquina (haria
    falta cargar su perfil); cada uno debe usar "Quitar de este equipo"
    antes de una desinstalacion completa en un equipo compartido.
  - Clave publica Ed25519 de firma de perfiles leida de un fichero de
    configuracion de compilacion (`DidevVpn.App/SigningKey/
    vpn-profile-signing-ed25519.pub.pem`, nunca escrita a mano en el
    codigo): mientras siga siendo el placeholder del repositorio, un target
    de MSBuild hace fallar la compilacion con un mensaje claro -nunca debe
    salir un binario que no pueda verificar firmas-.
  - `APPS/Windows/ejecutables/`: solo se versiona su propio `README.md`
    explicando que `build.ps1` deja ahi el `.msi`/`.zip`/`SHA256SUMS.txt`
    (nunca los binarios).
  - Tests xUnit (49) sobre `DidevVpn.Core` (logica sin dependencias de
    Windows): verificacion Ed25519 con un vector de interoperabilidad real
    de OpenSSL, rechazo de variante/version/keyId/caducidad/firma
    manipulada, comparacion de versiones semanticas, mapeo de propuestas
    IPsec, e interpretacion de `UILevel` de MSI para saber cuando NO se
    puede preguntar nada durante una desinstalacion.
  - Verificado de verdad: compilacion real de las cuatro capas (incluido
    el instalador WiX, `wix build` con ICE), ciclo real de fallo/exito del
    build con el placeholder/una clave de prueba real, ejecucion real del
    `.exe` compilado, y (en un build anterior de este mismo prompt) un
    `build.ps1` completo produciendo un `.msi`/`.zip`/`SHA256SUMS.txt`
    reales. Sin verificar en una maquina Windows 11 real: negociacion IKE
    contra strongSwan real, necesidad exacta de `LocalMachine\Root` vs.
    `CurrentUser\Root` para cada certificado, custom actions del MSI en una
    instalacion/desinstalacion elevada real (incluida si el dialogo de
    `UninstallCleanupCmd` aparece donde se espera), multiples usuarios de
    Windows en la misma maquina. Detalle completo, riesgos y lista de
    pruebas manuales en `APPS/Windows/README.md`.
  - En rama `feat/vpn-12-windows-wip`, pendiente de revision antes de
    fusionar en `vpn`.

- **Correccion 11.5 (QR compacto)**: el sobre firmado completo, con la
  cadena de CA (raiz + intermedia P-384 reales) dentro, ocupa ~2800
  caracteres — cabe por poco en un QR de nivel L (maximo 2953 en modo
  byte), pero sale una version ~39 practicamente imposible de escanear
  desde una pantalla, y con nombres un poco mas largos habria dejado de
  caber sin avisar (`buildProvisioningQrDataUrl` se limitaba a devolver
  `null` en silencio).
  - Anadido `rootCaSha256` (SHA-256 en hex del DER de la raiz) al payload
    firmado, presente siempre, en las dos variantes.
  - El perfil ahora tiene dos variantes, cada una firmada por separado (su
    propio sobre, mismo `keyId`, campo `variant` dentro del payload para
    que no se puedan confundir): `"full"` (fichero `.didevvpn`, con
    `caChainPem`) y `"qr"` (sin `caChainPem`, solo `rootCaSha256`). El QR
    ahora codifica siempre la variante `qr`, con nivel de correccion M (mas
    robusto que L; sobra margen sin la cadena) — cabe con holgura en una
    version ≤ 25 incluso con nombres largos.
  - Contrato documentado en el README ("Aprovisionamiento de apps") para
    quien construya las apps (prompts 12/13): al recibir la variante `qr`,
    la app pide `GET /.well-known/est/cacerts` sin validar TLS todavia (RFC
    7030 §4.1.1), calcula el SHA-256 de la raiz recibida y solo la acepta
    si coincide exactamente con `rootCaSha256` — solo entonces esa raiz se
    usa para validar de verdad el TLS de EST y la intermedia.
  - Si el QR compacto aun asi no llegara a caber, la pantalla lo dice
    explicitamente (ya lo hacia desde el prompt 11: la alternativa del
    fichero `.didevvpn` siempre esta visible) en vez de omitirlo en
    silencio.
  - `buildSignedProvisioningProfile` (una sola variante) pasa a llamarse
    `buildSignedProvisioningProfiles` (construye y firma las dos a la vez,
    reutilizando una unica consulta de ajustes/cadena de CA).
  - Tests: con una cadena P-384 realista (raiz "didev Root CA" + intermedia,
    generadas en el test) se comprueba que el QR compacto cabe en version
    ≤ 25 mientras el completo ni siquiera cabe en nivel M; que solo la
    variante `full` lleva `caChainPem`; que las dos llevan `rootCaSha256` y
    verifican con la clave publica: y que las dos firmas son independientes
    (la de una variante no vale para el payload de la otra).

- **Aprovisionamiento de apps (prompt 11)**: perfil de conexion firmado
  (`.didevvpn`) para configurar las futuras apps propias de Windows/Android
  con un solo paso, en vez de tener que introducir cada parametro a mano.
  - Al generar el token de alta de un dispositivo (ficha del dispositivo →
    "Generar token de alta"), si `VPN_PROFILE_SIGNING_KEY` esta configurada,
    el panel construye ademas un perfil JSON (servidor, identidad AAA,
    cadena de CA, propuestas IKE/ESP, modo de tunel y sus rutas de split
    tunnel, DNS, URL de EST, y el propio token de alta) y lo firma con
    Ed25519. Se entrega una unica vez, con la misma caducidad de 24h que el
    token: como fichero `.didevvpn` descargable (Windows) y como codigo QR
    (Android). Sin esa variable configurada, "Generar token de alta" sigue
    funcionando exactamente igual que antes (solo el token, sin perfil).
  - La clave privada **no la genera el codigo**: es un paso manual de
    `openssl genpkey -algorithm ED25519` en la `.28`, fuera del arbol de git,
    referenciada solo por ruta (`VPN_PROFILE_SIGNING_KEY`, PEM, permisos
    600) — igual que `EST_TLS_KEY`. La clave publica correspondiente se
    incrusta en las apps para que ninguna acepte un perfil que no venga de
    este panel. Documentado en el README ("Aprovisionamiento de apps"), con
    los comandos exactos.
  - Formato de firma: un sobre `{ payload, signature, keyId }` donde
    `payload` es el base64url de los bytes UTF-8 **exactos** del JSON (nunca
    se re-serializa para verificar, asi que verificar no depende de
    reproducir bit a bit el mismo formateo en otro lenguaje/libreria) y
    `signature` es la firma Ed25519 de node:crypto sobre esos mismos bytes.
  - `GET /.well-known/est/status` publica ahora tambien `minAppVersion`
    (`panel_vpn_settings.min_app_version`, migracion nueva
    `sql/panel-schema-vpn-provisioning.sql`, por defecto `0.0.0`), para que
    las apps puedan bloquear el alta y la renovacion si van por debajo de la
    version minima soportada.
  - El QR se genera con la libreria `qrcode` que ya usaba el 2FA; si el
    contenido no cupiera en un QR legible (la cadena de CA puede ser larga),
    se omite sin fallar -el fichero `.didevvpn` sigue siempre disponible-.
  - Verificado: el modelo de datos ya soportaba varios dispositivos para el
    mismo equipo, uno por usuario (`vpn-<owner_user>-<device_label>`,
    correccion 4.5) y el limite de 32 caracteres/unicidad de cada parte ya
    se validaban; se anadieron los tests que faltaban para dejarlo
    demostrado (`NAME_PART_RE`, dos dispositivos con el mismo
    `device_label` y distinto `owner_user`).
  - Tests: firma y verificacion Ed25519 (incluida una firma manipulada byte
    a byte, y una firma cruzada con la clave publica de otra clave),
    contenido exacto del payload por modo de tunel, que el unico campo
    secreto del perfil es `enrollToken` (todo lo demas ya es publico por su
    cuenta), y el flujo completo de `generateEnrollToken` con y sin la clave
    de firma configurada.

- **Modulo VPN IKEv2/EAP-TLS (en curso)**: primer paso, esquema de base de datos.
  `vpn_certificates` en la base `radius` (serial, huella de clave publica,
  vigencia, estado activo/renovado/revocado) y, en la base del panel,
  `panel_vpn_devices`, `panel_vpn_enroll_tokens` (solo hash del token de alta),
  `panel_pki_ca` y `panel_vpn_settings` (FQDN, rango de IPs, dias de vigencia y
  renovacion). Opcional como `panel_user_meta`: sin estas tablas el panel
  arranca igual y `/api/meta` anuncia `vpnEnabled: false`. Migraciones
  idempotentes, registradas en `npm run menu`.
- **Pagina "PKI" de la VPN** (solo admin): genera la clave y el CSR de la CA
  intermedia en **ECDSA P-384** (la clave se cifra con `PKI_MASTER_KEY`, nunca
  sale del servidor ni se audita), importa el certificado firmado offline por
  la raiz con validacion completa (firma, vigencia, `BasicConstraints CA:true`
  con `pathLenConstraint=0`, `KeyUsage keyCertSign`+`cRLSign`, `ExtendedKeyUsage`
  unicamente `clientAuth`, clave ECDSA P-384 y que la clave publica coincida
  con el CSR generado — una intermedia mal firmada, con curva distinta o sin
  estos limites no se puede activar) y soporta rotacion (la intermedia anterior
  pasa a "retirandose": sigue publicando CRL hasta que caduca, pero deja de
  firmar). Publica sin autenticacion `GET /pki/ca-chain.pem` y `GET /pki/crl.pem`
  (CRL con `nextUpdate` a 7 dias, regenerada al importar y a diario); la pagina
  incluye el script y la unidad systemd de ejemplo para que el host de
  FreeRADIUS la sincronice cada hora.
- **Emision de certificados de dispositivo** (libreria, todavia sin endpoint
  HTTP): `signDeviceCsr` verifica la firma del CSR, exige que el CN coincida
  con el username del dispositivo, acepta solo ECDSA P-256/P-384 o RSA >= 3072
  e ignora cualquier extension pedida por el CSR — el certificado emitido
  lleva siempre el mismo perfil (KeyUsage `digitalSignature`, EKU `clientAuth`,
  SAN `dNSName` = CN, AKI/SKI, serial aleatorio de 128 bits, fechas UTC con
  `notBefore` 5 minutos antes de la emision). Cadena raiz → intermedia →
  dispositivo verificada con `openssl verify` en los tests.
- **Seccion "VPN > Dispositivos"** (solo admin): alta en una unica operacion
  (asigna la primera IP libre del pool revisando `radreply` de todos los
  usuarios, `radcheck` con `Service-Type == Framed-User`, `radusergroup` = `vpn`
  y la ficha en `panel_vpn_devices`; si falla el paso del panel se deshacen a
  mano las filas RADIUS ya confirmadas, porque panel y radius pueden vivir en
  servidores MySQL distintos). Usuario RADIUS = `vpn-<owner_user>-<device_label>`.
  Ficha del dispositivo con historial de certificados, sesiones (reutiliza
  `/users/:u/activity`), ultima emision y proxima renovacion esperada. Token de
  alta de un solo uso (24h, solo se guarda su hash; generar uno nuevo borra el
  anterior). Activar/desactivar reutiliza `Auth-Type := Reject` + desconexion
  CoA existentes. Revocar certificado regenera la CRL de la CA que lo firmo
  (`vpn_certificates.ca_id`) y desconecta la sesion. Dar de baja revoca,
  desconecta, borra las filas RADIUS (libera la IP) y conserva el historial de
  certificados. El editor generico de usuarios avisa si el usuario es un
  dispositivo VPN y enlaza a su ficha.
- **Correccion 4.5**: se detecto a mitad de desarrollo un `CLAUDE.md` con el
  modelo de datos y la criptografia que debia seguir el modulo VPN, distintos
  de lo ya construido en los prompts 1-4 (RSA en vez de ECDSA, `ca_serial` en
  vez de `ca_id`, esquema de `panel_pki_ca`/`panel_vpn_devices` distinto). Este
  commit realinea todo con ese modelo: vease el detalle en cada punto de
  arriba. El modulo no se habia desplegado en produccion todavia, asi que
  `panel_pki_ca` y `panel_vpn_devices` se recrean vacias con el esquema
  correcto en vez de migrarse con ALTER/RENAME; `radius.vpn_certificates` (que
  si tiene datos reales, la fila de prueba `vps`) se migra con ALTER
  idempotente normal.
- **EST (RFC 7030)** para que los dispositivos VPN pidan su primer certificado
  y lo renueven solos, sin que un admin tenga que firmar nada a mano. Listener
  HTTPS propio y separado de la API principal (`EST_PORT`, por defecto 8443;
  no pasa por nginx porque necesita TLS mutuo real, que un proxy que termina
  TLS no puede reenviar), con `requestCert: true`, `TLSv1.2` como minimo y solo
  cifrados ECDHE+AEAD (`ECDHE-*-AES*-GCM-*`, `ECDHE-*-CHACHA20-POLY1305`).
  Rutas bajo `/.well-known/est/`:
  - `GET cacerts`: la cadena intermedia+raiz en PKCS7 "certs-only" (sin login).
  - `POST simpleenroll` (alta): autenticacion con HTTP Basic donde el usuario
    es el username del dispositivo y la contrasena es el token de alta de un
    solo uso. Orden de validacion: (1) el dispositivo existe y esta activo;
    (2) el token se reclama de forma atomica (`UPDATE ... WHERE token_sha256
    = ? AND used_at IS NULL AND expires_at > NOW()`, y solo sigue si
    `affectedRows = 1`) — se reclama *antes* de firmar nada, no despues, para
    que dos peticiones simultaneas con el mismo token no puedan acabar las dos
    con un certificado valido; (3) el CSR tiene que traer el mismo CN que el
    username del dispositivo; (4) hay una CA intermedia activa. Solo entonces
    se firma con el perfil fijo de `signDeviceCsr` (vease la entrada de
    "Emision de certificados de dispositivo" mas arriba).
  - `POST simplereenroll` (renovacion): autenticacion por el certificado de
    cliente que ya trae la conexion TLS (mTLS), no por contrasena. Orden de
    validacion, pensado para que un certificado caducado nunca se reporte
    como "cadena invalida" (la libreria de X.509 comprueba la vigencia dentro
    de `.verify()` y devuelve `false` para un certificado caducado aunque la
    firma sea correcta): (1) el cliente presento un certificado; (2) el
    numero de serie es uno que emitimos nosotros (`vpn_certificates`); (3) no
    esta caducado — comprobado con fechas antes de verificar la firma, por la
    razon de arriba; (4) la firma de la cadena verifica de verdad contra la
    CA que segun la base de datos lo emitio (evita que un certificado real
    pero de otra CA, con el `ca_id` adulterado, pase la validacion); (5) no
    esta revocado; (6) su estado es `activo` (no ya `superseded`); (7) el
    dispositivo sigue habilitado; (8) el CN del CSR coincide con el del
    certificado que se esta renovando; (9) la firma del CSR es valida y su
    clave publica no es una que el dispositivo ya uso antes (evita reutilizar
    la misma clave privada indefinidamente); (10) han pasado al menos 12h
    desde la ultima emision (limite de frecuencia, evita renovaciones en
    bucle). Al emitir la renovacion, el certificado anterior pasa a
    `superseded` con una ventana de solapamiento (no se revoca en el acto:
    así una sesion IKEv2 ya establecida con el certificado viejo no se corta
    a mitad de la renovacion).
  - `GET status` (opcional, mTLS igual que la renovacion): dias que le quedan
    al certificado presentado y si ya toca renovar.
  Respuestas de error sin detalles internos (nunca stack, SQL ni motivo fino
  en el cuerpo), pero con auditoria completa en `panel_audit_log` (dispositivo,
  IP, motivo exacto de cada rechazo) y metricas Prometheus
  (`est_enrollments_total`, `est_renewals_total`, `est_rejections_total` por
  endpoint y motivo). `POST simpleenroll` tiene rate-limit propio (20
  peticiones / 15 min) porque es el unico paso autenticado solo por contrasena.
  El listener no arranca si falta `EST_TLS_CERT`/`EST_TLS_KEY` o si
  `EST_ENABLED=false`: el resto del panel sigue funcionando igual, solo que
  sin alta/renovacion automatica.
- **Paquete de conexion descargable** desde la ficha del dispositivo (boton
  "Descargar paquete de conexion"), para Windows y Linux/VPS -Android
  todavia se configura a mano en la app de strongSwan-. Nunca incluye
  claves ni el token de alta: las plantillas solo llevan datos publicos
  (`panel_vpn_settings`, la cadena de la CA) y el token se pide por pantalla
  al ejecutar el script de alta.
  - **Windows** (`.zip`): `install.ps1` crea la conexion IKEv2 "Casa" con
    EAP-TLS (perfil `EapHostConfig`/EAP tipo 13 de Microsoft, con
    `TrustedRootCA` fijado a la huella de la raiz que el propio script
    importa en `Cert:\LocalMachine\Root`) y GCMAES256/SHA384/ECP384 en las
    dos fases IPsec; `enroll.ps1` genera la clave en el TPM del equipo
    (ECDSA P-256, no exportable -si no hay TPM, avisa y usa el proveedor de
    software de Windows, igual de no exportable-), pide el token por
    pantalla y da de alta el certificado por `simpleenroll`, y de paso
    programa `renew.ps1` en el Programador de tareas (diario y al iniciar
    sesion); `renew.ps1` consulta `GET status` de EST para saber si toca
    renovar (evita que el cliente tenga que repetir la cuenta de dias que
    ya hace el servidor) y renueva por `simplereenroll` sin pedir nada.
  - **Linux/VPS** (`.tar.gz`): `casa.conf` (fragmento de `swanctl.conf`,
    `remote_ts` a la LAN de casa en modo split o a todo el trafico en modo
    full), `vpn-enroll` (bash + openssl + curl: clave ECDSA P-384 en
    `/etc/swanctl/ecdsa` con permisos 600, token leido de la entrada
    estandar -nunca como argumento-) y `vpn-renew` + unidades systemd
    (`vpn-renew.timer`, diario): renueva por `simplereenroll`, conserva la
    clave y el certificado anteriores y solo los borra despues de comprobar
    que `swanctl --initiate` levanta la conexion con los nuevos; si no
    levanta, restaura los anteriores.
  - Probado descomprimiendo de verdad los bytes del zip/tar.gz generados
    (no solo "no lanza"): se listan los ficheros esperados, se comprueban
    los permisos ejecutables del `.tar.gz` y se busca en cada fichero
    cualquier rastro de clave privada o secreto.
- **Certificado Android emitido por el panel (excepcion documentada)**: la
  app de strongSwan para Android no sabe renovarse sola por EST (RFC 7030),
  asi que para estos dispositivos -y solo para ellos- es el panel quien
  genera la clave privada, en vez de limitarse a firmar un CSR ajeno como en
  el resto del modulo. Boton "Emitir certificado" en la ficha del
  dispositivo (mismo perfil de certificado que un alta por EST, vigencia
  `android_cert_days`, con el mismo solapamiento de una renovacion normal si
  ya habia un certificado activo):
  - Genera una clave ECDSA P-256 y construye un `.p12` (estructura
    equivalente a `openssl pkcs12 -export`: `PKCS8ShroudedKeyBag` +
    `SafeContents` cifrado, AES-256-CBC/PBKDF2/SHA-256, con el mismo
    `localKeyId` en la bolsa de la clave y la del certificado para que el
    importador -incluido el de Android- los empareje) protegido con una
    contrasena aleatoria de 20 caracteres, que se ensena una unica vez en el
    panel y no se guarda en ningun sitio.
  - La descarga real es un perfil `.sswan` (formato de importacion del
    cliente strongSwan para Android, verificado contra
    `docs.strongswan.org/docs/latest/os/androidVpnClientProfiles.html`:
    `type: "ikev2-eap-tls"`, con el `.p12` embebido en `local.p12` en base64
    y la raiz de la CA en `remote.cert` -el servidor ya envia la intermedia
    durante el handshake IKE, y el formato solo admite un certificado de
    confianza-, con `ike-proposal`/`esp-proposal` fijos a
    `aes256gcm16-prfsha384-ecp384`/`aes256gcm16-ecp384` y siempre full
    tunnel). El `.p12` se cifra ademas en reposo con `PKI_MASTER_KEY`
    mientras espera su descarga: dos secretos independientes (la contrasena
    del `.p12` y la master key del servidor), ninguno de los dos vive en la
    base de datos.
  - El enlace de descarga es deliberadamente publico (sin sesion de admin:
    quien lo abre puede ser el propio telefono del usuario final, que no
    tiene por que estar dado de alta en el panel), pero de un solo uso,
    caduca a los 15 minutos y solo funciona desde el rango de la VPN o la
    LAN (`panel_vpn_settings.lan_cidr`, columna nueva). Al servirlo se borra
    la fila entera -el `.p12` no sigue viviendo en la base de datos-; los
    enlaces caducados que nunca llegan a descargarse se purgan a diario.
  - Probado de extremo a extremo con `openssl pkcs12 -info` sobre los bytes
    reales generados (abre con la contrasena mostrada, la rechaza con
    cualquier otra) y con la base de datos simulada: el enlace no sirve dos
    veces ni caducado, y solo dentro del rango de IP configurado.
- **Mantenimiento periodico del modulo VPN** (`npm run vpn:jobs`, idempotente
  y seguro si dos ejecuciones se solapan gracias a `GET_LOCK` de MySQL -la
  segunda se omite al momento en vez de esperar-; en produccion lo dispara
  `deploy/radius-panel-vpn-jobs.timer` cada 15 minutos):
  - Certificados `superseded` cuya ventana de solapamiento ya paso pasan a
    `revoked` (motivo `superseded`) y regenera la CRL de su CA.
  - `getRevokedEntriesForCa` ya no incluye en la CRL los revocados que
    tambien han caducado por su cuenta (un certificado caducado se rechaza
    igualmente, RFC 5280, asi que mantenerlo ahi solo hincha el fichero); el
    job fuerza una regeneracion en cuanto uno cruza esa fecha, en vez de
    esperar al siguiente ciclo normal de la CRL.
  - Tokens de alta EST caducados (usados o no) se borran.
  - Regenera la CRL de cualquier CA a la que le queden menos de 3 dias
    (antes 1 dia y solo dentro del proceso de la API; ese timer interno se
    mantiene como red de seguridad con el mismo margen de 3 dias, por si el
    timer de systemd no llegara a desplegarse en algun servidor, pero
    `vpn:jobs` es ahora quien lo hace con mucha mas frecuencia).
- **Alertas de salud del modulo VPN**, en la tarjeta "VPN" del panel (solo
  admin) y como Gauges en `/metrics` (se recalculan en cada scrape, sin
  timer propio): dispositivos Windows/Linux cuya renovacion automatica
  deberia haber saltado y no lo ha hecho -en rojo los que caducan en menos
  de 3 dias, o si no tienen ningun certificado activo-, dispositivos Android
  que caducan en menos de 30 dias (no tienen renovacion automatica que
  pueda fallar, asi que es un aviso aparte, no una "renovacion fallida"),
  la CA intermedia si caduca en menos de 90 dias, y un pico de rechazos EST
  en la ultima hora por encima de un umbral fijo (20, todavia sin pagina de
  ajustes donde configurarlo).
- **Sistema de temas**: modo claro, oscuro y automatico (el del sistema) mas siete
  colores de acento, con la preferencia guardada en el navegador.
- **Seguridad del panel**:
  - Access token de vida corta en memoria y refresh token en cookie HttpOnly con
    rotacion y deteccion de reuso.
  - Verificacion en dos pasos (TOTP) con codigo QR y secreto cifrado en reposo.
  - Bloqueo de cuenta tras varios intentos fallidos, con desbloqueo manual.
  - Rate-limit por usuario ademas del que ya habia por IP.
  - Pagina "Mi cuenta" para cambiar la contrasena, gestionar el 2FA y revocar
    sesiones abiertas.
  - Cabeceras de seguridad con CSP estricta y HSTS en produccion.
  - **Login con Google** (opcional, junto al local): un admin vincula su email
    desde "Mi cuenta" y a partir de ahi puede entrar con el boton de Google;
    el vinculo real se guarda por `google_sub` (no por email, que se puede
    reciclar). Sin alta libre: solo funciona para cuentas de administrador que
    ya existian.
  - `GOOGLE_ENABLED` apaga el boton de Google sin borrar las credenciales.
- **Email/notas por usuario RADIUS** (opcional): campo de contacto y notas
  libres en la ficha de cada usuario, para poder escribirle o dejar constancia
  de algo sin tocar `radcheck`/`radreply`. Vive en una tabla propia del panel
  (`panel_user_meta`), unida por username en la aplicacion, no con un JOIN SQL
  (la base de FreeRADIUS puede estar en otro servidor). Visible en la tabla,
  la ficha lateral y el export CSV.
- **Reportes**: comparativa entre periodos, mapa de calor por hora y dia, pico de
  sesiones simultaneas, reparto por duracion de sesion, actividad por NAS y
  deteccion de anomalias.
- **Interfaz**: buscador global con Ctrl/Cmd+K, ficha lateral del usuario con su
  actividad, acciones en bloque sobre usuarios, filtros en la URL, estados vacios
  con contexto y carga con filas fantasma.
- **Operacion**: configuracion validada al arrancar, logs estructurados con pino,
  metricas Prometheus en `/metrics` y comprobacion del esquema de la base de datos
  al iniciar.
- **Calidad**: ESLint integrado en el CI y tests del cifrado y del flujo TOTP.
- **Firewall de la VM VPN generado desde el panel** (192.168.10.29, `tabla
  inet vpn_clients`): sustituye las reglas nftables editadas a mano por un
  fichero generado a partir de los permisos de cada dispositivo.
  - En la ficha del dispositivo, permisos de red: "internet" (`0.0.0.0/0`),
    "toda la LAN" (`panel_vpn_settings.lan_cidr`) o un destino concreto
    (IP/CIDR, protocolo y puerto opcionales). El acceso a EST
    (`192.168.10.28`, el puerto de `EST_PORT`) se anade siempre, sin
    depender de ningun permiso.
  - `192.168.10.28` (RADIUS) y `192.168.10.30` (MariaDB) estan siempre
    bloqueados para los clientes VPN -incluso si un permiso como "toda la
    LAN" los incluiria- salvo que un admin active la excepcion explicita
    para ese dispositivo concreto (con aviso en la interfaz antes de
    confirmar). El orden de las reglas generadas es critico: el bloqueo va
    antes que los permisos propios del dispositivo, porque nftables aplica
    el veredicto de la primera regla que hace match.
  - `GET /vpn/gateway/firewall.nft` genera el fichero completo a partir de
    todos los dispositivos activos (con IP asignada). Sin `requireAuth`
    -lo consulta la VM VPN, no un admin con sesion-, autenticado con un
    token de la puerta de enlace (`Authorization: Bearer`, solo su hash en
    `panel_vpn_settings.gateway_token_sha256`) que se genera desde la nueva
    pagina "VPN > Ajustes" y se ensena una unica vez.
  - `deploy/vpn-gateway-agent.sh` + unidad systemd (`.service`/`.timer`,
    cada 5 min) para la VM VPN: descarga el fichero, lo valida con
    `nft -c -f` y solo entonces lo aplica (`nft -f`); si la descarga, la
    validacion o la aplicacion fallan, conserva el firewall que ya estaba
    cargado.
  - Tests: generacion del fichero para varios casos (uno o varios
    dispositivos, cada tipo de permiso, la excepcion de RADIUS/MariaDB) y,
    si esta disponible, `nft -c -f` sobre la sintaxis generada de verdad;
    `shellcheck` sobre `vpn-gateway-agent.sh`.

- **Cierre del modulo VPN**: documentacion y revision de seguridad de todo el
  codigo nuevo (PKI, EST, dispositivos, paquetes de conexion, Android,
  firewall de la puerta de enlace), como si fuera una revision externa.
  - `README.md`: seccion nueva "VPN y certificados" (arquitectura, paginas
    del panel, variables de entorno, las 8 migraciones en el orden correcto
    con la base de cada una, puesta en marcha paso a paso de la CA
    intermedia, alta de un dispositivo por plataforma, instalacion del
    firewall de la puerta de enlace, mantenimiento periodico).
  - `SECURITY.md` (nuevo): modelo de amenazas (panel comprometido, token de
    alta filtrado, certificado de dispositivo robado, dispositivo
    perdido/robado, VPS comprometido, solo la base de datos comprometida) con
    que mitiga cada caso; copias de seguridad de `panel_pki_ca` y de
    `PKI_MASTER_KEY` **por separado** (y por que no deben acabar juntas);
    procedimiento completo si hay que revocar la CA intermedia (emitir una
    nueva, revocar en bloque los certificados de la comprometida, regenerar
    su CRL, marcarla `retired`, re-enrolar cada dispositivo afectado).
  - **Correcciones encontradas en la revision**:
    - Condicion de carrera al asignar la IP de un dispositivo nuevo: el
      `SELECT` de las IPs ya usadas en `radreply` no bloqueaba esas filas
      (`FOR UPDATE`), asi que dos altas simultaneas podian elegir la misma IP
      libre — el `UNIQUE` de `panel_vpn_devices.framed_ip` lo detectaba
      despues (sin corrupcion silenciosa), pero dejaba un momento con dos
      cuentas RADIUS con la misma `Framed-IP-Address` y la peticion que
      perdia la carrera fallaba con un error de clave duplicada en vez de un
      mensaje claro. Ahora el `SELECT` bloquea esas filas dentro de la misma
      transaccion.
    - El certificado de dispositivo emitido copiaba el `subject` completo del
      CSR (no solo el CN ya validado): un CSR podia pedir RDNs adicionales
      (`O`, `OU`...) que acababan en el certificado firmado sin validacion
      propia. Sin impacto real hoy (la identidad que usan strongSwan/RADIUS
      es el SAN `dNSName`, que siempre fija el servidor, no el subject), pero
      se corrige por defecto en profundidad: el subject emitido es siempre
      exactamente `CN=<username validado>`.
    - `simplereenroll`/`status` no tenian ningun rate-limit (a diferencia de
      `simpleenroll`, la descarga de Android o el firewall de la puerta de
      enlace): un certificado de dispositivo robado se podia usar para
      bombardear el endpoint con verificaciones X.509 completas y
      transacciones con filas bloqueadas. Anadido un limite (120 peticiones /
      15 min) generoso para no afectar el uso normal con varios dispositivos
      detras de la misma IP (NAT).
    - `deploy/vpn-gateway-agent.config.sh.example` documentaba `PANEL_URL`
      como el listener EST (puerto 8443), pero `GET /vpn/gateway/firewall.nft`
      vive en la API principal (otro servidor Express, otro puerto): con la
      configuracion de ejemplo tal como estaba, el agente de la puerta de
      enlace nunca habria conseguido descargar el fichero (404 constante) y
      el firewall generado desde el panel nunca se habria llegado a aplicar
      en produccion. Corregido el ejemplo (LAN directa a la API principal,
      `http://192.168.10.28:1003`) y anadidos los bloques
      `location /pki/`/`location /vpn/` que faltaban en
      `deploy/nginx-radius-panel.conf` para quien prefiera la URL publica en
      vez de la LAN directa.
    - `app.set('trust proxy', 1)` (`server/src/index.ts`) solo contaba un
      salto de proxy, pero la topologia real (confirmada con el usuario) tiene
      dos: Nginx Proxy Manager en **otra maquina**, delante del nginx local de
      `deploy/nginx-radius-panel.conf`, que es quien reenvia a la API. Con
      solo 1, `req.ip` resolvia a la IP de NPM en vez de la del cliente real
      para **toda** la API (no solo la VPN): rompia el rate-limit por IP en
      general y, en este modulo, la restriccion "solo desde la VPN o la LAN"
      de la descarga de Android y su propio rate-limit. Corregido a `2`
      primero y, en el prompt 10.5, revisado otra vez a una lista explicita
      de proxies de confianza (ver mas abajo): un numero de saltos no
      comprueba de quien viene cada salto, solo cuenta, y eso tiene su
      propio problema de seguridad.

### Corregido

- **Firewall de la puerta de enlace VPN (correccion 10.5)**: la revision de
  seguridad del cierre del modulo (prompt 10) no detecto estos fallos porque
  ninguno era "logica de negocio" comprobable sin conocer nftables/HTTP a
  fondo; revisados aparte con tests que los habrian detectado.
  - **No era idempotente**: `nft -f` sobre un script que solo declara
    `table X { chain Y { reglas } }` **anade** esas reglas cada vez, no las
    reemplaza — cada ejecucion del agente (cada 5 min) iba duplicando todas
    las reglas, y las de un dispositivo borrado no desaparecian nunca.
    Ahora el fichero generado borra y vuelve a definir la tabla entera en la
    misma ejecucion de `nft -f` (`table inet vpn_clients {}` para que el
    `delete` no falle la primera vez, `delete table inet vpn_clients`, y
    solo entonces la definicion completa).
  - **La VPN se habria caido para todos los dispositivos**: la cadena
    `forward` con `policy drop` solo tenia reglas `ip saddr <cliente> ...`;
    el trafico de vuelta (respuestas de internet/LAN hacia el cliente) no
    coincidia con ninguna y se habria descartado, porque en nftables un
    paquete tiene que ser aceptado por todas las cadenas base del mismo
    hook. Anadidas `ct state invalid drop` y
    `ct state established,related accept` al principio de la cadena.
  - **La misma tabla habria afectado a todo el forward de la maquina**, no
    solo a los clientes VPN (p.ej. el MSS clamp de `/etc/nftables.conf`),
    por tener su propia `policy drop` en el mismo hook. Primera regla de la
    cadena: `ip saddr != <pool VPN> ip daddr != <pool VPN> accept` — el
    trafico ajeno al pool de la VPN se acepta aqui sin mirarlo, y sigue
    evaluandose por su cuenta en las demas tablas.
  - **El permiso "internet" equivalia a "cualquier red", incluida toda la
    LAN**: `ip daddr 0.0.0.0/0 accept` no excluia nada. Ahora excluye
    RFC 1918 (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), CGNAT
    (`100.64.0.0/10`) y link-local (`169.254.0.0/16`) con un set anonimo
    (`ip daddr != { ... } accept`); quien quiera dar acceso a la LAN tiene
    el permiso "toda la LAN" aparte, sin mezclarlo con "internet".
  - **El agente descargaba el fichero por HTTP en claro**
    (`PANEL_URL=http://192.168.10.28:1003`): el token de la puerta de
    enlace viajaba sin cifrar por la cabecera `Authorization`, y ademas ese
    puerto no esta abierto desde la VM VPN en el firewall real de la .28
    (no habria funcionado de todas formas). `deploy/vpn-gateway-agent.sh`
    ahora exige HTTPS (se niega a arrancar si `PANEL_URL` no empieza por
    `https://`) y usa `curl --proto '=https' --tlsv1.2` con validacion
    normal del certificado; el ejemplo de configuracion apunta a la URL
    publica del panel a traves de Nginx Proxy Manager
    (`https://radius.didev.es`), restringible por IP en el propio NPM.
    `deploy/nginx-radius-panel.conf` mantiene el bloque `location /vpn/`
    (ahora imprescindible: es el unico camino hasta la API para el agente) y
    se ha quitado el `location /pki/` que se habia anadido en el prompt 10
    sin ningun consumidor real (FreeRADIUS lee la cadena de CA/CRL por
    loopback, en la misma maquina).
  - **`trust proxy` como numero de saltos**, corregido en el prompt 10 de
    `1` a `2`, sigue sin comprobar de que direcciones vienen esos saltos —
    cuenta a ciegas. Cambiado a una lista explicita
    (`server/src/lib/trustProxy.ts`: `['loopback', '192.168.10.38']`, la IP
    real de Nginx Proxy Manager): Express solo sigue el `X-Forwarded-For`
    mientras cada salto, de derecha a izquierda, sea una de esas direcciones
    conocidas: en cuanto aparece una que no lo es, esa es la IP real del
    cliente y ahi se para, sin creerse ninguna cabecera que un cliente
    directo (o uno que llegara a saltarse nginx) intentara inventarse.
  - **`Content-Type` de las respuestas binarias de EST llevaba
    `; charset=utf-8`** (`cacerts`, `simpleenroll`, `simplereenroll`):
    Express se lo anade a cualquier Content-Type cuando el cuerpo es un
    string, sin mirar si el tipo es binario — RFC 7030 exige exactamente
    `application/pkcs7-mime; smime-type=certs-only`, sin nada mas. Corregido
    enviando el cuerpo como `Buffer` en vez de `string` (evita esa rama de
    Express por completo); tests con igualdad estricta del header, no solo
    un `match` que habria dejado pasar el sufijo de mas.

- **EST (correccion)**:
  - `GET /.well-known/est/status` validaba unicamente que el certificado
    presentado tuviera una fila `active`, sin comprobar fechas ni la firma
    contra su CA: un certificado autofirmado con el serial de uno legitimo
    pasaba igual. Ahora reutiliza la misma validacion que `simplereenroll`
    (fechas, cadena hasta la CA de su `ca_id`, estado `active` y que el CN
    del propio certificado coincida con el username de su fila), extraida a
    una funcion comun.
  - `simplereenroll` es ahora atomica: localiza y bloquea (`SELECT ... FOR
    UPDATE`) las filas del dispositivo dentro de una transaccion de
    `radiusPool`, y el limite de 12h y la reutilizacion de clave se
    comprueban contra esa lectura bloqueada, no contra una lectura anterior
    sin bloquear. Dos renovaciones concurrentes del mismo dispositivo ya no
    pueden tener exito las dos (antes, una condicion de carrera podia dejar
    dos certificados `active` para el mismo dispositivo).
  - `simpleenroll` valida el CSR (formato, firma, CN) antes de tocar el
    token de alta, y si firmar o insertar el certificado falla despues de
    reclamarlo, el token se libera (`releaseEnrollToken`) para poder
    reintentar sin generar uno nuevo — panel_vpn_enroll_tokens (`radius_panel`)
    y vpn_certificates (`radius`) siguen en pools distintos, asi que no hay
    una unica transaccion SQL que cubra las dos escrituras; esto consigue el
    mismo efecto practico por compensacion. Un dispositivo desconocido y un
    token incorrecto responden ahora con el mismo 401 (el motivo real solo
    queda en la auditoria), para que `simpleenroll` no sirva para averiguar
    que usernames de dispositivo existen.
  - Los dos pools de MySQL (`radiusPool`, `panelPool`) fijan ahora
    `timezone: 'Z'` y `SET time_zone = '+00:00'` en cada conexion nueva, y el
    modulo VPN ya no usa `NOW()` (siempre `UTC_TIMESTAMP()`): sin esto, un
    servidor con el proceso o MySQL en huso horario distinto de UTC escribia
    mal las fechas de `vpn_certificates`/tokens de alta/descargas Android.
    Alcance: como los pools son compartidos por toda la aplicacion, la
    sesion de MySQL pasa a ser UTC tambien para los modulos no-VPN
    (usuarios RADIUS, auditoria, informes).
- **`sql/panel-schema-vpn-4.5.sql` (correccion 8.6)**: en una instalacion
  nueva, `panel-schema-vpn.sql` ya crea `panel_vpn_enroll_tokens` con
  `token_sha256` desde el principio y sin `token_hash` (ese nombre solo
  existio en el esquema anterior a la correccion 4.5), asi que el `UPDATE
  ... SET token_sha256 = token_hash` fallaba con `Unknown column
  'token_hash' in 'WHERE'` en cualquier servidor que nunca tuvo esa
  columna. Ahora comprueba antes en `information_schema.COLUMNS` y solo
  prepara/ejecuta ese `UPDATE` si `token_hash` existe de verdad (si no,
  ejecuta un `SELECT 1` inocuo via `PREPARE`/`EXECUTE`); sigue sin borrar
  nada.

### Cambiado

- Rediseno completo de la interfaz: tarjetas, tablas, graficas y formularios
  unificados; nuevas paginas de error 403 y 404.
- El token de sesion ya no se guarda en `localStorage`.

### Migracion

Antes de arrancar esta version hay que aplicar el nuevo esquema:

```bash
mysql -u root -p radius_panel < sql/panel-schema-security.sql
```

Si vas a activar el login con Google, aplica ademas:

```bash
mysql -u root -p radius_panel < sql/panel-schema-google.sql
```

Y si quieres el email/notas por usuario RADIUS (opcional, se degrada solo sin
romper nada si no la aplicas):

```bash
mysql -u root -p radius_panel < sql/panel-schema-user-meta.sql
```

El servidor comprueba al arrancar la de seguridad (obligatoria) y la de Google
(solo si `GOOGLE_CLIENT_ID` esta configurado); la de email/notas es la unica
que no bloquea el arranque si falta.

### Verificacion

Las tres migraciones se aplicaron y se re-ejecutaron (comprobando idempotencia)
contra una base MariaDB 10.11 real, no solo contra tipos de TypeScript. Tambien
se arranco el servidor completo contra esa base y se probaron en caliente
`/health`, `/api/meta`, `/api/auth/google` con un token invalido (401 controlado)
y un ciclo completo real por HTTP de crear/leer/listar/borrar un usuario RADIUS
con email y notas (`POST` → `GET` → `GET` listado → `DELETE` → `GET` 404),
limpiando despues los datos de prueba. El resto de funcionalidad de escritura
(grupos, NAS...) sigue sin probarse contra la base real de este entorno.
