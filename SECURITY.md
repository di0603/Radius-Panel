# Seguridad

Este documento cubre el modulo VPN (CA propia + EST, ver la seccion "VPN y
certificados" del `README.md` para la arquitectura y la puesta en marcha):
modelo de amenazas, copias de seguridad de la PKI y el procedimiento si hay
que revocar la CA intermedia. El resto de medidas de seguridad del panel
(sesiones, 2FA, bloqueo de cuenta...) esta en las "Notas de seguridad" del
`README.md`.

Para reportar un problema de seguridad, contacta directamente con quien
mantiene este repositorio; no abras un issue publico con detalles de una
vulnerabilidad sin explotar todavia.

## Modelo de amenazas

### 1. El panel esta comprometido (RCE o una sesion de admin robada)

**Que consigue el atacante:** con el proceso del servidor comprometido, puede
llamar a cualquier funcion del modulo VPN con los mismos privilegios que la
propia API: firmar certificados de dispositivo (mientras haya una CA
intermedia activa), generar tokens de alta y enlaces de descarga de Android,
revocar o dar de baja dispositivos, y leer `PKI_MASTER_KEY` del entorno del
proceso (con eso, descifrar la clave privada de la intermedia en memoria).
Una sesion de admin robada (sin RCE) da lo mismo salvo leer variables de
entorno directamente, pero puede hacer todo lo anterior via la API/UI.

**Que NO consigue:** la clave privada de la **raiz** nunca esta en este
servidor (es offline por diseno); comprometer el panel no permite fabricar
una CA intermedia nueva que FreeRADIUS acepte sin comprometer tambien la raiz.

**Mitigacion:**
- Todas las rutas de PKI/dispositivos exigen `requireAuth` + `requireRole('admin')`.
- Auditoria completa (`panel_audit_log`) de toda escritura, sin secretos.
- 2FA + bloqueo de cuenta + rotacion de refresh tokens (ver README) reducen
  la probabilidad de que una sesion de admin se robe en primer lugar.
- Si se confirma el compromiso: ver "Procedimiento si hay que revocar la CA
  intermedia" mas abajo — asume que la intermedia activa esta comprometida.

### 2. Se filtra un token de alta EST

**Que consigue el atacante:** dar de alta (`simpleenroll`) el dispositivo al
que pertenece ese token, en la ventana antes de que expire o de que el
dispositivo legitimo lo use — suplantandolo si consigue enrolarse primero.

**Mitigacion:**
- Un solo uso, reclamado atomicamente (`UPDATE ... WHERE used_at IS NULL AND
  expires_at > NOW()`; `server/src/services/est.ts:claimEnrollToken`): dos
  intentos con el mismo token nunca tienen exito los dos.
- Caduca a las 24h; solo se guarda su hash SHA-256, nunca en claro
  (`panel_vpn_enroll_tokens.token_sha256`).
- Generar uno nuevo invalida el anterior sin usar (`generateEnrollToken`
  borra cualquier pendiente del mismo dispositivo).
- Si se sospecha una filtracion: genera un token nuevo desde la ficha del
  dispositivo antes de que el atacante lo use.

### 3. Se roba el certificado de un dispositivo (clave privada exfiltrada)

**Que consigue el atacante:** autenticarse como ese dispositivo en la VPN
(IKEv2/EAP-TLS) y renovarse por `simplereenroll` mientras el certificado
siga `active` y no haya pasado el limite de frecuencia.

**Mitigacion:**
- Windows: la clave se genera en el TPM (`enroll.ps1`, `Exportable = false`)
  y no es exportable ni con acceso administrativo al disco (si no hay TPM,
  usa el proveedor de software de Windows, que tampoco permite exportarla,
  aunque no vive en un chip separado).
- Linux/VPS: fichero con permisos `600`, propiedad de quien ejecuta
  `vpn-enroll`/`vpn-renew` (normalmente root) — el riesgo real es el mismo
  host, no la red.
- Ante la sospecha de robo: **Panel → VPN > Dispositivos → ficha → "Revocar
  certificado"**. Anade el serial a la CRL de su CA (regenerada al momento) y
  desconecta la sesion activa (CoA) si la tiene.
- La renovacion automatica limita el dano si el robo no se detecta enseguida:
  el certificado dura como mucho `deviceCertDays` (por defecto 30) y el
  anterior queda `superseded` (no revocado) solo durante `overlapHours` (48h)
  tras cada renovacion.

### 4. Se pierde o roban el dispositivo fisico (con una sesion activa o valida)

**Mitigacion — dos acciones independientes, normalmente las dos:**
- **Desactivar** (`PATCH .../enabled`): anade `Auth-Type := Reject` en
  `radcheck` (mismo mecanismo que el resto del panel) y desconecta la sesion
  activa por CoA. Reversible.
- **Revocar el certificado** (ver punto 3): irreversible para ese
  certificado concreto (hay que volver a dar de alta el dispositivo con un
  token nuevo para que vuelva a funcionar).
- **Dar de baja** (`DELETE /vpn-devices/:username`): revoca todos los
  certificados activos, desconecta la sesion, borra las filas RADIUS (libera
  la IP) y conserva el historial de certificados. Para cuando el dispositivo
  no va a volver a usarse.

### 5. El VPS (192.168.10.28: panel + FreeRADIUS) esta comprometido

**Que consigue el atacante:** acceso a las dos bases de datos y a
`PKI_MASTER_KEY` (vive en `server/.env`, en ese mismo disco). Con eso puede
descifrar la clave privada de la CA intermedia activa y firmar certificados
de dispositivo arbitrarios mientras esa intermedia siga siendo de confianza
para FreeRADIUS — es decir, tiene todo lo que tendria un admin del panel, y
ademas el material que el panel normalmente no expone en ninguna respuesta
HTTP (la clave privada descifrada). **No** consigue la clave de la raiz
(offline, en otra maquina que no es esta).

**Mitigacion:**
- La raiz offline limita el radio del compromiso: el atacante no puede emitir
  una CA intermedia *nueva* que FreeRADIUS vaya a aceptar sin acceso tambien
  a la raiz.
- Trata este escenario como "intermedia comprometida": sigue el
  procedimiento de revocacion mas abajo.
- Copias de seguridad separadas de `panel_pki_ca` y de `PKI_MASTER_KEY` (ver
  la seccion siguiente) para poder reconstruir la PKI en una maquina limpia
  sin depender del VPS comprometido.

### 6. Solo la base de datos esta comprometida (sin acceso al servidor de la app)

**Que consigue el atacante con un volcado o acceso de solo lectura/escritura
a MySQL, pero sin `PKI_MASTER_KEY` (que no vive en ninguna tabla):**
- **No** puede descifrar `panel_pki_ca.private_key_encrypted` (AES-256-GCM
  bajo una clave derivada de `PKI_MASTER_KEY` con scrypt; ver
  `server/src/lib/pkiCrypto.ts`) ni el `.p12` de Android en transito
  (`panel_vpn_android_downloads.p12_encrypted`, cifrado con el mismo
  mecanismo). Ver tambien el punto 5: los dos secretos (BD y master key)
  estan deliberadamente separados para que ninguno de los dos por si solo
  comprometa la clave privada de la CA.
- **No** puede reutilizar los tokens de alta ni los enlaces de descarga de
  Android: solo se guarda su hash SHA-256 (256 bits de entropia en el token
  original — no son contrasenas de usuario, no tiene sentido intentar
  invertirlo por fuerza bruta).
- **Si** puede leer metadatos (usernames, IPs asignadas, fechas, estado de
  cada certificado) y, con acceso de escritura, manipular filas directamente
  — por ejemplo, poner `status = 'active'` en un certificado ya revocado.
  Esto **no** basta para autenticarse como ese dispositivo (FreeRADIUS
  tambien verifica la firma criptografica de la cadena hasta la raiz, que no
  se falsifica editando una fila), pero si el atacante *ademas* tiene la
  clave privada de ese certificado concreto (robo del punto 3), reactivarlo
  por SQL le devolveria el acceso sin pasar por el panel.

**Mitigacion:**
- Credenciales de MySQL con el privilegio minimo necesario, distintas de las
  del sistema operativo del VPS.
- Backups de la base de datos por separado de `PKI_MASTER_KEY` (nunca en el
  mismo sitio), para que un volcado de BD filtrado no sea, por si solo,
  suficiente para nada critico.

## Buenas practicas ya aplicadas en el codigo (referencia rapida)

- **Sin secretos en logs/auditoria/respuestas**: tokens de alta, contrasenas
  de `.p12`, tokens de descarga y la clave privada de la CA nunca se
  auditan ni se logean (comentarios explicitos en cada punto del codigo que
  los maneja); el logger (`pino`) redacta ademas `authorization`, `cookie` y
  cualquier campo `password`/`secret`/`token` por si se coloran en algun otro
  log.
- **Comparaciones en tiempo constante** para secretos de longitud fija
  (`safeEqual`, `node:crypto.timingSafeEqual`) donde se compara un secreto
  en memoria de Node contra otro (token de la puerta de enlace del
  firewall). Los tokens de alta/descarga/EST se comparan por su hash SHA-256
  dentro de la propia consulta SQL (`WHERE token_sha256 = ?`): el iguale lo
  hace el motor de MySQL, no una comparacion de cadenas en JS.
- **Consumo atomico de un solo uso**: tokens de alta EST y enlaces de
  descarga de Android se reclaman con un `UPDATE ... WHERE usado_at IS NULL
  AND expires_at > NOW()`, aceptando solo la peticion cuyo `UPDATE` afecta a
  1 fila — dos peticiones simultaneas con el mismo secreto nunca tienen
  exito las dos.
- **`simplereenroll` es atomico de verdad**: localiza y bloquea
  (`SELECT ... FOR UPDATE`) las filas del dispositivo dentro de una
  transaccion antes de comprobar reutilizacion de clave y el limite de
  frecuencia, para que dos renovaciones concurrentes del mismo dispositivo
  no puedan tener exito las dos.
- **Asignacion de IP tambien bloqueada** (`FOR UPDATE` sobre las filas de
  `radreply` leidas antes de elegir la primera libre): sin esto, dos altas
  de dispositivo simultaneas podian elegir la misma IP.
- **TLS del listener EST**: `TLSv1.2` como minimo, solo cifrados
  ECDHE+AEAD (GCM/ChaCha20-Poly1305), certificado propio firmado por la raiz
  offline (no el almacen de confianza general del sistema).
- **Limite de tamano de peticion**: 512 KB en la API principal, 64 KB en el
  cuerpo (CSR) de EST.
- **Todo SQL parametrizado** (`:nombre` o `?`), nunca concatenacion de
  entrada del usuario.
- **CN, no todo el subject del CSR**: el certificado emitido lleva solo
  `CN=<username validado>` como subject (nunca el subject completo que pida
  el CSR), y el SAN `dNSName` que usa strongSwan para identificar al cliente
  lo fija siempre el servidor, nunca el dispositivo.

## Copias de seguridad y restauracion

`panel_pki_ca` y `PKI_MASTER_KEY` se respaldan **por separado** y nunca
deben acabar juntos en el mismo sitio (una copia de la base de datos que
incluya `panel_pki_ca` sin `PKI_MASTER_KEY` no sirve para descifrar nada por
si sola — es la proteccion que da tenerlos separados; guardarlos juntos la
anula).

### `panel_pki_ca` (incluye la clave privada de la intermedia, ya cifrada)

- **Copia**: incluida en cualquier backup normal de la base `radius_panel`
  (`mysqldump radius_panel panel_pki_ca ...` o el backup completo de la
  base). El contenido de `private_key_encrypted` ya es AES-256-GCM en reposo,
  pero trata igualmente este backup como material sensible (rotar/aplicar
  ACLs de acceso igual que al resto de la base).
- **Restauracion**: restaura la tabla tal cual. La fila `active` se usa para
  firmar; si tras restaurar hay mas de una fila `active` (no deberia poder
  pasar por el codigo, pero si se ha editado la base a mano), corrige a mano
  antes de reiniciar el panel — `getActiveIntermediate()` exige que haya
  como maximo una.
- **Importante**: la restauracion solo funciona si `PKI_MASTER_KEY` en
  `server/.env` es **exactamente** la misma que cifro esa fila. Si
  `PKI_MASTER_KEY` cambio despues de la fecha del backup, la clave privada
  restaurada no se podra descifrar (ver el punto siguiente).

### `PKI_MASTER_KEY`

- **Nunca vive en la base de datos ni en git**: solo en `server/.env` de
  cada entorno. Guarda una copia en un gestor de secretos (no en el mismo
  sitio que los backups de la base de datos, ni en el mismo ticket/chat
  donde se comparta un volcado).
- **No tiene copia de seguridad "automatica"**: si se pierde sin haber
  guardado una copia aparte, la clave privada de la CA intermedia activa (y
  la de cualquier `.p12` de Android todavia sin descargar) queda
  **irrecuperable** — no hay ninguna puerta trasera ni forma de derivarla de
  nuevo. La unica salida es generar una CA intermedia nueva (ver el
  procedimiento de abajo, mismos pasos que si estuviera comprometida) y
  volver a dar de alta cada dispositivo.
- **Si necesitas rotarla** (buena practica periodica, no solo ante un
  incidente): no hay hoy una migracion que re-cifre `panel_pki_ca` con una
  clave nueva. Hazlo en este orden para no perder la clave privada actual:
  1. Antes de cambiar `PKI_MASTER_KEY` en `server/.env`, descifra y vuelve a
     cifrar a mano la fila `private_key_encrypted` con la clave nueva (usando
     `decryptPkiPrivateKey`/`encryptPkiPrivateKey` de
     `server/src/lib/pkiCrypto.ts` desde un script puntual, o reimportando la
     intermedia desde cero si tienes su clave privada en otro sitio).
  2. Actualiza `server/.env` y reinicia solo despues de que la fila ya este
     re-cifrada con la clave nueva.
  3. Sin este paso, el panel arranca igual pero la firma con la intermedia
     existente falla al primer intento (`decryptPkiPrivateKey` lanza: el
     `authTag` de GCM no valida con la clave equivocada).

## Procedimiento si hay que revocar la CA intermedia

Usa esto cuando se sospeche que la clave privada de la CA intermedia
**activa** esta comprometida (VPS comprometido, `PKI_MASTER_KEY` filtrada,
etc.) — no para una rotacion rutinaria por caducidad (esa la cubre
"Puesta en marcha de la CA intermedia" del README, sin nada de esto).

Importante: en este diseno, revocar una intermedia **no** es "una CRL de la
raiz que la liste" (la raiz offline no publica CRL de intermedias en este
modelo) — la proteccion real es que FreeRADIUS exige ademas que el serial de
cada certificado de dispositivo este `active` en `radius.vpn_certificates`
(ver `CLAUDE.md`). Revocar la intermedia, en la practica, significa **revocar
en bloque todos los certificados que emitio** y dejar de usarla para firmar.
Hoy esto ultimo requiere SQL directo (no hay un boton "revocar todo" en el
panel; queda anotado en `ideas.md` como mejora pendiente).

1. **Emite una CA intermedia nueva primero**, para minimizar el tiempo sin
   VPN: Panel → PKI → "Generar CA intermedia" → firma offline con la raiz →
   "Importar certificado" (ver el README). Esto deja la comprometida en
   `retiring` automaticamente.
2. **Revoca en bloque todos los certificados de la CA comprometida** (sustituye
   `<id>` por el id de esa fila en `panel_pki_ca`):
   ```sql
   UPDATE vpn_certificates
      SET status = 'revoked', revoked_at = UTC_TIMESTAMP(), revoke_reason = 'ca-compromised'
    WHERE ca_id = <id> AND status IN ('active', 'superseded');
   ```
   (Ejecutalo en la base `radius`, con el mismo usuario que usa el panel.)
3. **Regenera la CRL de esa CA** para que la revocacion en bloque se publique
   ya mismo (evita esperar al ciclo normal de `vpn:jobs`): Panel → PKI →
   ficha de esa intermedia → "Regenerar CRL" (o `POST
   /api/pki/intermediate/<id>/regenerate-crl`).
4. **Marca la CA como `retired`** una vez que su CRL ya no haga falta (no hay
   ruta para esto en la UI todavia; a mano):
   ```sql
   UPDATE panel_pki_ca SET status = 'retired' WHERE id = <id>;
   ```
5. **Re-enrola cada dispositivo afectado**: como sus certificados ya estan
   `revoked` (no solo `superseded`), no pueden renovarse por `simplereenroll`
   (lo rechaza `assertCertificateRowActive`). Genera un token de alta nuevo
   para cada uno (ficha del dispositivo → "Generar token de alta") y repite
   el alta por `simpleenroll` con la CA nueva — para Windows/Linux, basta con
   volver a ejecutar `enroll.ps1`/`vpn-enroll` del paquete de conexion (ya
   descargado) con el token nuevo; para Android, "Emitir certificado" otra
   vez.
6. **Revisa la auditoria** (`panel_audit_log`, filtrando por
   `vpn_pki_intermediate`/`vpn_device_certificate`) para confirmar que no
   quedo ningun certificado de esa CA sin revocar y documentar el incidente
   (cuando se detecto, que dispositivos se vieron afectados, cuando se
   completo el re-enrolado).
7. Si el compromiso fue del propio VPS (no solo de la clave), sigue ademas
   los pasos habituales de respuesta a incidentes del servidor (rotar
   credenciales de MySQL, `JWT_SECRET`, revisar accesos, reinstalar si hace
   falta) antes de volver a poner el panel en produccion.
