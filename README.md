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
| **VPN > Ajustes** | Token de la puerta de enlace del firewall (`deploy/vpn-gateway-agent.sh`). El resto de ajustes (`panel_vpn_settings`: FQDN, identidad AAA, rango de IPs, dias de vigencia/renovacion, URL de EST, red LAN) todavia se editan solo por SQL/`npm run menu`, sin pagina propia. |

### Variables de entorno (server/.env)

| Variable | Descripcion |
|----------|-------------|
| `PKI_MASTER_KEY` | Cifra la clave privada de la CA intermedia (`panel_pki_ca.private_key_encrypted`). Minimo 32 caracteres, aleatorio. Sin ella el panel arranca igual, pero generar/usar la CA intermedia falla con un mensaje claro. **Si la cambias despues de generar una CA intermedia, esa clave privada deja de poder descifrarse: no hay forma de recuperarla** (ver "Copias de seguridad" en `SECURITY.md`). |
| `EST_ENABLED` | `false` apaga el listener EST aunque haya certificado/clave configurados (def. `true`). |
| `EST_PORT` / `EST_BIND` | Puerto/IP del listener HTTPS de EST (def. `8443` / `0.0.0.0`). Servidor separado de la API principal: necesita TLS mutuo real (`requestCert: true`), que un proxy que termina TLS (nginx) no puede reenviar. |
| `EST_TLS_CERT` / `EST_TLS_KEY` | Certificado y clave propios del listener EST, para el nombre publico de la PKI (p.ej. `pki.vlc.didev.es`). Los firma la CA raiz offline (EKU `serverAuth`, SAN DNS = ese nombre), **no** Let's Encrypt: los dispositivos confian solo en esa raiz para esta conexion. Sin estas dos, el resto del panel funciona igual, solo que sin alta/renovacion automatica. |

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

`npm run menu` te dice cuales faltan contra tu base real (no solo si la tabla
existe: tambien si tiene ya las columnas de la version actual).

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
   alta"): un solo uso, valido 24h, se ensena una unica vez.
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
