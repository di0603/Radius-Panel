# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Este proyecto usa versionado semantico.

## [No publicado]

### Anadido

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
