-- ---------------------------------------------------------------------------
-- Reconciliacion de panel_vpn_devices con el modelo de CLAUDE.md (correccion
-- 4.5): username = vpn-<owner_user>-<device_label>, owner_user/device_label/
-- owner_name propios y `enabled` en vez del `status` anterior.
--
-- Solo hace falta si tu base de datos aplico una version anterior de
-- sql/panel-schema-vpn.sql. En una instalacion nueva, panel-schema-vpn.sql ya
-- crea la tabla correcta y este fichero es un no-op.
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-devices.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente. La gestion de dispositivos todavia no se ha desplegado en
-- produccion (no hay ningun dispositivo real dado de alta por el panel: el
-- unico existente, "vps", se creo a mano y no tiene fila en esta tabla), asi
-- que esta migracion recrea la tabla vacia con el esquema correcto. NO toca
-- radcheck/radreply/radusergroup ni radius.vpn_certificates.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS panel_vpn_devices;

CREATE TABLE panel_vpn_devices (
  id                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username          VARCHAR(32) NOT NULL,
  owner_user        VARCHAR(32) NOT NULL,
  device_label      VARCHAR(32) NOT NULL,
  owner_name        VARCHAR(128) NULL DEFAULT NULL,
  platform          ENUM('windows', 'android', 'linux') NOT NULL,
  tunnel_mode       ENUM('full', 'split') NOT NULL DEFAULT 'split',
  framed_ip         VARCHAR(15) NULL DEFAULT NULL,
  cert_days         INT NULL DEFAULT NULL,
  renew_after_days  INT NULL DEFAULT NULL,
  enabled           TINYINT(1) NOT NULL DEFAULT 1,
  notes             TEXT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY username (username),
  UNIQUE KEY framed_ip (framed_ip),
  KEY owner_user (owner_user)
) ENGINE=InnoDB;
