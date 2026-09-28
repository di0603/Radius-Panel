Este repositorio es Radius Panel: API en Node + TypeScript + Express (server/) y SPA en React + Vite + Mantine + TanStack Query (web/), sobre las tablas SQL estandar de FreeRADIUS (base `radius`) y una base propia (`radius_panel`).

Vamos a anadir, en varias sesiones, la gestion de una VPN IKEv2 (strongSwan) con autenticacion EAP-TLS: el panel sera la CA emisora de los certificados de dispositivo y ofrecera alta y renovacion automatica por EST (RFC 7030).

Arquitectura de la VPN (no la cambies):
- strongSwan en 192.168.10.29 reenvia el EAP a FreeRADIUS en 192.168.10.28 (virtual server `vpn`, modulo `eap_vpn` solo TLS). MariaDB en 192.168.10.30.
- FreeRADIUS valida la cadena hasta una CA raiz offline, la CRL de la CA intermedia y que el serial del certificado este activo en la tabla `vpn_certificates` de la base `radius`.
- Cada dispositivo es un usuario RADIUS cuyo username es el CN de su certificado. Su IP fija (Framed-IP-Address en radreply) sale del rango 192.168.10.75-192.168.10.99. Pertenece al grupo `vpn`.
- La WiFi usa el mismo FreeRADIUS con PEAP-MSCHAPv2: nada de lo que hagamos puede cambiar su comportamiento.

Reglas para todo el trabajo:
- Sigue las convenciones existentes: rutas en server/src/routes con zod + asyncHandler + requireAuth/requireRole; logica en server/src/services; writeAudit en toda escritura; config nueva validada con zod en server/src/config.ts y documentada en .env.example y README; migraciones como ficheros .sql idempotentes en sql/ y registradas en el menu (npm run menu); hooks de datos en web/src/api/hooks.ts; paginas con PageHeader/SectionCard; textos en espanol sin tildes en el codigo, como el resto del proyecto.
- Las operaciones de PKI y de dispositivos VPN son solo para el rol `admin`.
- Nunca registres en logs, auditoria ni respuestas: claves privadas, tokens de alta, contrasenas de .p12 ni la PKI_MASTER_KEY.
- Tests con node:test para toda la logica nueva; npm run typecheck, npm test y npm run build deben pasar al terminar.
- Actualiza CHANGELOG.md e ideas.md (marca lo hecho) en cada entrega.
- Si algo de lo que pido es inseguro o contradice RFC 7030 / RFC 5280, dimelo antes de implementarlo.

Flujo de git (obligatorio):
- El panel se despliega solo desde main cada 2 minutos en 192.168.10.28: NUNCA hagas commit ni push directamente a main ni fusiones nada en main, SALVO cuando el prompt sea explicitamente un "Despliegue - hito N"; en ese caso sigue exactamente sus pasos y nada mas.
- Todo el trabajo de la VPN se integra en la rama vpn (creala desde main si no existe). Cada prompt se hace en su propia rama feat/vpn-<numero>-<tema> creada desde vpn.
- Al terminar cada prompt, y solo cuando npm run typecheck, npm test y npm run build pasen, haz un commit con todos los cambios de ese prompt, con mensaje en formato Conventional Commits en espanol, por ejemplo: feat(vpn): prompt 2 - modulo PKI. El cuerpo del commit resume que se ha hecho, que tests se anadieron y cualquier decision o limitacion.
- Si el trabajo de un prompt es largo, puedes hacer commits intermedios en la misma rama, pero el ultimo debe dejar todo en verde.
- No incluyas nunca en un commit ficheros .env, claves, certificados privados, tokens ni volcados de base de datos.
- Al terminar, dime el nombre de la rama y el hash del ultimo commit, y abre (o preparame) la pull request contra vpn.
- El autodeploy de la .28 (systemd timer cada 2 minutos) solo hace git pull + build + restart: NUNCA aplica migraciones .sql. Por eso, el resumen final de cada "Despliegue - hito N" tiene que listar, en orden, que opciones exactas de "npm run menu -> Esquema / migraciones" hay que ejecutar a mano en la .28 despues del merge (y en que base, radius o radius_panel), ademas de cualquier otro paso posterior (unidades systemd nuevas, variables de entorno, certificados en disco).

Modelo de datos (usalo tal cual; si necesitas algo mas, preguntame):
- radius.vpn_certificates: id, username VARCHAR(64) (= CN), serial VARCHAR(64) (hex minusculas, sin separadores, UNIQUE), spki_sha256 CHAR(64) UNIQUE, ca_id INT NULL (CA que lo firmo; NULL = firmado por la raiz), not_before DATETIME, not_after DATETIME (ambos UTC), status ENUM('active','superseded','revoked'), superseded_until DATETIME NULL, revoked_at DATETIME NULL, revoke_reason VARCHAR(32) NULL, created_at. FreeRADIUS solo tiene SELECT.
- radius_panel.panel_vpn_devices: id, username VARCHAR(32) UNIQUE (vpn-<owner_user>-<device_label>), owner_user VARCHAR(32), device_label VARCHAR(32), owner_name VARCHAR(128) NULL, platform ENUM('windows','android','linux'), tunnel_mode ENUM('full','split'), framed_ip VARCHAR(15) UNIQUE, cert_days INT NULL y renew_after_days INT NULL (sobrescriben los generales), enabled TINYINT, notes TEXT NULL, created_at, updated_at.
- radius_panel.panel_vpn_enroll_tokens: id, username, token_sha256 CHAR(64) UNIQUE, expires_at, used_at NULL, created_by (id de admin), created_at. Nunca se guarda el token en claro.
- radius_panel.panel_pki_ca: una fila por CA intermedia: status (pending/active/retiring/retired), subject, serial, spki_sha256, cert_pem, root_cert_pem, csr_pem, private_key_encrypted (AES-256-GCM con clave derivada de PKI_MASTER_KEY), not_before, not_after, crl_pem, crl_number, crl_next_update, created_at, updated_at.
- radius_panel.panel_vpn_settings: fila unica id=1: vpn_fqdn 'vpn.vlc.didev.es', aaa_id 'CN=radius.vpn.vlc.didev.es', pool_start '192.168.10.75', pool_end '192.168.10.99', dns (IP o vacio), device_cert_days 30, renew_after_days 20, overlap_hours 48, android_cert_days 365, est_url 'https://pki.vlc.didev.es:8443'.
- Filas RADIUS de cada dispositivo (base radius): radcheck Service-Type == Framed-User; radreply Framed-IP-Address := <framed_ip>; radusergroup groupname 'vpn'. Desactivar = anadir en radcheck Auth-Type := Reject (mecanismo ya existente del panel).

Criptografia (no la cambies sin preguntar): toda la PKI es ECDSA. Raiz offline ECDSA P-384 / SHA-384. CA intermedia ECDSA P-384 / SHA-384, BasicConstraints CA:true pathLenConstraint=0, KeyUsage keyCertSign+cRLSign, EKU solo clientAuth. Certificados de dispositivo ECDSA P-256 o P-384 (RSA >= 3072 solo por compatibilidad), EKU clientAuth, SAN dNSName = CN.

Estado real del sistema a tener en cuenta:
- La VPN ya funciona de extremo a extremo con un dispositivo de prueba 'vps' creado a mano (IP 192.168.10.77, certificado firmado directamente por la raiz). El panel no debe romperlo; se retirara cuando exista la CA intermedia.
- Lecciones de la puesta en marcha que el codigo debe respetar: (1) cada dispositivo necesita en radcheck la fila Service-Type == Framed-User, porque sin ninguna fila en radcheck rlm_sql no aplica radreply; (2) los certificados de dispositivo llevan SAN dNSName = CN, porque strongSwan busca el certificado del cliente por el SAN; (3) todas las fechas de vpn_certificates en UTC; (4) los nombres de dispositivo llevan prefijo vpn- para no chocar con cuentas de la WiFi; (5) los clientes deben configurar la identidad AAA CN=radius.vpn.vlc.didev.es para validar el certificado de FreeRADIUS.