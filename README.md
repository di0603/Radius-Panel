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
| Usuarios | Alta/edicion/baja sobre `radcheck` / `radreply` / `radusergroup`. Contrasena `Cleartext-Password` o `NT-Password`. Activar/desactivar sin borrar. Caducidad (`Expiration`). Editor de atributos con **validacion por diccionario**. **Probar autenticacion** (Access-Request PAP). **Importar** (CSV pegado) y **exportar** CSV. Cortar todas las sesiones del usuario. |
| Grupos y perfiles | Atributos de grupo (`radgroupcheck` / `radgroupreply`), recuento de miembros, **clonar grupo**. |
| Sesiones | Activas (auto-refresco configurable + pausa) e historial con **paginacion por keyset** desde `radacct`, consumo, **Disconnect-Request (RFC 5176)**, exportacion CSV. |
| NAS | CRUD de la tabla `nas`. Revelar/copiar secret, **probar conectividad** (CoA) y generar el bloque **`clients.conf`**. |
| Reportes | Autenticaciones/dia, trafico/dia, top usuarios, fallos de auth, motivos de cierre, top NAS, usuarios inactivos. |
| Administradores | Cuentas del panel con hash bcrypt, JWT y roles `admin` / `operator`. |
| Auditoria | Toda escritura del panel queda en `panel_audit_log` (solo rol `admin`). |

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

- **Esquema / migraciones** — aplicar `sql/panel-schema.sql` o `sql/freeradius-schema.sql`
  contra tu MySQL sin salir del proceso; ver que tablas existen en cada base.
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
| `CORS_ORIGIN` | Origen permitido (la SPA). En dev con el proxy de Vite no hace falta tocarlo. |
| `JWT_SECRET` | **Obligatorio.** Secreto para firmar los tokens. |
| `JWT_EXPIRES_IN` | Caducidad del token (def. `8h`). |
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

## Build de produccion

```bash
npm run build          # compila server/ (dist) y web/ (dist)
node server/dist/index.js
# sirve web/dist con nginx/caddy y proxya /api al backend
```

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
