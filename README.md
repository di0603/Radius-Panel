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
