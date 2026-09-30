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
- [x] Campo "notas" / metadatos por usuario (tabla propia `panel_user_meta`, sin tocar el esquema RADIUS):
  email de contacto y notas libres, editables desde la ficha del usuario, visibles en la tabla y en el export CSV.
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
- [x] Login vía OIDC como alternativa al login local: **Google** implementado (vinculación
  por email → `google_sub`, sin alta libre). SAML / LDAP siguen pendientes.
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
- [ ] Soporte EAP/TLS: gestión de certificados de cliente y CA (en curso, ver §15).
- [ ] Alta disponibilidad del propio panel (stateless + varios nodos tras balanceador).
- [ ] App móvil / vista específica para operación desde el teléfono.
- [ ] Modo "diagnóstico" que corre una batería de comprobaciones (esquema, índices, NAS accesibles, accounting llegando, CoA funcionando).

---

## 15. VPN IKEv2 / EAP-TLS (CA propia)

Panel como CA emisora de certificados de dispositivo para una VPN IKEv2 (strongSwan)
con EAP-TLS, alta y renovación automática por EST (RFC 7030). Solo rol `admin`.

- [x] Esquema de base de datos: `vpn_certificates` (base `radius`, compatible con la
  tabla ya creada a mano y su fila de prueba `vps`) y `panel_vpn_devices` /
  `panel_vpn_enroll_tokens` / `panel_pki_ca` / `panel_vpn_settings` (base del panel).
  Migraciones idempotentes registradas en `npm run menu`; `/api/meta.vpnEnabled`
  indica si el módulo está activo. Ajustado en la corrección 4.5 al modelo exacto
  de `CLAUDE.md` (ver más abajo).
- [x] Página "PKI" (solo admin): generar clave+CSR de la CA intermedia en
  **ECDSA P-384** (clave cifrada con `PKI_MASTER_KEY`, nunca en claro), importar
  el certificado firmado offline por la raíz con validación completa (firma,
  vigencia, `BasicConstraints CA:true` con `pathLenConstraint=0`, `KeyUsage
  keyCertSign+cRLSign`, `ExtendedKeyUsage` únicamente `clientAuth`, clave ECDSA
  P-384 y que la SPKI coincida con el CSR — una intermedia mal firmada, con
  curva distinta o sin estos límites no se puede activar), rotación (la
  anterior pasa a "retirándose", sigue publicando CRL hasta que caduca) y
  publicación pública `GET /pki/ca-chain.pem` / `GET /pki/crl.pem` (CRL con
  `nextUpdate` a 7 días, regenerada al importar y a diario). Una CA `pending`
  generada en RSA por una versión anterior se retira sola al arrancar
  (`retireStaleRsaIntermediates`), con aviso en la página.
- [x] `signDeviceCsr` (librería, `server/src/services/deviceCerts.ts`): verifica
  la firma del CSR, exige CN exacto, acepta solo ECDSA P-256/P-384 o RSA >= 3072,
  ignora las extensiones pedidas y emite con serial aleatorio de 128 bits,
  KeyUsage `digitalSignature`, EKU `clientAuth`, SAN `dNSName` = CN, AKI/SKI,
  `notBefore` 5 minutos antes, fechas UTC. Probado con una cadena real
  raíz → intermedia → dispositivo verificada con `openssl verify`. Todavía sin
  endpoint HTTP que lo use (eso es el ítem de EST, más abajo).
- [x] Sección "VPN > Dispositivos" (solo admin): alta en una única operación
  (asigna la primera IP libre del pool comprobando `radreply` de todos los
  usuarios, `radcheck` con `Service-Type == Framed-User`, `radusergroup` = `vpn`,
  ficha en `panel_vpn_devices`; si falla la ficha del panel se deshacen a mano
  las filas RADIUS ya confirmadas, porque panel y radius pueden vivir en
  servidores MySQL distintos). Usuario RADIUS = `vpn-<owner_user>-<device_label>`,
  único. Ficha con historial de certificados, sesiones (reutiliza
  `/users/:u/activity`), última emisión y próxima renovación esperada (el
  `cert_days`/`renew_after_days` del dispositivo sobrescribe el general). Token
  de alta EST de un solo uso (24h, solo se guarda el hash; generar uno nuevo
  borra el anterior). Activar/desactivar reutiliza `Auth-Type := Reject` +
  desconexión CoA. Revocar certificado regenera la CRL de su CA
  (`vpn_certificates.ca_id`) y desconecta la sesión. Dar de baja revoca,
  desconecta y borra las filas RADIUS liberando la IP, conservando el
  historial. El editor de usuarios genérico avisa si el usuario es un
  dispositivo VPN.
- [x] `vpn_certificates.ca_id`: enlaza cada certificado con el id de `panel_pki_ca`
  que lo firmó, para que revocar regenere la CRL correcta. Ya se rellena al
  firmar por EST (ítem de más abajo); en el dispositivo de prueba `vps` sigue
  valiendo NULL por ser anterior a la emisión automática.
- [x] **Corrección 4.5**: a mitad del desarrollo apareció un `CLAUDE.md` con el
  modelo de datos y la criptografía obligatorios (ECDSA en vez de RSA para la
  CA, `ca_id` en vez de `ca_serial`, `owner_user`/`device_label`/`enabled` en
  vez de `owner`/`status`, `root_cert_pem` embebido en vez de una fila de CA
  raíz aparte, `aaa_id`/`est_url` en los ajustes). Este ítem realineó todo lo de
  arriba con ese modelo; como el módulo no se había desplegado en producción
  todavía, `panel_pki_ca`/`panel_vpn_devices` se recrearon vacías en vez de
  migrarse con ALTER/RENAME.
- [x] **EST (RFC 7030)** para alta y renovación automática de dispositivos:
  listener HTTPS propio (`EST_PORT`, separado de la API/nginx porque necesita
  TLS mutuo real), TLS 1.2 mínimo y solo cifrados ECDHE+AEAD. `GET cacerts`
  sin login; `POST simpleenroll` valida el CSR (formato, firma, CN) antes de
  tocar el token de alta, reclamado de forma atómica (y liberado si firmar o
  insertar falla después); dispositivo desconocido y token incorrecto
  responden con el mismo 401 (el motivo real solo va a auditoría). `POST
  simplereenroll` autenticado por el certificado de cliente de la propia
  conexión mTLS, con una cadena de validaciones (serie conocida, no caducado,
  firma de la CA que según la base de datos lo emitió, no revocado, estado
  activo, CN del propio certificado coincide con el dispositivo de su fila,
  dispositivo habilitado, CN del CSR coincide, firma del CSR válida, clave no
  reutilizada, límite de frecuencia de 12h) antes de emitir la renovación y
  pasar el certificado viejo a `superseded` con solapamiento en vez de
  revocarlo en el acto — todo (localizar/bloquear filas, comprobar límites,
  insertar, marcar `superseded`) en una única transacción de `radiusPool`,
  para que dos renovaciones concurrentes del mismo dispositivo no puedan
  tener éxito las dos. `GET status` comparte esa misma validación del
  certificado presentado. Errores sin detalle interno en la respuesta, con
  auditoría completa y métricas Prometheus por motivo de rechazo. Ver el
  detalle completo de cada validación en el CHANGELOG.
- [x] **Paquete de conexión descargable** desde la ficha del dispositivo
  (Windows y Linux/VPS; Android todavía se configura a mano en la app de
  strongSwan). Windows: zip con `install.ps1` (conexión IKEv2 "Casa" con
  EAP-TLS, importa la raíz/intermedia de la CA, GCMAES256/SHA384/ECP384),
  `enroll.ps1` (clave no exportable en el TPM, o en el proveedor de software
  si no hay TPM; pide el token por pantalla) y `renew.ps1` (usa `GET status`
  de EST para saber si toca renovar; lo programa `enroll.ps1` en el
  Programador de tareas). Linux/VPS: tar.gz con `casa.conf` (fragmento de
  swanctl), `vpn-enroll`/`vpn-renew` (bash + openssl + curl, clave ECDSA
  P-384, token leído de la entrada estándar) y las unidades systemd del
  timer; `vpn-renew` conserva la clave y el certificado anteriores hasta
  comprobar que la conexión arranca con los nuevos. Ningún paquete contiene
  claves ni el token de alta (tests que descomprimen el zip/tar.gz de
  verdad y comprueban que ningún fichero lleva material secreto).
- [x] **Certificado Android emitido por el panel** (excepción documentada: la
  app de strongSwan para Android no sabe renovarse sola por EST, así que solo
  para estos dispositivos genera la clave el propio panel). Botón "Emitir
  certificado": clave ECDSA P-256, mismo perfil/vigencia (`android_cert_days`)
  y mismo solapamiento que una renovación EST si ya había un certificado
  activo; construye un `.p12` (AES-256-CBC/PBKDF2/SHA-256, verificado con
  `openssl pkcs12 -info`) protegido con una contraseña aleatoria de 20
  caracteres mostrada una única vez, y un perfil `.sswan` (formato de
  importación de Android, comprobado contra la documentación oficial de
  strongSwan) con el `.p12` embebido, la raíz de la CA y las propuestas
  `aes256gcm16-prfsha384-ecp384`/`aes256gcm16-ecp384` en full tunnel. Enlace
  de descarga público pero de un solo uso, caduca a los 15 minutos y solo
  funciona desde la LAN o el rango de la VPN
  (`panel_vpn_settings.lan_cidr`, columna nueva); borra la fila al servirlo y
  purga a diario los enlaces caducados sin descargar. Detalle completo en el
  CHANGELOG.
- [x] **Mantenimiento periódico del módulo VPN** (`npm run vpn:jobs`, cada 15
  min vía `deploy/radius-panel-vpn-jobs.timer`, con bloqueo `GET_LOCK` de
  MySQL para que dos ejecuciones no se pisen): certificados `superseded`
  vencidos -> `revoked` + regenerar CRL; poda de revocados ya caducados
  fuera de la CRL (en cuanto cruzan la fecha, no en el siguiente ciclo);
  tokens de alta EST caducados borrados; CRL regenerada si le quedan menos
  de 3 días (antes 1 día, solo con el timer interno de la API, que ahora
  queda como red de seguridad por si el timer de systemd no se despliega).
- [x] **Alertas de salud VPN**: tarjeta "VPN" en el panel (solo admin) y
  Gauges en `/metrics`. Renovación automática atascada en dispositivos
  Windows/Linux (crítico si caducan en <3 días o no tienen certificado
  activo), certificados Android que caducan en <30 días, CA intermedia que
  caduca en <90 días, pico de rechazos EST en la última hora.
- [x] **Corrección 8.6**: `sql/panel-schema-vpn-4.5.sql` fallaba con `Unknown
  column 'token_hash'` en cualquier instalación nueva (`panel-schema-vpn.sql`
  ya crea `panel_vpn_enroll_tokens` con `token_sha256` desde el principio).
  El `UPDATE` que copiaba el hash ahora comprueba antes en
  `information_schema.COLUMNS` y solo se ejecuta (vía `PREPARE`/`EXECUTE`) si
  `token_hash` existe de verdad.
- [x] **Firewall de la VM VPN generado desde el panel** (192.168.10.29, en vez
  de reglas nftables a mano): permisos por dispositivo en su ficha
  ("internet", "toda la LAN" o destino/protocolo/puerto concretos); el
  acceso a EST se añade siempre y RADIUS (192.168.10.28)/MariaDB
  (192.168.10.30) quedan siempre bloqueados salvo excepción explícita por
  dispositivo (con aviso). `GET /vpn/gateway/firewall.nft` genera la tabla
  `inet vpn_clients` completa, autenticado con un token de la puerta de
  enlace (pestaña "VPN > Ajustes", nueva). `deploy/vpn-gateway-agent.sh` +
  timer systemd descargan, validan con `nft -c -f` y aplican el fichero,
  conservando el anterior si algo falla.
- [x] **Página "VPN > Ajustes"** (nueva, mínima por ahora): solo el token de
  la puerta de enlace del firewall. El resto de ajustes (FQDN, identidad
  AAA, rango de IPs, días de vigencia/renovación, URL de EST, red LAN,
  umbral de alerta de rechazos EST) sigue pendiente de una página completa.
- [ ] Retirar el dispositivo de prueba `vps` cuando exista la CA intermedia real.
- [x] **Cierre del modulo**: seccion "VPN y certificados" en el `README.md`
  (arquitectura, variables, migraciones en orden, puesta en marcha de la CA
  intermedia, alta por plataforma, firewall de la puerta de enlace) y
  `SECURITY.md` nuevo (modelo de amenazas, copias de seguridad de
  `panel_pki_ca`/`PKI_MASTER_KEY` por separado, procedimiento de revocacion de
  la intermedia). Revision de seguridad de todo el codigo del modulo: ver el
  detalle de lo corregido en el CHANGELOG.
- [ ] Boton "revocar todos los certificados de esta CA" en la pagina PKI (hoy
  requiere SQL directo, ver `SECURITY.md` → "Procedimiento si hay que revocar
  la CA intermedia"), y una ruta para pasar una intermedia `retiring` a
  `retired` a mano sin esperar a que expire su CRL.
- [x] **Correccion 10.5 (firewall de la puerta de enlace)**: `buildFirewallRuleset`
  no era idempotente (`nft -f` duplicaba reglas en cada ejecucion del
  agente), la cadena `forward` no aceptaba el trafico de vuelta ni el resto
  del forward de la maquina (la VPN se habria caido para todos), "internet"
  no excluia redes privadas/CGNAT/link-local, el agente descargaba el
  fichero por HTTP en claro (token expuesto, y el puerto ni siquiera esta
  abierto en el firewall real), `trust proxy` seguia siendo un numero de
  saltos (no comprueba direcciones) y el `Content-Type` de EST llevaba un
  `charset` de mas. Validado con `nft -c -f` real (WSL) sobre un fichero de
  ejemplo con dos dispositivos, revisado antes de fusionar. Detalle completo
  en el CHANGELOG.
- [x] **Prompt 11 (aprovisionamiento de apps)**: perfil `.didevvpn` firmado
  con Ed25519, generado junto al token de alta y entregado como fichero
  descargable + QR (24h, un solo uso, igual que el token). Clave de firma
  leida de `VPN_PROFILE_SIGNING_KEY` (no se genera en este prompt; queda
  para el despliegue del hito 4). `GET /.well-known/est/status` publica
  ahora `minAppVersion` (`panel_vpn_settings.min_app_version`, migracion
  `panel-schema-vpn-provisioning.sql`). Verificado (con tests nuevos) que el
  modelo ya soportaba varios dispositivos por equipo, uno por usuario, y que
  el limite de 32 caracteres/unicidad ya se validaban. Sin implementar
  todavia: las apps que consumen este perfil (prompt 12, en pausa, ver
  `APPS/Windows/NOTAS-prompt-12-en-pausa.md`). Detalle completo en el
  CHANGELOG.
- [x] **Correccion 11.5 (QR compacto)**: el sobre firmado completo (con la
  cadena de CA real dentro) sale en un QR version ~39, casi imposible de
  escanear. Anadido `rootCaSha256` (siempre presente) y una variante `qr`
  del perfil (firmada por separado, sin `caChainPem`) que cabe con holgura
  en version ≤ 25; contrato de confianza-por-huella documentado en el
  README para las apps (piden `GET cacerts` sin TLS todavia y solo aceptan
  la raiz si su SHA-256 coincide con `rootCaSha256`). Detalle completo en el
  CHANGELOG.
- [x] **Prompt 14 + 14.5 (sincronizacion de la CA con FreeRADIUS)**: nuevo
  `deploy/freeradius-vpn-ca-sync.sh` (timer cada 15 min) para que FreeRADIUS
  (modulo `eap_vpn`, `tls-config tls-vpn`) acepte certificados firmados por
  la intermedia del panel, no solo por la raiz. Descarga
  `ca-chain.pem`/`crl.pem` del panel por loopback, valida contra la raiz ya
  presente (nunca la del HTTP) y anade solo sus propios ficheros. Nunca usa
  `reload` (un HUP no recarga los contextos TLS de FreeRADIUS 3): usa
  `ca_path_reload_interval` si esta configurado, o si no `freeradius -XC` +
  `systemctl restart`. Corregido en el panel: `@peculiar/x509` etiquetaba
  las CRL como PEM `CRL`, no `X509 CRL` (RFC 7468) — ya arreglado en origen
  (`lib/x509.ts: crlToPem`), el `sed` del script se queda solo como
  tolerancia hacia paneles antiguos. Rama `feat/vpn-14-freeradius-sync`,
  pendiente de revision. Detalle completo en el CHANGELOG.
- [x] **Prompt 12.5 (huellas del panel, lado servidor)**: cambio de diseno
  a clientes GENERICOS (como FortiClient) con confianza en el primer uso
  (TOFU) por servidor, en vez de una clave publica de didev incrustada en
  cada app. El sobre firmado gana `signerPublicKey` (clave publica Ed25519
  del panel, fuera del payload) y el payload gana `signerKeySha256` (huella
  de esa clave, dentro de lo firmado, para ligarla a la firma). Nuevas
  huellas visibles para comparar a ojo ("Huella del panel"/"Huella de la
  raiz", agrupadas de 4 en 4 en mayusculas + codigo corto de 8 grupos) en
  la pantalla del token de alta y en VPN > Ajustes. Contrato TOFU completo
  documentado en el README para que lo implemente cualquier app. Solo el
  lado del panel (rama `feat/vpn-12.5-huellas-panel`); la reescritura de
  `didev-vpn-windows` como cliente generico va en
  `feat/vpn-12-windows-wip`. Detalle completo en el CHANGELOG.
- [x] **Prompt 12.7 (Windows: rendimiento)**: la app se congelaba varios
  segundos en cada refresco (cada consulta de estado lanzaba un
  `powershell.exe` nuevo). Nuevo `RasStateReader` con P/Invoke directo a
  `rasapi32.dll` (milisegundos, sin procesos), con respaldo automatico por
  PowerShell si fallara; `rasdial.exe` directo para conectar/desconectar;
  nada bloqueante en el hilo de interfaz (`Task.Run` + boton
  deshabilitado); `ConnectionStateService` (cache unica, refresco por
  `NetworkChange` con debounce + respaldo cada 30s) sustituye los
  temporizadores de sondeo propio; `ConnectionManagerForm` ya no reconstruye
  toda la lista en cada refresco. `PublishReadyToRun=true`. Medido de
  verdad: arranque ~360ms->~241ms, un refresco con 3 conexiones
  ~6,3s->~10ms. Version 0.1.6 compilada y ejecutada de verdad. Ademas
  (items 8-9 del prompt): scripts de `deploy/` marcados ejecutables en git
  (se subieron como 644 desde Windows); arreglado un bug real de
  `freeradius-vpn-ca-sync.sh` (con `X509_V_FLAG_PARTIAL_CHAIN`, tener la
  intermedia dentro de `ca_path` rompia la validacion de su propia
  revocacion con "unable to get certificate CRL") separando la intermedia
  (fuera de `ca_path`) de su CRL (dentro), y documentando que hace falta
  `ca_file` (raiz+su CRL) y `ecdh_curve = "secp384r1:prime256v1"`. Item 10
  (clave del dispositivo por CertEnroll en vez de CngKey.Create asociada a
  mano, porque Schannel rechazaba esa via en EAP-TLS con 0x8009030D pese a
  firmar/verificar bien -verificado con un handshake TLS mutuo real-):
  `CertificateEnrollmentService` genera la clave (TPM primero, con
  confirmacion para caer a software) y el CSR con CertEnroll (COM) e
  instala la respuesta de EST con `CX509Enrollment.InstallResponse`, todo
  en un hilo STA dedicado. Rama `feat/vpn-12.7-windows-rendimiento`,
  pendiente de revision. Faltan items 7 (filtrado EAP + RasDial no
  interactivo) y 11 (compilar 0.1.6 final). Detalle completo en el
  CHANGELOG.
- [x] **Prompt 12.6 (Windows: asociar la clave CNG sin exportarla)**: el
  alta con una clave de TPM fallaba siempre ("Clave no valida para utilizar
  en el estado especificado") porque `CopyWithPrivateKey` fuerza una
  exportacion que el TPM no permite. Nueva `AssociatePrivateKey`
  (`CertSetCertificateContextProperty`/`CERT_KEY_PROV_INFO_PROP_ID`), sin
  exportar la clave; verificado con un test real de TPM (no solo software)
  en una maquina con TPM disponible. Rama `feat/vpn-12.6-windows-cng`,
  pendiente de revision. Detalle completo en el CHANGELOG.
- [x] **Prompt 12 (app de Windows)**: `didev-vpn-windows`
  (`APPS/Windows/code/`), app de bandeja en C#/.NET 8 WinForms que gestiona
  la VPN IKEv2/EAP-TLS nativa de Windows (RAS/`VpnClient`, sin IPsec propio),
  en dos variantes (instalador MSI con WiX v5, portable de un solo `.exe`)
  desde el mismo codigo. Importa y verifica el perfil `.didevvpn` (variante
  `full`, con comprobacion de `keyId` ademas de la firma), alta y renovacion
  por EST con clave TPM (CNG) no exportable, version minima de app bloqueando
  tanto la renovacion como el alta (esta ultima tras `simpleenroll`, ya que
  `/status` exige TLS mutuo y el perfil no trae `minAppVersion`), y una
  desinstalacion del MSI que pregunta (si es interactiva) por el
  certificado/conexion del usuario actual y, solo si nadie mas en el equipo
  sigue usando la VPN, por retirar la raiz de confianza. En rama
  `feat/vpn-12-windows-wip`, pendiente de revision antes de fusionar en
  `vpn`. Detalle completo en el CHANGELOG.
