# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Este proyecto usa versionado semantico.

## [No publicado]

### Anadido

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
