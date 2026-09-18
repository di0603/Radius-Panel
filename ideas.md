# Ideas de mejora — Radius Panel

Backlog completo. `[x]` = ya hecho · `[ ]` = pendiente · 🔥 = alta prioridad / quick win.

---

## 0. Ya implementado

- [x] CRUD de usuarios RADIUS (radcheck / radreply / radusergroup)
- [x] Contrasena `Cleartext-Password` o `NT-Password` (MD4 propio)
- [x] Activar / desactivar usuario sin borrarlo (`Auth-Type := Reject`)
- [x] Grupos y perfiles (radgroupcheck / radgroupreply)
- [x] Sesiones activas + historial (radacct)
- [x] Desconexion de sesion vía Disconnect-Request RFC 5176 en Node puro
- [x] CRUD de NAS (tabla `nas`), con revelar/copiar el secret
- [x] Dashboard: KPIs, autenticaciones/día, tráfico/día, top usuarios, fallos de auth
- [x] Login local (bcrypt + JWT), roles `admin` / `operator`
- [x] Auditoría de todas las escrituras (`panel_audit_log`)
- [x] Menú de administración por consola (`npm run menu`)
- [x] Tests del backend (`node:test`): ntHash, bcrypt, JWT, cliente RADIUS
- [x] Tema Mantine, modo claro/oscuro, buscador con debounce, cabeceras de página
- [x] **Oleada 1** (ver §1): `/api/meta` + footer, validación de atributos por diccionario,
  probar auth (Access-Request PAP), import/export CSV, keyset en el historial, multi-CoA por
  usuario, `seed:demo`, probe de NAS + `clients.conf`, clonar grupo, tarjetas de reportes
  (motivos de cierre, top NAS, inactivos), request-id, CI, Prettier
- [x] **Oleada 2**: rediseno completo de la interfaz con sistema de temas (claro / oscuro /
  sistema + 7 acentos), seguridad del panel (refresh tokens en cookie HttpOnly, 2FA TOTP,
  bloqueo de cuenta, sesiones revocables, CSP), analitica nueva (heatmap, concurrencia,
  anomalias, comparativa de periodos, stats por NAS), buscador global Ctrl+K, ficha de
  usuario, acciones en bloque, filtros en la URL, pino, metricas Prometheus, ESLint y
  CHANGELOG

---

## 1. Quick wins / alta prioridad 🔥

- [x] 🔥 **Refresh token** + expiración corta del access token; renovación silenciosa. Rotación con detección de reuso; el access token vive en memoria y el refresh en cookie HttpOnly.
- [x] 🔥 **Endpoint `/api/meta`** (`{ version, coaEnabled, dbOk }`) y footer del panel con versión + estado. `/health` ahora comprueba ambas BDs (503 si fallan).
- [x] 🔥 **Validar atributos RADIUS** contra un diccionario (`server/src/lib/radiusDict.ts`): bloquea errores de tipo/enum al guardar y avisa de atributos no reconocidos. El editor sugiere valores.
- [x] 🔥 **Test de un usuario** desde el panel: botón "Probar" que hace un Access-Request PAP y muestra Accept/Reject + atributos. Cliente RADIUS auth en Node puro.
- [x] 🔥 **Paginación por keyset** en el historial de `radacct` (cursor por `radacctid`, botón "cargar más", el COUNT solo en la 1ª página).
- [ ] 🔥 **Índices** recomendados en `radpostauth(authdate)` y `radacct(acctstarttime)` — ya incluidos en `sql/freeradius-schema.sql`; falta guía para bases existentes.
- [x] 🔥 **Confirmar antes de salir** de un formulario con cambios sin guardar (editor de usuarios).
- [x] 🔥 **Rate-limit por usuario** además de por IP en el login; bloqueo temporal tras N fallos (`panel_login_attempts` + `locked_until`, con desbloqueo manual desde Administradores).
- [x] 🔥 **Semilla de datos demo** (`npm run seed:demo`): 15 usuarios, 3 grupos, 2 NAS, 90 días de accounting y postauth.
- [x] 🔥 **Request-id** por petición (`x-request-id`) y en los logs de error.
- [x] 🔥 **CI** (GitHub Actions): format + typecheck + tests + build en Node 20/22.
- [x] 🔥 **Prettier + EditorConfig** y scripts `format` / `format:check` / `typecheck`.

---

## 2. UX / UI

- [x] Vista de detalle de usuario (drawer) con pestañas: atributos, grupos, últimas sesiones, últimos intentos de auth y totales históricos (`GET /api/users/:u/activity`).
- [~] Acciones en bloque: hechos import/export CSV y **selección múltiple** para activar, desactivar y borrar. Falta mover usuarios de grupo en bloque.
- [x] Filtros persistentes en la URL (querystring): Usuarios, Sesiones (historial) y Auditoría.
- [x] Tabla de sesiones activas con auto-refresco configurable (5/15/30/60 s) y opción de pausa.
- [x] Skeletons en vez de spinners; estados vacíos con icono, explicación y acción.
- [ ] Formato de tráfico/tiempo consistente y con tooltip del valor exacto en bytes.
- [ ] Densidad de tabla (compacta / cómoda) y recordar preferencia.
- [x] Búsqueda global (Cmd/Ctrl-K): salta a páginas y busca usuarios, grupos y NAS en vivo.
- [x] Título de pestaña dinámico (`document.title`) por página. Faltan breadcrumbs.
- [x] Exportar tablas a CSV: Usuarios, Sesiones (activas e historial) y Auditoría.
- [ ] Modo "solo lectura" visual para el rol `operator` donde no aplique.
- [~] Copia rápida de valores: hecho para el secret de NAS (revelar + copiar) y `clients.conf`.
- [ ] Gráficas: rango de fechas personalizado (date range picker) además de 7/30/90.
- [x] Exportar tablas a CSV / Excel (separador `;`, BOM UTF-8).
- [~] Favicon y manifest propios hechos; falta un **service worker** para que sea instalable de verdad.
- [ ] Atajos de teclado (nuevo usuario, buscar, cerrar modal).

## 3. Usuarios

- [ ] Plantillas de usuario (perfiles predefinidos: "PPPoE 100M", "Hotspot 2h"…).
- [x] Alta masiva por CSV / pegar lista (`POST /api/users/bulk` + modal "Importar CSV"). Falta generación de contraseñas aleatorias.
- [~] Caducidad de cuenta (`Expiration`): editor con date picker que escribe el atributo. Falta el aviso/desactivación automática.
- [ ] Ventana horaria de acceso (`Login-Time`) con editor visual.
- [ ] `Simultaneous-Use` con ayuda y aviso si no está `sqlcounter` configurado.
- [ ] Historial de cambios por usuario (a partir de `panel_audit_log`).
- [ ] Cuotas de datos/tiempo (integración con `sqlcounter` / `dailycounter` / `monthlycounter`).
- [ ] Reset de contadores de cuota desde el panel.
- [x] Ver y forzar cierre de todas las sesiones de un usuario (multi-CoA): `POST /api/users/:u/disconnect` + acción en la tabla.
- [ ] Campo "notas" / metadatos por usuario (tabla propia `panel_user_meta`, sin tocar el esquema RADIUS).
- [ ] Import/export de un usuario como JSON.
- [ ] Soporte de realms (`user@realm`) y sufijos.
- [ ] Detección de contraseñas débiles / duplicadas.

## 4. Grupos y perfiles

- [ ] Editor de perfil con campos "de negocio" (velocidad ↑/↓, timeout, pool IP) que traduce a atributos.
- [ ] Prioridad / orden de grupos por usuario con drag & drop.
- [x] Clonar grupo (acción en la tabla → abre "nuevo grupo" con los atributos copiados).
- [ ] Ver miembros de un grupo y añadir/quitar en bloque.
- [ ] Vendor-specific attributes con diccionarios (Mikrotik, Cisco, Ubiquiti, Huawei…).
- [ ] Previsualización: "qué recibiría un usuario de este grupo" (merge de atributos).

## 5. Sesiones / accounting / CoA

- [ ] CoA además de Disconnect: cambiar rate-limit / pool en caliente.
- [ ] Reintentos y logging detallado del intercambio CoA (paquete enviado / recibido).
- [ ] Soporte de `NAS-Identifier` y de NAS tras NAT (mapa IP CoA distinta de `nasipaddress`).
- [ ] Detección de "stale sessions" (sin update en X min) y limpieza asistida.
- [ ] Línea de tiempo de una sesión (start / interims / stop) con gráfica de consumo.
- [ ] Mapa / listado de sesiones por NAS y por pool de IP.
- [~] Detección de sesiones anómalas (muy largas, mucho tráfico, reconexiones en bucle) en Reportes. Falta convertirlo en **alertas** que avisen solas.
- [x] Exportar accounting de un rango para facturación (CSV del historial filtrado).
- [ ] Vista "en vivo" con WebSocket/SSE en vez de polling.
- [ ] Geolocalización aproximada por IP de `callingstationid` / framed IP.

## 6. NAS / clientes

- [x] Comprobación de conectividad al NAS (Status-Server best-effort al puerto CoA) — botón "Probar".
- [x] Generar el bloque `clients.conf` equivalente para copiar (`GET /api/nas/:id/clients-conf`).
- [ ] Agrupar NAS por sede / zona; etiquetas.
- [ ] Rotación de secrets con recordatorio.
- [ ] Validar rangos CIDR además de IP única (`nasname` puede ser red).
- [x] Estadísticas por NAS (sesiones, usuarios, activas ahora, tráfico, duración media). Los rechazos por NAS no se pueden sacar: `radpostauth` no guarda `nasipaddress`.

## 7. Reportes / analítica

- [ ] Informe programado por email (PDF/CSV) diario/semanal.
- [x] Comparativa de periodos: los últimos N días frente a los N anteriores, con variación porcentual.
- [x] Uso por franja horaria (heatmap hora × día de la semana).
- [x] Top NAS y top motivos de `acctterminatecause` (tarjetas en el dashboard). Falta el cruce causa × NAS.
- [x] Usuarios inactivos (sin auth en N días) → tarjeta en el dashboard.
- [x] Concurrencia máxima por día (pico de sesiones simultáneas, calculado hora a hora).
- [ ] KPI de disponibilidad del servicio RADIUS (gaps en accounting).
- [ ] Panel configurable (widgets que el admin coloca).

## 8. Seguridad / autenticación del panel

- [x] 2FA (TOTP) para administradores, con QR y secreto cifrado en reposo (AES-256-GCM).
- [ ] Política de contraseñas + caducidad + historial.
- [x] Bloqueo de cuenta tras N intentos; desbloqueo manual desde la página de Administradores.
- [ ] Login vía OIDC / SAML / LDAP (SSO corporativo) como alternativa al login local.
- [x] Sesiones activas del panel: listarlas y revocarlas una a una o todas de golpe.
- [ ] Permisos granulares (RBAC por recurso: solo-lectura de usuarios, gestión de NAS…).
- [ ] Ámbito por grupo/NAS: un operador solo ve "sus" usuarios.
- [x] Cabeceras de seguridad afinadas (CSP estricta) y cookie `HttpOnly`: ya no hay token en `localStorage`.
- [~] Registro de accesos fallidos en `panel_login_attempts`; faltan las **alertas**.
- [ ] Firmar/rotar `JWT_SECRET` sin invalidar todo (kid + set de claves).
- [ ] Exportar el log de auditoría firmado / a SIEM (syslog, webhook).
- [~] Cifrado en reposo hecho para los secretos TOTP; falta para los **secrets de NAS**.

## 9. Operaciones / infra / despliegue

- [ ] Sistema de migraciones versionadas (p.ej. `node-pg-migrate` equivalente para MySQL, o `umzug`) en vez de `.sql` sueltos.
- [ ] `npm run migrate` / `migrate:status` / `migrate:down` y ejecución automática al arrancar (opcional).
- [x] Healthcheck `/health` que comprueba ambas BDs y devuelve 503 si fallan (+ `/api/meta`).
- [x] Logs estructurados con **pino** (niveles, request-id y redacción de cabeceras sensibles). La rotación se delega en systemd/journald.
- [x] Métricas Prometheus en `/metrics`: latencia y volumen por ruta, más contadores propios.
- [ ] Dockerfile + docker-compose *opcional* (el usuario no lo quiere ahora, pero dejarlo listo).
- [ ] Servicio systemd de ejemplo + guía nginx/caddy (TLS + servir `web/dist`).
- [ ] Modo "un solo proceso": que Express sirva también el build de la SPA.
- [ ] Backups: script de dump de `radius_panel` (los admins) y aviso de backup de `radius`.
- [x] Validación de la configuración con **zod** al arrancar (falla con mensaje claro). Lo del `config.yaml` sigue pendiente y probablemente no haga falta.
- [x] Variables de entorno documentadas en `.env.example` y verificadas al arrancar (fail-fast).
- [x] CI (GitHub Actions): format + typecheck + tests + build en Node 20/22.
- [~] `CHANGELOG.md` creado; falta automatizar el versionado semántico.

## 10. Calidad de código / testing

- [ ] Tests de integración de la API contra una MySQL efímera (testcontainers / mysql-memory).
- [x] Tests del cliente RADIUS con un socket UDP falso (Access-Accept / Reject / Disconnect-ACK / timeout).
- [ ] Tests E2E de la SPA (Playwright): login, crear usuario, desconectar sesión.
- [~] Prettier, EditorConfig y **ESLint** (en el CI) hechos; falta `lint-staged` + hook de pre-commit.
- [ ] Cobertura mínima en CI.
- [ ] Tipos compartidos server↔web en un paquete `shared/` (hoy están duplicados).
- [ ] OpenAPI/Swagger generado desde los esquemas zod; página `/api/docs`.
- [ ] Contratos: `zod` → tipos → cliente tipado (p.ej. `openapi-fetch` o `ts-rest`).
- [ ] Manejo de errores uniforme y códigos de error propios.

## 11. Integraciones

- [ ] Webhooks salientes (usuario creado, sesión cerrada, pico de rechazos…).
- [ ] API de solo lectura con API-keys para sistemas externos (facturación, CRM).
- [ ] Sincronización con un IdP / directorio (altas y bajas automáticas).
- [ ] Notificaciones a Telegram / Slack / email para alertas.
- [ ] Integración con `daloRADIUS` / import desde su esquema.
- [ ] Exponer datos a Grafana (datasource MySQL) con vistas SQL preparadas.
- [ ] Passkeys/WebAuthn para el panel.

## 12. Rendimiento / escalabilidad

- [ ] Cache de listados poco cambiantes (grupos, NAS) con invalidación.
- [ ] Consultas de reportes materializadas / tabla de agregados nocturna.
- [ ] Streaming de exportaciones grandes (no cargar todo en memoria).
- [ ] Pool de conexiones ajustable por env; timeouts y reconexión.
- [ ] Soporte de réplica de lectura para reportes.
- [ ] Índices y `EXPLAIN` documentados para las queries pesadas.

## 13. i18n / accesibilidad

- [ ] i18n completa (es / en) con `react-i18next`; hoy los textos están en español fijos y sin tildes en el código.
- [ ] Revisar contraste, foco visible, navegación por teclado, roles ARIA en tablas y modales.
- [ ] Formatos de fecha/número por locale del navegador.
- [ ] Textos de error traducidos y accionables.

## 14. Largo plazo / ambicioso

- [ ] Multi-tenant: varios RADIUS / varias BDs desde un mismo panel.
- [ ] Editor visual de políticas (arrastrar condiciones → atributos) sin tocar `unlang`.
- [ ] Portal de autoservicio para el usuario final (cambiar contraseña, ver consumo).
- [ ] Facturación básica (planes, ciclos, prepago/pospago) sobre el accounting.
- [ ] Aprovisionamiento de CPE / integración con controladores WiFi (UniFi, Omada, Mikrotik API).
- [ ] Soporte EAP/TLS: gestión de certificados de cliente y CA.
- [ ] Alta disponibilidad del propio panel (stateless + varios nodos tras balanceador).
- [ ] App móvil / vista específica para operación desde el teléfono.
- [ ] Modo "diagnóstico" que corre una batería de comprobaciones (esquema, índices, NAS accesibles, accounting llegando, CoA funcionando).
