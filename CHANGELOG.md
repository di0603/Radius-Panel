# Changelog

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).
Este proyecto usa versionado semantico.

## [No publicado]

### Anadido

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
