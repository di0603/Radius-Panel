# Radius Panel

Dashboard web para administrar un **FreeRADIUS** que usa el modulo `rlm_sql` sobre
**MySQL / MariaDB** (esquema estandar: `radcheck`, `radreply`, `radgroupcheck`,
`radgroupreply`, `radusergroup`, `radacct`, `radpostauth`, `nas`).

- **API**: Node + TypeScript + Express (`server/`)
- **SPA**: React + Vite + Mantine + TanStack Query (`web/`)
- Sin Docker: se conecta a tu MySQL por TCP.

## Funciones

| Area | Que hace |
|------|----------|
| Usuarios | Alta/edicion/baja sobre `radcheck` / `radreply` / `radusergroup`. Contrasena `Cleartext-Password` o `NT-Password`. Activar/desactivar sin borrar. Caducidad (`Expiration`). Editor de atributos con **validacion por diccionario**. **Probar autenticacion** (Access-Request PAP). **Importar** (CSV pegado) y **exportar** CSV. Cortar todas las sesiones del usuario. **Email/notas de contacto** (opcional, tabla propia del panel, no toca RADIUS). |
| Grupos y perfiles | Atributos de grupo (`radgroupcheck` / `radgroupreply`), recuento de miembros, **clonar grupo**. |
| Sesiones | Activas (auto-refresco configurable + pausa) e historial con **paginacion por keyset** desde `radacct`, consumo, **Disconnect-Request (RFC 5176)**, exportacion CSV. |
| NAS | CRUD de la tabla `nas`. Revelar/copiar secret, **probar conectividad** (CoA) y generar el bloque **`clients.conf`**. |
| Reportes | Autenticaciones/dia, trafico/dia, top usuarios, fallos de auth, motivos de cierre, top NAS, usuarios inactivos. |
| Administradores | Cuentas del panel con hash bcrypt, JWT y roles `admin` / `operator`. Aviso de cuenta bloqueada y desbloqueo manual. |
| Seguridad | Access token corto + **refresh token en cookie HttpOnly** (nada en `localStorage`), renovacion silenciosa con deteccion de reuso, **2FA TOTP**, bloqueo tras N intentos, **sesiones del panel revocables** y CSP estricta. |
| Auditoria | Toda escritura del panel queda en `panel_audit_log` (solo rol `admin`). |
| Observabilidad | Logs estructurados con pino, `/health` y metricas Prometheus en `/metrics`. |

## Requisitos

- Node.js >= 20
- MySQL / MariaDB accesible (la base de FreeRADIUS y una base para el panel; pueden
  estar en el mismo servidor).

## Puesta en marcha

### 1. Base de datos

Si **aun no tienes** la base de FreeRADIUS:

```bash
mysql -u root -p < sql/freeradius-schema.sql
```

> Si tu FreeRADIUS ya funciona con SQL, **salta este paso**: el panel usa tus tablas.

Crea las tablas del panel (siempre):

```bash
mysql -u root -p < sql/panel-schema.sql
```

> **Si actualizas desde una version anterior del panel**, aplica ademas la
> ampliacion de seguridad (refresh tokens, bloqueo de cuenta y 2FA). Es
> idempotente y el servidor se niega a arrancar sin ella:
>
> ```bash
> mysql -u root -p radius_panel < sql/panel-schema-security.sql
> ```
>
> Si vas a activar el **login con Google** (opcional, ver mas abajo), aplica
> tambien:
>
> ```bash
> mysql -u root -p radius_panel < sql/panel-schema-google.sql
> ```
>
> Y si quieres poder guardar un **email/notas por usuario RADIUS** (opcional,
> por si hay que escribirles), aplica ademas:
>
> ```bash
> mysql -u root -p radius_panel < sql/panel-schema-user-meta.sql
> ```
>
> Si vas a usar el modulo de **VPN IKEv2/EAP-TLS** (opcional, en desarrollo),
> aplica tambien:
>
> ```bash
> mysql -u root -p radius < sql/radius-schema-vpn.sql
> mysql -u root -p radius_panel < sql/panel-schema-vpn.sql
> mysql -u root -p radius_panel < sql/panel-schema-vpn-pki.sql
> ```
>
> La ultima anade el ciclo de vida de la CA intermedia (generar/importar/CRL,
> pagina "PKI"). Si vas a usarla, define ademas `PKI_MASTER_KEY` en
> `server/.env` (cifra la clave privada de la intermedia; ver `.env.example`).
>
> Para que los dispositivos den de alta y renueven su certificado solos por
> **EST (RFC 7030)**, define `EST_TLS_CERT`/`EST_TLS_KEY` (certificado y clave
> propios del listener EST, un HTTPS aparte de la API en `EST_PORT`, def. 8443,
> porque necesita TLS mutuo real) en `server/.env`; sin ellos el resto del
> panel funciona igual, solo que sin alta/renovacion automatica. Ver
> `.env.example` para el resto de opciones (`EST_ENABLED`, `EST_BIND`).
>
> Para el boton "Emitir certificado" de los dispositivos **Android** (la app
> de strongSwan para Android no sabe renovarse sola por EST, asi que el panel
> genera la clave y la entrega una vez), aplica ademas:
>
> ```bash
> mysql -u root -p radius_panel < sql/panel-schema-vpn-android.sql
> ```
>
> Anade `panel_vpn_settings.lan_cidr` (por defecto `192.168.10.0/24`): el
> enlace de descarga del `.p12` solo funciona desde esa red o desde el rango
> de la VPN, ajustalo si tu LAN usa otro rango.
>
> Para generar el firewall de la VM VPN desde el panel (en vez de editar
> nftables a mano), aplica ademas:
>
> ```bash
> mysql -u root -p radius_panel < sql/panel-schema-vpn-firewall.sql
> ```
>
> Genera el token de la puerta de enlace en "VPN > Ajustes" y configura
> `deploy/vpn-gateway-agent.sh` en la VM VPN (192.168.10.29) -ver la seccion
> de despliegue mas abajo-.

Da permisos a un usuario MySQL sobre ambas bases, por ejemplo:

```sql
CREATE USER 'radpanel'@'%' IDENTIFIED BY 'una-clave';
GRANT ALL PRIVILEGES ON radius.*       TO 'radpanel'@'%';
GRANT ALL PRIVILEGES ON radius_panel.* TO 'radpanel'@'%';
FLUSH PRIVILEGES;
```

### 2. Backend

```bash
cd server
cp .env.example .env        # edita credenciales de MySQL y JWT_SECRET
npm install
npm run seed:admin          # crea el primer administrador (rol admin)
npm run dev                  # API en http://localhost:4000
```

### 3. Frontend

```bash
cd web
npm install
npm run dev                  # SPA en http://localhost:5173 (proxy /api -> :4000)
```

O ambos a la vez desde la raiz:

```bash
npm run install:all
npm run dev
```

### 4. (Opcional) Datos de demostracion

Para probar el panel sin un FreeRADIUS real (usuarios, grupos, NAS y 90 dias de
accounting/postauth de mentira):

```bash
npm run seed:demo            # aborta si ya hay usuarios
npm run seed:demo -- --force # insertar igualmente
```

## Scripts (desde la raiz)

| Script | Que hace |
|--------|----------|
| `npm run dev` | API + SPA con recarga en caliente |
| `npm run build` | Compila `server/` y `web/` |
| `npm test` | Tests del backend (`node:test`) |
| `npm run typecheck` | `tsc --noEmit` en server y web |
| `npm run format` / `format:check` | Prettier |
| `npm run seed:admin` | Crea el primer administrador |
| `npm run seed:demo` | Carga datos de demostracion |
| `npm run menu` | Menu interactivo de administracion |
| `npm run vpn:jobs` | Mantenimiento periodico del modulo VPN (superseded -> revoked, poda de la CRL, tokens caducados, regenerar CRL); en produccion lo dispara `radius-panel-vpn-jobs.timer` cada 15 min |

## Menu de administracion

```bash
npm run menu          # (desde la raiz)  -> menu interactivo por consola
```

Opciones:

- **Esquema / migraciones** — aplicar `sql/panel-schema.sql`, `sql/freeradius-schema.sql`,
  `sql/panel-schema-security.sql` (refresh tokens, 2FA, bloqueo), `sql/panel-schema-google.sql`
  (login con Google), `sql/panel-schema-user-meta.sql` (email/notas por usuario RADIUS) o
  `sql/radius-schema-vpn.sql` / `sql/panel-schema-vpn.sql` / `sql/panel-schema-vpn-pki.sql`
  (modulo VPN y su CA intermedia) contra tu MySQL sin salir del proceso; ver que tablas existen en
  cada base y el estado de cada migracion.
- **Administradores del panel** — listar, crear, cambiar contrasena, activar/desactivar.
- **Usuarios RADIUS** — listar (con filtro), crear (usuario + contrasena + tipo + grupo), borrar.
- **Registros y diagnostico** — ultimas autenticaciones (`radpostauth`), sesiones activas
  (`radacct`), ultimas acciones de auditoria del panel, y test de conexion a las dos bases.
- **Ejecutar tests** — lanza `npm test` del backend.

Usa el mismo `server/.env`, asi que configuralo antes.

## Tests

```bash
npm test              # (desde la raiz)  -> tests del backend (node:test + tsx)
```

## Variables de entorno (server/.env)

| Variable | Descripcion |
|----------|-------------|
| `PORT` | Puerto de la API (def. 4000). |
| `CORS_ORIGIN` | Origen permitido (la SPA). En dev con el proxy de Vite no hace falta tocarlo. Debe ser exacto: el panel usa cookies con credenciales. |
| `JWT_SECRET` | **Obligatorio.** Secreto para firmar los tokens y cifrar los secretos TOTP. Minimo 16 caracteres. |
| `ACCESS_TOKEN_TTL` | Vida del access token, corta a proposito (def. `15m`). Se renueva solo via refresh token. |
| `REFRESH_TOKEN_DAYS` | Dias que dura la sesion sin volver a escribir la contrasena (def. `7`). |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCK_MINUTES` | Intentos fallidos antes de bloquear la cuenta, y minutos de bloqueo. |
| `GOOGLE_ENABLED` | `false` apaga el login con Google sin tener que borrar las credenciales (def. `true`). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Opcionales: activan el boton "Iniciar sesion con Google". Ver la seccion dedicada mas abajo. |
| `RADIUS_DB_*` | Conexion a la base de FreeRADIUS. |
| `PANEL_DB_*` | Conexion a la base del panel. |
| `COA_ENABLED` | `false` desactiva el boton "Desconectar". |
| `COA_PORT` | Puerto CoA/Disconnect del NAS (def. 3799). |
| `COA_TIMEOUT_MS` | Espera de respuesta del NAS (def. 3000). |
| `RADIUS_TEST_ENABLED` | `false` desactiva el boton "Probar" autenticacion. |
| `RADIUS_AUTH_HOST` / `RADIUS_AUTH_PORT` | FreeRADIUS al que enviar el Access-Request de prueba (def. `127.0.0.1:1812`). |
| `RADIUS_AUTH_SECRET` | Secret con el que el panel figura como cliente en FreeRADIUS (def. `testing123`). |
| `SEED_ADMIN_USER` / `SEED_ADMIN_PASSWORD` | Si se definen, `seed:admin` no pregunta. |

## Probar la autenticacion de un usuario

El boton **Probar** de la tabla de usuarios envia un `Access-Request` (PAP) al
FreeRADIUS indicado en `RADIUS_AUTH_*` y muestra `Access-Accept` / `Access-Reject`
con los atributos de respuesta. Para que funcione, el panel debe estar dado de alta
como cliente en FreeRADIUS con el mismo `RADIUS_AUTH_SECRET`.

## Desconexion de sesiones (CoA)

El boton "Desconectar" de **Sesiones > Activas** envia un `Disconnect-Request`
(RFC 5176) por UDP directamente desde la API — no necesita `radclient`. El `secret`
se toma de la tabla `nas` buscando por la IP del NAS de la sesion, asi que:

- el NAS debe estar dado de alta en **NAS / clientes** con su `secret` real, y
- el NAS debe aceptar CoA en `COA_PORT` desde la IP de la API.

Si no hay NAS registrado con esa IP, el panel lo indica y no envia nada.

## Login con Google (opcional)

Alternativa al usuario/contrasena para los administradores del panel — no crea
cuentas nuevas, solo permite entrar con una cuenta de Google ya vinculada a un
administrador existente.

1. Aplica `sql/panel-schema-google.sql` (ver "Puesta en marcha" arriba).
2. En [Google Cloud Console](https://console.cloud.google.com/): crea un proyecto,
   configura la pantalla de consentimiento OAuth (en modo *Testing* basta, sin
   verificacion) y crea unas credenciales **OAuth client ID** de tipo *Web
   application*. En **Authorized JavaScript origins** pon la URL donde sirvas el
   panel (`http://localhost:5173` en desarrollo); **Authorized redirect URIs**
   se deja vacio, este flujo no lo usa.
3. Copia el **Client ID** y el **Client secret** a:
   - `server/.env`: `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`.
   - `web/.env`: `VITE_GOOGLE_CLIENT_ID` (el mismo Client ID; es publico, no el secret).
4. Cada administrador vincula su cuenta desde **Mi cuenta y seguridad** →
   "Iniciar sesion con Google": guarda su email y, la primera vez que entra con
   ese email de Google, el panel lo vincula automaticamente (por `google_sub`,
   no por el email, asi que reciclar el email despues no rompe el vinculo).

Si `GOOGLE_CLIENT_ID` no esta definido en `server/.env`, el boton no aparece y
el endpoint `/api/auth/google` responde 400. Para apagarlo temporalmente sin
borrar las credenciales, pon `GOOGLE_ENABLED=false` y reinicia el servidor.

## VPN y certificados (IKEv2 / EAP-TLS)

Modulo opcional: el panel actua como CA emisora de certificados de dispositivo
para una VPN IKEv2 con autenticacion EAP-TLS, con alta y renovacion automatica
por **EST (RFC 7030)**. Todas las operaciones de PKI y de dispositivos VPN son
solo para el rol `admin`.

### Arquitectura

```
dispositivo (Windows/Linux/Android)
   │  IKEv2 / EAP-TLS
   ▼
strongSwan (192.168.10.29) ──EAP──► FreeRADIUS (192.168.10.28, virtual server
                                     "vpn", modulo eap_vpn, solo TLS)
                                        │
                                        ├─► MariaDB (192.168.10.30): vpn_certificates,
                                        │   radcheck/radreply/radusergroup (rlm_sql)
                                        │
                            Radius Panel + su propia API (tambien en .28):
                              - CA intermedia (panel_pki_ca) firma los
                                certificados de dispositivo por EST
                              - CA raiz: offline, el panel nunca tiene su clave
```

- Cada dispositivo es un **usuario RADIUS** cuyo username es el CN de su
  certificado (`vpn-<owner_user>-<device_label>`), con IP fija
  (`Framed-IP-Address`) del rango `pool_start`-`pool_end` (por defecto
  `192.168.10.75`-`192.168.10.99`) y grupo `vpn`.
- FreeRADIUS valida la cadena hasta la raiz offline, la CRL de la intermedia y
  que el serial este `active` en `radius.vpn_certificates` — eso es
  configuracion de FreeRADIUS (fuera de este repo); el panel solo publica esa
  informacion (`GET /pki/ca-chain.pem`, `GET /pki/crl.pem`, sin autenticacion,
  igual que cualquier CA publica su cadena y su CRL).
- La WiFi sigue con PEAP-MSCHAPv2 sobre el mismo FreeRADIUS: nada de este
  modulo la afecta.
- Hay un dispositivo de prueba `vps` (192.168.10.77) con un certificado firmado
  a mano directamente por la raiz, de cuando todavia no existia la CA
  intermedia: se retira cuando la CA intermedia real este en produccion.

### Paginas del panel

| Pagina | Que hace |
|--------|----------|
| **PKI** | Genera la clave+CSR de la CA intermedia (ECDSA P-384), importa el certificado firmado offline por la raiz, rotacion y CRL. |
| **VPN > Dispositivos** | Alta/baja, activar/desactivar, revocar certificado, token de alta EST, paquete de conexion descargable, permisos de red (firewall) por dispositivo. |
| **VPN > Perfiles de acceso** | Rango de IPs de cada perfil de acceso, lista de destinos de los perfiles restringidos y descarga de `vpn-profiles.nft`. |
| **VPN > Ajustes** | Token de la puerta de enlace del firewall (`deploy/vpn-gateway-agent.sh`). El resto de ajustes (`panel_vpn_settings`: FQDN, identidad AAA, rango de IPs, dias de vigencia/renovacion, URL de EST, red LAN) todavia se editan solo por SQL/`npm run menu`, sin pagina propia. |

### Variables de entorno (server/.env)

| Variable | Descripcion |
|----------|-------------|
| `PKI_MASTER_KEY` | Cifra la clave privada de la CA intermedia (`panel_pki_ca.private_key_encrypted`). Minimo 32 caracteres, aleatorio. Sin ella el panel arranca igual, pero generar/usar la CA intermedia falla con un mensaje claro. **Si la cambias despues de generar una CA intermedia, esa clave privada deja de poder descifrarse: no hay forma de recuperarla** (ver "Copias de seguridad" en `SECURITY.md`). |
| `EST_ENABLED` | `false` apaga el listener EST aunque haya certificado/clave configurados (def. `true`). |
| `EST_PORT` / `EST_BIND` | Puerto/IP del listener HTTPS de EST (def. `8443` / `0.0.0.0`). Servidor separado de la API principal: necesita TLS mutuo real (`requestCert: true`), que un proxy que termina TLS (nginx) no puede reenviar. |
| `EST_TLS_CERT` / `EST_TLS_KEY` | Certificado y clave propios del listener EST, para el nombre publico de la PKI (p.ej. `pki.vlc.didev.es`). Los firma la CA raiz offline (EKU `serverAuth`, SAN DNS = ese nombre), **no** Let's Encrypt: los dispositivos confian solo en esa raiz para esta conexion. Sin estas dos, el resto del panel funciona igual, solo que sin alta/renovacion automatica. |
| `VPN_PROFILE_SIGNING_KEY` | Ruta a la clave privada Ed25519 (PEM, permisos 600) que firma el perfil de aprovisionamiento (`.didevvpn`) de cada token de alta. La clave publica va incrustada en las apps (Windows/Android), para que una app nunca acepte un perfil de otro origen. Sin ella, "Generar token de alta" sigue funcionando igual pero sin perfil firmado ni QR (alta manual con el token por EST). Ver "Aprovisionamiento de apps" mas abajo para como generarla. |
| `VPN_DHCP_START` / `VPN_DHCP_END` | Opcionales, van juntas. Rango DHCP del router: el panel rechaza que el rango de IPs de un perfil de acceso VPN lo pise. Vacias = sin esa comprobacion. |
| `VPN_EGRESS_IFACE` | Opcional. Interfaz de salida a Internet de la VM VPN (p.ej. `eth0`). Si se define, las reglas "internet" del `vpn-profiles.nft` generado tambien exigen `oifname`. |

Ver `.env.example` para el resto (comentarios inline).

### Migraciones

Todas idempotentes, en `sql/`, aplicables desde `npm run menu` → **Esquema /
migraciones** (opciones entre parentesis) o a mano con `mysql -u root -p
<base> < sql/<fichero>`, en este orden:

| # | Fichero | Base | Que anade |
|---|---------|------|-----------|
| 6 | `radius-schema-vpn.sql` | `radius` | Tabla `vpn_certificates`. |
| 7 | `panel-schema-vpn.sql` | `radius_panel` | `panel_vpn_devices`, `panel_vpn_enroll_tokens`, `panel_pki_ca`, `panel_vpn_settings`. |
| 8 | `panel-schema-vpn-pki.sql` | `radius_panel` | Esquema correcto de `panel_pki_ca` (si el modulo se probo antes de fijar el modelo de `CLAUDE.md`). |
| 9 | `panel-schema-vpn-devices.sql` | `radius_panel` | Esquema correcto de `panel_vpn_devices` (idem). |
| 10 | `radius-schema-vpn-issuer.sql` | `radius` | `vpn_certificates.ca_id` (enlaza cada certificado con la CA que lo firmo, para que revocar regenere la CRL correcta). |
| 11 | `panel-schema-vpn-4.5.sql` | `radius_panel` | `panel_vpn_settings.aaa_id`/`est_url`, `panel_vpn_enroll_tokens.token_sha256`. |
| 12 | `panel-schema-vpn-android.sql` | `radius_panel` | `panel_vpn_settings.lan_cidr`, tabla `panel_vpn_android_downloads` (boton "Emitir certificado" para Android). |
| 13 | `panel-schema-vpn-firewall.sql` | `radius_panel` | `allow_radius_host`/`allow_mariadb_host`, tabla `panel_vpn_device_rules`, `panel_vpn_settings.gateway_token_sha256` (firewall de la VM VPN). |
| 24 | `panel-schema-vpn-provisioning.sql` | `radius_panel` | `panel_vpn_settings.min_app_version` (version minima de app, publicada por `GET /.well-known/est/status`). |
| 26 | `panel-schema-vpn-profiles.sql` | `radius_panel` | `panel_vpn_devices.access_profile` (existentes = `internet_lan_full`), `panel_vpn_profile_ranges`, `panel_vpn_restricted_destinations` (perfiles de acceso por dispositivo). |

`npm run menu` te dice cuales faltan contra tu base real (no solo si la tabla
existe: tambien si tiene ya las columnas de la version actual). La migracion
24 aparece con ese numero (no 14) porque se anadio despues de que el 14-23 ya
estuviera reservado para los "Estado de..."; el propio menu la lista igual.

### Puesta en marcha de la CA intermedia

La raiz es **offline**: el panel nunca tiene su clave privada. El flujo es
generar la peticion en el panel, firmarla a mano en la maquina donde vive la
raiz, e importar el resultado.

1. **Panel → PKI → "Generar CA intermedia"**: pide un `subjectCn` (p.ej. `CN
   VPN Casa Intermedia 2026`) y genera la clave ECDSA P-384 (queda cifrada con
   `PKI_MASTER_KEY`) y descarga el CSR (`csr.pem`).
2. **En la maquina offline de la raiz**, firma el CSR como intermedia
   (`BasicConstraints CA:true, pathLenConstraint=0`, `KeyUsage
   keyCertSign,cRLSign`, `ExtendedKeyUsage clientAuth`, ECDSA P-384/SHA-384),
   por ejemplo:
   ```bash
   openssl ca -config raiz.cnf -extensions v3_intermediate_ca \
     -days 1825 -notext -md sha384 \
     -in csr.pem -out intermedia.pem
   ```
   (Ajusta `raiz.cnf`/`v3_intermediate_ca` a tu propia CA raiz; lo que
   importa es que el certificado resultante cumpla exactamente esas
   extensiones — el panel rechaza la importacion si no.)
3. **Panel → PKI → "Importar certificado"**: sube `intermedia.pem` (el
   certificado firmado) y `raiz.pem` (el certificado de la raiz, autofirmado).
   El panel comprueba firma, vigencia, extensiones y que la clave publica
   corresponda al CSR generado en el paso 1; si hay una intermedia activa
   previa, pasa a "retirandose" (sigue publicando CRL hasta que caduca, pero
   deja de firmar certificados nuevos).
4. Verifica que `GET /pki/ca-chain.pem` y `GET /pki/crl.pem` responden
   (sin autenticacion; en la propia maquina del panel:
   `curl http://127.0.0.1:1003/pki/ca-chain.pem`).
5. Configura FreeRADIUS (fuera de este repo) para validar contra esa cadena y
   esa CRL, y para consultar `radius.vpn_certificates` (`status = 'active'`)
   en el virtual server `vpn`.

### Alta de un dispositivo

1. **Panel → VPN > Dispositivos → "Nuevo dispositivo"**: `ownerUser` +
   `deviceLabel` (minusculas/numeros/guiones) forman el username
   `vpn-<ownerUser>-<deviceLabel>`; elige la plataforma. El panel asigna la
   primera IP libre del pool, crea el usuario RADIUS (`radcheck`, `radreply`,
   `radusergroup`) y la ficha del panel en una sola operacion.
2. **Genera un token de alta** (ficha del dispositivo → "Generar token de
   alta"): un solo uso, valido 24h, se ensena una unica vez. Si
   `VPN_PROFILE_SIGNING_KEY` esta configurada (ver "Aprovisionamiento de
   apps" mas abajo), el panel construye ademas, con ese mismo token
   embebido, un perfil de aprovisionamiento firmado (`.didevvpn`) para las
   apps propias de Windows/Android: se muestra como fichero descargable y
   como codigo QR, tambien una unica vez y con la misma caducidad de 24h.
   **El alta inicial exige estar en la red local o la WiFi de casa**: el
   listener EST no esta expuesto a internet.
3. Segun la plataforma:
   - **Windows / Linux**: descarga el "Paquete de conexion" desde la ficha
     del dispositivo (botón "Descargar paquete de conexion"). El zip/tar.gz
     no lleva ninguna clave ni el token; trae los scripts de instalacion y
     alta (`install.ps1`+`enroll.ps1` en Windows, `vpn-enroll` en Linux) que
     piden el token por pantalla, generan la clave en el equipo (TPM si lo
     hay, en Windows) y piden el primer certificado por `simpleenroll`.
     Tambien instalan la renovacion automatica (`renew.ps1` / `vpn-renew` +
     systemd timer) que usa `GET status` de EST para saber cuando toca.
   - **Android**: la app de strongSwan para Android no sabe renovarse sola
     por EST, asi que en su lugar pulsa "Emitir certificado" en la ficha del
     dispositivo. El panel genera la clave, construye un `.p12` protegido con
     una contrasena aleatoria (se ensena una unica vez) y da un enlace de
     descarga de un solo uso (15 minutos, solo accesible desde la VPN o la
     LAN configurada) que entrega un perfil `.sswan` para importar en la app.
     Repite este paso cuando toque renovar (no hay renovacion automatica para
     Android).
4. Revisa **VPN > Dispositivos** (o la tarjeta "VPN" del panel) para ver el
   estado de cada certificado y las alertas de renovaciones atascadas.

### Aprovisionamiento de apps (Windows/Android)

Las apps propias (`didev-vpn-windows` y su equivalente de Android, en
desarrollo aparte) son clientes **genericos**, como FortiClient: se
compilan sin ninguna clave ni certificado de didev incrustados, y pueden
gestionar varias conexiones/servidores distintos. Cada una se configura
importando el perfil `.didevvpn` firmado que genera el paso 2 de "Alta de un
dispositivo". El panel firma ese perfil con una clave Ed25519 — la clave
privada **no la genera el codigo**, es un paso manual, una unica vez — pero,
a diferencia de antes del prompt 12.5, la clave publica correspondiente **no
va incrustada en la app**: viaja dentro del propio sobre (`signerPublicKey`)
y la app la aprende y la fija la primera vez que ve cada servidor
("confianza en el primer uso", TOFU — ver mas abajo).

1. En la `.28`, como root, en un directorio fuera del arbol de git (para que
   el autodeploy nunca lo toque ni lo sobrescriba):
   ```bash
   mkdir -p /etc/radius-panel/keys
   umask 077
   openssl genpkey -algorithm ED25519 -out /etc/radius-panel/keys/vpn-profile-signing-ed25519.pem
   chmod 600 /etc/radius-panel/keys/vpn-profile-signing-ed25519.pem
   chown root:root /etc/radius-panel/keys/vpn-profile-signing-ed25519.pem
   ```
   `openssl genpkey` escribe la clave privada directamente al fichero: nunca
   pasa por la salida estandar, así que no puede acabar en el historial de la
   shell ni en ningun log por este comando.
2. Anade en `server/.env`:
   ```
   VPN_PROFILE_SIGNING_KEY=/etc/radius-panel/keys/vpn-profile-signing-ed25519.pem
   ```
   y reinicia el panel. Sin este paso, "Generar token de alta" sigue
   funcionando igual, solo que sin perfil firmado ni QR.
3. Nada que extraer a mano: el panel calcula la clave publica y su huella
   (`GET /vpn-settings`, ver "Huellas de confianza" abajo) el mismo cada
   vez que hace falta, con `getSignerPublicKeySha256Hex()`
   (`server/src/lib/vpnProfileSigning.ts`); las apps la reciben dentro del
   sobre firmado, nunca hay que pegarla en ningun sitio.
4. Aplica la migracion 24 (`panel-schema-vpn-provisioning.sql`) si no lo has
   hecho ya, para que `panel_vpn_settings.min_app_version` exista: `GET
   /.well-known/est/status` la publica en cada respuesta (junto al resto del
   estado del certificado) para que las apps puedan bloquear el alta y la
   renovacion si van por debajo de esa version.

**Formato del perfil**: un sobre `{ payload, signature, keyId, signerPublicKey }`
donde `payload` es el base64url de los bytes UTF-8 **exactos** de un JSON
(nunca se re-serializa para verificar, para que comprobar la firma no
dependa de reproducir bit a bit el mismo formateo en otro lenguaje/libreria),
`signature` es la firma Ed25519 (node:crypto, `sign(null, bytes, key)`) sobre
esos mismos bytes, y `signerPublicKey` es la clave publica del panel (SPKI
DER, base64url) que verifica esa firma. `signerPublicKey` va **fuera** del
payload firmado a proposito (es informacion publica sobre quien firmo, no
parte de lo firmado), pero el payload lleva su huella (`signerKeySha256`,
ver abajo) para que no se pueda sustituir sin invalidar la firma.

El JSON firmado lleva `version`, `variant` (`"full"` o `"qr"`, ver abajo),
`cn` (username del dispositivo), `server` (`vpn_fqdn`), `aaaId`,
`rootCaSha256` (SHA-256 en hex del DER de la raiz offline — **presente en las
dos variantes**), `signerKeySha256` (SHA-256 en hex del SPKI DER de
`signerPublicKey`, tambien presente en las dos variantes — liga esa clave al
payload firmado), `ike`/`esp` (propuestas, sintaxis strongSwan), `tunnelMode`,
`splitRoutes` (vacio en modo `full`), `dns`, `estBaseUrl`, `enrollToken` (el
token de alta: el unico campo realmente secreto de todo el perfil) e
`issuedAt`/`expiresAt`.

**Dos variantes, firmadas por separado** (cada una con su propio sobre, y por
tanto su propia firma — no es el mismo JSON reetiquetado):

- **`"full"`** (fichero `.didevvpn` descargable): ademas de lo anterior, lleva
  `caChainPem` con la cadena de CA completa (raiz + intermedia). Con una
  raiz+intermedia reales (ECDSA P-384) esto son ~2800 caracteres.
- **`"qr"`** (codigo QR, nivel de correccion M): **sin** `caChainPem`. Meter
  la cadena completa en el QR lo deja en una version ~39 (con nivel L, que es
  menos robusto) — casi imposible de escanear desde una pantalla, y con
  nombres un poco mas largos dejaria de caber sin avisar. La variante `qr`
  (con `signerPublicKey`/`signerKeySha256` desde el prompt 12.5) sale en
  torno a la version 27 con nombres normales — sigue siendo razonablemente
  escaneable, aunque ya no tan holgada como antes de anadir esos dos campos.

### Confianza en el primer uso (TOFU) — obligatorio para toda app que consuma este perfil

Desde que las apps son clientes genericos sin clave de didev incrustada, la
app **aprende** la identidad del panel la primera vez que importa un perfil
de un servidor, y a partir de ahi la exige exactamente igual:

1. **Primera importacion de un servidor** (la app no tiene ningun ancla
   guardada para el `server`/`aaaId` de este perfil): verificar la firma con
   la `signerPublicKey` que trae el PROPIO sobre, comprobar que
   `signerKeySha256` del payload es el SHA-256 exacto de esa
   `signerPublicKey` (si no coincide, el sobre es incoherente: rechazar sin
   preguntar nada, no es una decision del usuario), comprobar `variant`,
   version de esquema, caducidad, y que la raiz de `caChainPem` (o la que
   devuelva `GET cacerts` en la variante `qr`, ver el contrato de abajo)
   tiene exactamente `rootCaSha256`. Solo si todo eso pasa, mostrar una
   pantalla de confirmacion con el nombre del servidor y las dos huellas
   (`signerKeySha256` y `rootCaSha256`, ver "Huellas de confianza" mas
   abajo) y un texto explicito pidiendo comparar contra lo que muestra el
   panel. Solo si el usuario confirma, guardar el ancla de confianza
   (`signerKeySha256` + `rootCaSha256` para ese servidor) y continuar con el
   alta.
2. **Importaciones y renovaciones posteriores del mismo servidor**: el
   perfil tiene que verificar igual que en el paso 1, Y su
   `signerKeySha256`/`rootCaSha256` tienen que coincidir **exactamente** con
   el ancla ya guardada. Si no coinciden, rechazar con un error claro ("la
   identidad de este servidor ha cambiado") **sin ofrecer aceptar desde ese
   dialogo** — cambiar de ancla exige un paso deliberado aparte (quitar la
   conexion y volver a anadirla), nunca un simple "aceptar de todas formas"
   en el flujo normal.
3. El TLS de EST (`simpleenroll`/`simplereenroll`/`status`) se valida
   siempre contra la raiz del ANCLA guardada, nunca contra la que traiga un
   perfil nuevo hasta que ese perfil pase el paso 2.

### Huellas de confianza (para comparar a ojo)

El panel muestra dos huellas SHA-256 — la de su propia clave de firma
(`signerKeySha256`) y la de la raiz offline (`rootCaSha256`) — en dos
sitios: junto al QR/fichero al generar un token de alta, y en **VPN >
Ajustes** (para volver a consultarlas sin generar un token nuevo). Formato
(`server/src/lib/fingerprint.ts`, `GET /vpn-settings` y la respuesta de
`POST /vpn-devices/:username/enroll-token`): grupos de 4 caracteres
hexadecimales en MAYUSCULAS (`"ABCD EF01 ..."`), completos, mas un "codigo
corto" = los primeros 8 grupos (32 caracteres) para comparar de un vistazo
sin leer los 64 caracteres enteros. Quien da de alta un dispositivo debe
poder pasarle estas huellas (de palabra, por otro canal, o ensenandole la
pantalla) a quien esta confirmando la pantalla de TOFU de la app.

**Contrato para quien consuma la variante `qr`** (obligatorio para los
prompts 12 — Windows — y 13 — Android —, ya que esa variante no trae la
cadena de CA):

1. Nada mas escanear el QR, sin validar todavia el TLS de EST, la app hace
   `GET /.well-known/est/cacerts` (paso inicial de RFC 7030 §4.1.1: esta
   primera peticion no puede autenticar el servidor via TLS porque la app
   todavia no tiene ninguna raiz en la que confiar) y extrae el certificado
   raiz del PKCS7 "certs-only" que devuelve.
2. La app calcula el SHA-256 del DER de esa raiz recibida y **solo la acepta
   si coincide exactamente con `rootCaSha256`** del perfil escaneado. Si no
   coincide, se rechaza el alta entera — no hay margen para "confiar de
   todas formas".
3. Solo entonces esa raiz (ya verificada por su huella) se usa para validar
   de verdad el TLS del listener EST en las peticiones siguientes, y para
   validar que la intermedia que EST presente en la cadena cuelga de ella.
   A partir de aqui el flujo es el mismo que con la variante `full` (la app
   nunca necesita el `.didevvpn` si entro por QR).

La variante `full` no necesita nada de esto porque ya trae la cadena
completa firmada — pero tambien lleva `rootCaSha256`, por si una
implementacion prefiere verificar igual antes de confiar en el `caChainPem`
del propio fichero.

### Perfiles de acceso por dispositivo (prompt 12.14)

Cada dispositivo VPN tiene un **perfil de acceso** que decide a que llega por
el tunel, y la VM VPN (192.168.10.29) lo impone con nftables:

| Perfil | Internet por el tunel | LAN 192.168.10.0/24 |
|--------|-----------------------|---------------------|
| `lan_restricted` | no | solo los destinos/puertos de la lista restringida |
| `lan_full` | no | **toda** (incluidas .28, .29 y .30, todos los puertos) |
| `internet_only` (por defecto en altas nuevas) | si | no |
| `internet_lan_restricted` | si | solo la lista restringida |
| `internet_lan_full` | si | **toda** (incluidas .28, .29 y .30) |

`lan_full` e `internet_lan_full` dan acceso a infraestructura (CA, RADIUS y BD):
el panel lo avisa en rojo al elegirlos. Los dispositivos que ya existian se
quedan en `internet_lan_full` (su comportamiento de antes).

- **Rangos de IP por perfil** (VPN > Perfiles de acceso): la IP fija
  (`Framed-IP-Address`) de un dispositivo sale del rango de su perfil. El panel
  rechaza rangos fuera de la LAN, solapados entre perfiles, que incluyan
  .28/.29/.30, que pisen el DHCP del router (`VPN_DHCP_START`/`VPN_DHCP_END`) o
  que dejen fuera la IP de un dispositivo existente. Rango lleno o sin
  configurar: el alta falla con un mensaje claro (nunca se usa otro rango). La
  migracion deja el rango `192.168.10.75-99` en `internet_lan_full`; los demas
  perfiles empiezan **sin rango** hasta que un admin los define.
- **Lista restringida**: una unica lista global para los dos perfiles
  restringidos (destino IPv4/CIDR dentro de la LAN, `tcp`/`udp`/`icmp`, puertos,
  comentario). Cada campo se valida con formatos cerrados; nada de texto libre
  llega a una regla nft.
- **Cambiar el perfil** de un dispositivo (ficha del dispositivo): reasigna la
  IP del rango nuevo y desconecta la sesion activa con el Disconnect de siempre
  (CoA, puerto 3799). Si no se puede desconectar, el panel avisa de que aplica
  en la proxima conexion.
- Todo cambio (perfil, rangos, lista) se registra en auditoria con quien y el
  antes/despues. Solo rol `admin`.

**Como se imponen los perfiles en la .29.** En la .29 solo existe la tabla
`inet filter` (policy drop en input y forward) y un `accept` en otra tabla no
anula ese drop, asi que los perfiles viven DENTRO de `inet filter`, en dos
piezas:

1. **Fragmento de `/etc/nftables.conf`** (panel → VPN > Perfiles de acceso →
   *Fragmento de nftables.conf*; se revisa e integra a mano **una sola vez** y
   no cambia con los rangos): declara siete sets **vacios** (uno `interval
   ipv4_addr` por perfil, `vpn_restricted_dests` de tipo `ipv4_addr .
   inet_proto . inet_service` y `vpn_restricted_icmp`) y las reglas **fijas** de
   forward e input que los usan: EST 8443 hacia la .28 para todos;
   `lan_full`/`internet_lan_full` → `ip daddr 192.168.10.0/24 accept` (incluye
   .28, .29 y .30) y accept en input hacia la .29; perfiles con Internet →
   `ip daddr != redes privadas accept`; restringidos → accept solo si
   (destino, protocolo, puerto) esta en el set. **Falla cerrando**: con los
   sets vacios no se acepta nada de la VPN. En `chain forward` hay que
   **eliminar dos lineas actuales** (el drop de los clientes VPN a .28/.30 y el
   accept generico de toda la LAN); IKE, 3799 desde la .28, SSH solo desde la LAN
   fisica y el MSS clamp se quedan como estan. Termina con
   `include "/etc/nftables.d/vpn-profiles.nft"` para que los sets se rellenen
   tras un reinicio. Requiere nft >= 0.9.4 y kernel >= 5.6 (sets de intervalos
   concatenados).
2. **`vpn-profiles.nft`** (boton *Descargar vpn-profiles.nft*): SOLO
   `flush set` + `add element` de esos sets, en una carga atomica. Es lo que
   cambia con los rangos y la lista. El panel no lo aplica: lo haces tu con
   `deploy/vpn-gateway-apply-profiles.sh` en la .29 (como root):
   `... --check-only vpn-profiles.nft` y despues `... vpn-profiles.nft`. El
   script rechaza cualquier linea que no sea `flush set`/`add element` sobre los
   sets `vpn_*` (adios a `flush ruleset`, tablas, cadenas o reglas), comprueba
   que los sets **existen** en `inet filter` (si no, aborta con un mensaje claro),
   hace copia de seguridad, `nft -c -f`, carga atomica y **si no escribes
   `CONFIRMAR` en 60 s (o se te cae el SSH), restaura los sets solo**.

La lista restringida no admite entradas que se solapen (mismo protocolo +
destinos que se pisan + puertos que se pisan): un set de intervalos las
rechazaria. ICMP va en un set aparte porque `th dport` en un paquete ICMP lee el
checksum, no un puerto.

Reversion manual tras confirmar: `nft -f /var/backups/vpn-gateway/revert-vpn-profiles.<fecha>.nft`
(estado anterior de los sets) y restaurar `vpn-profiles.nft.installed.<fecha>`
en `/etc/nftables.d/`. Para quitar los perfiles del todo, deshacer los cambios
de `nftables.conf` desde su copia de seguridad.

Pruebas con nft real (sin tocar la maquina, en un netns de usuario):
`NFT_FUNCTIONAL=1 npm test` (solo Linux) o a mano,
`node --import tsx server/src/scripts/exportNftExamples.ts /tmp/nft` y
`unshare -rn bash deploy/test-vpn-profiles-netns.sh /tmp/nft` (veredicto de
cada perfil hacia .28/.29/.30, otra IP de la LAN e Internet) y
`unshare -rn bash deploy/test-apply-profiles-netns.sh /tmp/nft` (el script de
aplicacion).

### Firewall de la puerta de enlace VPN (192.168.10.29)

El panel genera el fichero nftables completo (`GET /vpn/gateway/firewall.nft`,
tabla `inet vpn_clients`) a partir de los permisos de red de cada dispositivo:

- **"internet"**: acceso a cualquier destino salvo las redes privadas
  (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), CGNAT (`100.64.0.0/10`) y
  link-local (`169.254.0.0/16`) — para eso esta el permiso "toda la LAN"
  aparte, sin mezclarlo con "internet".
- **"toda la LAN"**: el `lan_cidr` configurado (`panel_vpn_settings`).
- **Destino concreto**: IP/CIDR y, opcionalmente, protocolo/puerto.

RADIUS (`192.168.10.28`) y MariaDB (`192.168.10.30`) quedan siempre
bloqueados para los clientes VPN, salvo excepcion explicita por dispositivo.
El fichero es idempotente (borra y vuelve a definir la tabla en la misma
ejecucion de `nft -f`, para que el timer de 5 minutos no vaya acumulando
reglas) y su cadena `forward` solo decide sobre trafico que toca el pool de
IPs de la VPN — el resto del trafico de esa maquina (p.ej. lo que ya
gestione `/etc/nftables.conf`) se acepta sin mirarlo y sigue evaluandose por
su cuenta en sus propias tablas.

1. **Panel → VPN > Ajustes → "Generar token de la puerta de enlace"**: se
   ensena una unica vez.
2. En la VM VPN (192.168.10.29), instala `deploy/vpn-gateway-agent.sh` (ver
   "Deploy automatico en el VPS" mas abajo) y su configuracion
   (`deploy/vpn-gateway-agent.config.sh.example`): **`PANEL_URL` tiene que
   ser la URL publica del panel por HTTPS** (p.ej. `https://radius.didev.es`,
   a traves de Nginx Proxy Manager — el agente se niega a arrancar si no
   empieza por `https://`, porque el token de la puerta de enlace viaja en
   la cabecera `Authorization` y no debe salir en claro por HTTP), no la
   LAN directa a la API ni `EST_PORT`/8443 (ese es un servidor HTTPS
   distinto que solo entiende `/.well-known/est/*`). `GATEWAY_TOKEN` es el
   token del paso 1. En NPM, restringe esa URL publica a la IP de casa.
3. El timer systemd (`vpn-gateway-agent.timer`, cada 5 min) descarga el
   fichero, lo valida con `nft -c -f` y solo entonces lo aplica; si algo
   falla, conserva el firewall que ya estaba cargado.

### Mantenimiento periodico

`npm run vpn:jobs` (en produccion, `deploy/radius-panel-vpn-jobs.timer` cada
15 min): certificados `superseded` vencidos pasan a `revoked` y regeneran su
CRL, poda de revocados ya caducados fuera de la CRL, borrado de tokens de alta
caducados y regeneracion adelantada de la CRL. Ver "Deploy automatico en el
VPS" para las unidades systemd.

### Sincronizacion de la CA intermedia con FreeRADIUS (prompts 14, 14.5 y 12.7)

FreeRADIUS (en la misma `.28`) valida EAP-TLS con `ca_path` (directorio con
la CA raiz offline + su CRL, puestas a mano) y `check_crl`/`check_all_crl =
yes`, en su propio modulo **`eap_vpn`** (`tls-config tls-vpn`) — el EAP-TLS
de la VPN NO comparte modulo con la WiFi (`eap`, PEAP-MSCHAPv2), y este
mecanismo nunca toca ese otro modulo. Como `ca_path` solo tenia la raiz,
cualquier certificado de dispositivo firmado por la CA INTERMEDIA del panel
(en vez de directamente por la raiz) se rechazaba:
`deploy/freeradius-vpn-ca-sync.sh` mantiene sincronizada la CRL de la
intermedia con lo que hay en el panel.

**Importante (prompt 12.7): la intermedia NUNCA va dentro de `ca_path`.**
FreeRADIUS/OpenSSL activan `X509_V_FLAG_PARTIAL_CHAIN`: si el certificado de
la intermedia esta directamente en `ca_path`, la cadena se da por buena
terminando ahi mismo -la raiz nunca entra en la validacion- y entonces no
hay forma de comprobar la revocacion de la PROPIA intermedia (hace falta la
CRL de la raiz, que en ese esquema nunca se carga): FreeRADIUS corta con
`unable to get certificate CRL`. Esto ya paso en produccion con el esquema
del prompt 14 y quedo arreglado asi:

- `ca_path` lleva SOLO la raiz (ya estaba) + la CRL de la intermedia
  (`panel-crl.pem`, gestionada por este script) — **nunca** el certificado
  de la intermedia ni ningun enlace `.0` para ella, solo el `.r0` de su CRL.
- La intermedia se guarda en un directorio APARTE, `INTERMEDIATE_DIR`
  (`panel-intermediate-N.pem`, por defecto
  `/etc/freeradius/3.0/certs/vpn`, fuera de `ca_path`). FreeRADIUS no lee la
  intermedia de ahi para validar nada: la recibe del propio cliente EAP-TLS
  en cada conexion (de ahi que el alta del dispositivo instale la intermedia
  en `LocalMachine\CA` en Windows, para que el cliente la envie en la
  cadena). Este directorio es solo referencia/backup en el propio host.
- `tls-config tls-vpn` necesita ADEMAS una linea `ca_file` con la raiz + su
  propia CRL en un unico fichero (preparado a mano una vez, ver mas abajo):
  `ca_path` y `ca_file` son complementarios en OpenSSL, no alternativos, y
  sin `ca_file` la comprobacion de revocacion de la intermedia puede volver
  a fallar con el mismo `unable to get certificate CRL`. Este script nunca
  gestiona `ca_file`: solo avisa (sin fallar) si no encuentra la linea.
- `tls-config tls-vpn` tambien necesita `ecdh_curve = "secp384r1:prime256v1"`:
  las claves TPM de los dispositivos y las de la mayoria de clientes son
  ECDSA P-256 (`prime256v1`); con solo `secp384r1` (la curva de la propia
  CA) FreeRADIUS corta la negociacion con `wrong curve`.

El valor de `ca_path` en `TLS_CONFIG_FILE` puede escribirse como ruta
literal o con variables de FreeRADIUS (`${certdir}/vpn/ca`,
`${confdir}/certs/vpn/ca`): el script las resuelve con `CONFDIR`/`CERTDIR`
antes de comparar con `CA_PATH`, no exige que sea texto literal identico.

Descarga `GET /pki/ca-chain.pem` y `/pki/crl.pem` por loopback (sin TLS: es
informacion publica, y solo se alcanza desde la propia `.28`), pero **nunca
confia en la raiz que trae esa respuesta**: valida la cadena descargada
contra la raiz que YA esta en `ca_path` (comprobada primero por su propia
huella SHA-256, fija en la configuracion del script) y cada CRL contra la
intermedia que la firmo -comprobando el TEXTO de `openssl crl -CAfile`
("verify OK" presente, "verify failure" ausente; nunca solo el codigo de
salida-, ademas de que no haya caducado. El script tambien comprueba que
`TLS_CONFIG_FILE` (el `eap_vpn` real) contiene de verdad el `ca_path`
configurado, para detectar una configuracion cruzada. Si algo no verifica,
no toca nada de lo que ya habia y sale con error.

**Recarga: nunca un `reload` (HUP)**. En FreeRADIUS 3, un HUP no vuelve a
cargar los contextos TLS de `rlm_eap`: una CRL nueva no se aplicaria y una
revocacion no tendria efecto hasta un restart de verdad. Las dos opciones
reales (confirmado en la documentacion oficial de FreeRADIUS, `raddb/
mods-available/eap`):

1. **`ca_path_reload_interval`** (FreeRADIUS 3.2+, dentro del `tls-config`):
   fuerza a OpenSSL a releer todo `ca_path` periodicamente, sin restart. Este
   script **nunca toca la configuracion de FreeRADIUS**: solo comprueba si
   ya esta puesta. Para activarla, anade dentro de `tls-config tls-vpn` en
   `/etc/freeradius/3.0/mods-enabled/eap_vpn`:
   ```
   tls-config tls-vpn {
       ...
       ca_path_reload_interval = 900   # 15 min, igual que el timer de este script
   }
   ```
   Con esto puesto, el script detecta la directiva y no reinicia nada nunca.
2. **Sin esa directiva**: el script comprueba la configuracion con
   `freeradius -XC` (para no reiniciar con algo roto) y, solo si es valida,
   hace `systemctl restart` (nunca `reload`) — y solo cuando de verdad hay
   cambios que aplicar.

**Etiqueta PEM de la CRL (corregido en el panel)**: `@peculiar/x509` (la
libreria de firma) exportaba las CRL con `-----BEGIN CRL-----`, no
`-----BEGIN X509 CRL-----` (la que exige RFC 7468 §4 y la UNICA que
reconocen `openssl crl`/`PEM_read_bio_X509_CRL` — verificado generando la
misma CRL con las dos etiquetas: solo la segunda parsea). `lib/x509.ts`
(`crlToPem`) ya corrige esto en origen: `GET /pki/crl.pem` y `crl_pem` en
base de datos usan siempre la etiqueta correcta desde este prompt. El `sed`
del script se ha dejado como tolerancia hacia paneles mas antiguos que
todavia no tuvieran este fix (comentado en el propio script); con un panel
al dia ya no hace falta, pero no molesta.

Instalacion en la `.28` (comandos, sin ejecutarlos):

```bash
# 1. Configuracion:
sudo mkdir -p /etc/freeradius-vpn-ca-sync
sudo cp deploy/freeradius-vpn-ca-sync.config.sh.example /etc/freeradius-vpn-ca-sync/config.sh
sudo chmod 600 /etc/freeradius-vpn-ca-sync/config.sh

# Calcula la huella SHA-256 de la raiz YA presente en ca_path (ajusta el
# nombre del fichero si no es exactamente este) y pegala en ROOT_CERT_SHA256:
openssl x509 -in /etc/freeradius/3.0/certs/vpn/ca/ca.crt -outform DER | openssl dgst -sha256

sudo nano /etc/freeradius-vpn-ca-sync/config.sh
# Como minimo, deja fijado:
#   ROOT_CERT_FILE=/etc/freeradius/3.0/certs/vpn/ca/ca.crt
#   ROOT_CERT_SHA256=<<la huella del comando de arriba>>

# 2. Prepara "ca_file" a mano UNA VEZ (raiz + su propia CRL en un solo
#    fichero; este script nunca lo gestiona, solo avisa si falta la linea):
cat /etc/freeradius/3.0/certs/vpn/ca/ca.crt /ruta/a/la/crl-de-la-raiz.pem \
  | sudo tee /etc/freeradius/3.0/certs/vpn/root-bundle.pem >/dev/null

# 3. Edita /etc/freeradius/3.0/mods-enabled/eap_vpn a mano, dentro de
#    "tls-config tls-vpn { ... }", y anade (o confirma que ya estan):
#      ca_file = "/etc/freeradius/3.0/certs/vpn/root-bundle.pem"
#      ecdh_curve = "secp384r1:prime256v1"
#      ca_path_reload_interval = 900   # opcional pero recomendado, ver arriba
sudo freeradius -XC   # comprueba que la configuracion sigue siendo valida
sudo systemctl restart freeradius   # una vez, para que recoja las directivas nuevas

# 4. Unidad y timer:
sudo cp deploy/freeradius-vpn-ca-sync.service deploy/freeradius-vpn-ca-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now freeradius-vpn-ca-sync.timer

# 5. Primera ejecucion a mano, para ver el resultado antes de esperar al timer:
sudo /opt/radius-panel/deploy/freeradius-vpn-ca-sync.sh
```

Comprobar que ha funcionado:

```bash
ls -la /etc/freeradius/3.0/certs/vpn/ca/          # panel-crl.pem y su enlace .r0, NUNCA un .0
ls -la /etc/freeradius/3.0/certs/vpn/             # panel-intermediate-1.pem (fuera de ca_path)
sudo systemctl status freeradius-vpn-ca-sync.timer
journalctl -u freeradius-vpn-ca-sync.service -n 50

# Validacion real y completa (cadena + CRL de la intermedia via ca_path, CRL
# de la raiz via ca_file) contra un certificado de dispositivo REAL emitido
# por el panel (p.ej. descargado con "Ver ficha del dispositivo -> Descargar
# paquete de conexion", o el .pem de un .didevvpn/paquete ya entregado). La
# intermedia se pasa con "-untrusted", igual que la envia el cliente EAP-TLS:
openssl verify -CApath /etc/freeradius/3.0/certs/vpn/ca \
  -CAfile /etc/freeradius/3.0/certs/vpn/root-bundle.pem \
  -partial_chain \
  -untrusted /etc/freeradius/3.0/certs/vpn/panel-intermediate-1.pem \
  -crl_check_all /ruta/al/certificado-de-dispositivo.pem
# -> "OK" si todo esta bien: la cadena verifica y ni la intermedia ni el
#    dispositivo estan en ninguna CRL cargada.
```

Volver atras (si algo fuera mal): parar el timer y borrar solo los ficheros
propios de este script -nunca toca los de la raiz, asi que basta con esto
para dejar FreeRADIUS exactamente como antes de instalarlo-:

```bash
sudo systemctl disable --now freeradius-vpn-ca-sync.timer
sudo rm -f /etc/freeradius/3.0/certs/vpn/ca/panel-crl.pem
sudo rm -f /etc/freeradius/3.0/certs/vpn/panel-intermediate-*.pem
sudo openssl rehash /etc/freeradius/3.0/certs/vpn/ca
sudo freeradius -XC && sudo systemctl restart freeradius
```

## Build de produccion

```bash
npm run build          # compila server/ (dist) y web/ (dist)
node server/dist/index.js
# sirve web/dist con nginx/caddy y proxya /api al backend
```

## Deploy automatico en el VPS (git pull cada 2 minutos)

Los ficheros de `deploy/` montan un deploy continuo por *polling*: un timer de
systemd comprueba cada 2 minutos si `origin/main` tiene commits nuevos y, si
los hay, hace `git pull` + `npm run install:all` + `npm run build` + reinicia
la API. No requiere webhooks ni abrir puertos entrantes nuevos.

Todo corre como **root** (sin usuario dedicado), pensado para un VPS de uso
exclusivo para este panel.

**1. Checkout** (una sola vez, como root):

```bash
git clone https://github.com/di0603/Radius-Panel.git /opt/radius-panel
cd /opt/radius-panel
```

**2. Variables de entorno de produccion**: crea `/opt/radius-panel/server/.env`
(y `web/.env` si usas login con Google) con las credenciales reales,
siguiendo la tabla de la seccion
[Variables de entorno](#variables-de-entorno-serverenv). Estos ficheros
**no** viajan por git (estan en `.gitignore`), asi que hay que crearlos a
mano la primera vez y el deploy automatico nunca los toca.

**3. Primer build manual** (dentro de `/opt/radius-panel`):

```bash
npm run install:all
npm run build
chmod +x deploy/deploy.sh
```

**4. Unidades systemd**:

```bash
cp deploy/radius-panel.service deploy/radius-panel-deploy.service deploy/radius-panel-deploy.timer /etc/systemd/system/

systemctl daemon-reload
systemctl enable --now radius-panel.service         # arranca la API
systemctl enable --now radius-panel-deploy.timer     # activa el polling cada 2 min
```

Si usas el modulo VPN, ademas (mantenimiento periodico: certificados
superseded -> revoked, poda de la CRL, tokens de alta caducados y
regeneracion de la CRL; ver `npm run vpn:jobs` mas abajo):

```bash
cp deploy/radius-panel-vpn-jobs.service deploy/radius-panel-vpn-jobs.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now radius-panel-vpn-jobs.timer   # lo ejecuta cada 15 min
```

Si ademas usas el firewall de la VM VPN generado desde el panel, esto va en
la **otra maquina** (192.168.10.29, no en la `.28`):

```bash
cp deploy/vpn-gateway-agent.sh /usr/local/bin/
chmod +x /usr/local/bin/vpn-gateway-agent.sh
mkdir -p /etc/vpn-gateway-agent
cp deploy/vpn-gateway-agent.config.sh.example /etc/vpn-gateway-agent/config.sh
# edita /etc/vpn-gateway-agent/config.sh: PANEL_URL y el token generado en "VPN > Ajustes"
chmod 600 /etc/vpn-gateway-agent/config.sh

cp deploy/vpn-gateway-agent.service deploy/vpn-gateway-agent.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now vpn-gateway-agent.timer   # lo ejecuta cada 5 min
```

**5. Comprobar que funciona:**

```bash
systemctl status radius-panel.service
systemctl list-timers radius-panel-deploy.timer
journalctl -u radius-panel-deploy.service -f   # ver deploys en vivo (haz un push y espera <2 min)
```

**6. Reverse proxy** (nginx local + Nginx Proxy Manager por delante para el
dominio/HTTPS):

```bash
apt install -y nginx
cp deploy/nginx-radius-panel.conf /etc/nginx/sites-available/radius-panel
ln -s /etc/nginx/sites-available/radius-panel /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
```

Esto sirve `web/dist` en `/` y proxya `/api` y `/health` a la API en
`127.0.0.1:1003` (ajusta el puerto en `deploy/nginx-radius-panel.conf` si
cambiaste `PORT` en `server/.env`). Nginx local escucha en el puerto 80 en
HTTP plano — el HTTPS y el dominio los termina **Nginx Proxy Manager**, que
reenvia aqui.

En NPM, crea un **Proxy Host**:
- Domain: tu dominio/subdominio
- Scheme: `http`, Forward Hostname/IP: la IP de este VPS, Forward Port: `80`
- SSL: pide certificado Let's Encrypt y activa "Force SSL"

Prueba primero sin NPM: `curl -s http://127.0.0.1/health` en el propio VPS
debe devolver el mismo JSON que en el puerto 1003.

Para desactivar el deploy automatico temporalmente:
`systemctl stop radius-panel-deploy.timer` (y `enable`/`start` de nuevo para
reanudarlo).

## Hoja de ruta

`ideas.md` contiene el backlog completo de mejoras (UX, funcionalidad, seguridad,
operaciones, tests, integraciones y objetivos a largo plazo), con marca de lo ya hecho
y prioridades.

## Notas de seguridad

- Cambia `JWT_SECRET` por una cadena larga y aleatoria.
- El login tiene rate limit (10 intentos / 15 min por IP).
- `Cleartext-Password` se guarda en claro en `radcheck` (lo exige FreeRADIUS para
  PAP/CHAP/MSCHAP); protege el acceso a MySQL en consecuencia.
- Sirve el panel siempre tras HTTPS.
