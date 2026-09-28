-- ---------------------------------------------------------------------------
-- Certificados de dispositivo de la VPN IKEv2/EAP-TLS, en la base de FreeRADIUS.
--
--   mysql -u root -p radius < sql/radius-schema-vpn.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente. Requiere MariaDB (ADD COLUMN/INDEX IF NOT EXISTS, 10.0.2+).
--
-- IMPORTANTE: en el entorno real esta tabla ya existe, creada a mano con este
-- mismo esquema, y contiene una fila de prueba para el dispositivo 'vps'
-- (192.168.10.77). El CREATE TABLE de abajo es un no-op alli (la tabla ya
-- existe); en una instalacion nueva la crea entera. Los ALTER que siguen solo
-- completan columnas/indices que pudieran faltar, sin tocar filas existentes.
--
-- username    : igual al CN del certificado de dispositivo (con prefijo vpn-).
-- serial      : serial del certificado en hexadecimal minuscula, sin separadores.
-- spki_sha256 : huella SHA-256 de la SubjectPublicKeyInfo, para detectar
--               reutilizacion de clave entre certificados.
-- status      : 'active' (vigente), 'superseded' (renovado, se acepta durante
--               el solape hasta superseded_until) o 'revoked'.
--
-- FreeRADIUS (virtual server `vpn`) solo necesita SELECT para comprobar que el
-- serial presentado sigue activo:
--   GRANT SELECT ON radius.vpn_certificates TO 'radius'@'192.168.10.28';
--   FLUSH PRIVILEGES;
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vpn_certificates (
  id               INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username         VARCHAR(64) NOT NULL,
  serial           VARCHAR(64) NOT NULL,
  spki_sha256      CHAR(64) NOT NULL,
  not_before       DATETIME NOT NULL,
  not_after        DATETIME NOT NULL,
  status           ENUM('active', 'superseded', 'revoked') NOT NULL DEFAULT 'active',
  superseded_until DATETIME NULL DEFAULT NULL,
  revoked_at       DATETIME NULL DEFAULT NULL,
  revoke_reason    VARCHAR(32) NULL DEFAULT NULL,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY serial (serial),
  UNIQUE KEY spki_sha256 (spki_sha256),
  KEY username_status (username, status)
) ENGINE=InnoDB;

ALTER TABLE vpn_certificates
  ADD COLUMN IF NOT EXISTS spki_sha256 CHAR(64) NOT NULL DEFAULT '' AFTER serial,
  ADD COLUMN IF NOT EXISTS superseded_until DATETIME NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS revoked_at DATETIME NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS revoke_reason VARCHAR(32) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD UNIQUE INDEX IF NOT EXISTS serial (serial),
  ADD UNIQUE INDEX IF NOT EXISTS spki_sha256 (spki_sha256),
  ADD INDEX IF NOT EXISTS username_status (username, status);
