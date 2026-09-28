-- ---------------------------------------------------------------------------
-- Emision de certificados Android desde el panel (excepcion documentada: la
-- app de strongSwan para Android no sabe renovarse sola por EST, asi que
-- aqui es el panel quien genera la clave y la entrega una unica vez).
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-android.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente y NO destructiva (no borra tablas ni filas). Requiere
-- MariaDB (ADD COLUMN IF NOT EXISTS, 10.0.2+).
-- ---------------------------------------------------------------------------

--
-- Red local desde la que se puede usar el enlace de descarga del .p12 de
-- Android (ademas del rango de la VPN, panel_vpn_settings.pool_start/end).
--
ALTER TABLE panel_vpn_settings
  ADD COLUMN IF NOT EXISTS lan_cidr VARCHAR(18) NOT NULL DEFAULT '192.168.10.0/24' AFTER pool_end;

--
-- Estado de un "Emitir certificado" pendiente de descargar: el .p12 (ya
-- protegido con su propia contrasena de 20 caracteres, mostrada una unica
-- vez en el panel) se cifra ademas en reposo con PKI_MASTER_KEY. El enlace
-- de descarga es de un solo uso (token_sha256, nunca se guarda en claro),
-- caduca a los 15 minutos y se borra -junto con esta fila- nada mas
-- descargarse. Sin proceso que la limpie, una fila caducada sin descargar
-- se purga a diario (ver server/src/services/androidCert.ts).
--
CREATE TABLE IF NOT EXISTS panel_vpn_android_downloads (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username       VARCHAR(32) NOT NULL,
  serial         VARCHAR(64) NOT NULL,
  token_sha256   CHAR(64) NOT NULL,
  p12_encrypted  MEDIUMTEXT NOT NULL,
  created_by     INT UNSIGNED NULL DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at     DATETIME NOT NULL,
  downloaded_at  DATETIME NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY token_sha256 (token_sha256),
  KEY username (username)
) ENGINE=InnoDB;
