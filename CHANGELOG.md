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

El servidor comprueba el esquema al arrancar y se niega a levantar si falta
(la de Google solo se exige si `GOOGLE_CLIENT_ID` esta configurado).

### Verificacion

Ambas migraciones se aplicaron y se re-ejecutaron (comprobando idempotencia) contra
una base MariaDB 10.11 real, no solo contra tipos de TypeScript. Tambien se arranco
el servidor completo contra esa base y se probaron en caliente `/health`, `/api/meta`
y `/api/auth/google` con un token invalido (401 controlado, no un 500). El resto de
funcionalidad de escritura (crear usuarios, grupos, NAS...) sigue sin probarse
contra la base real de este entorno.
