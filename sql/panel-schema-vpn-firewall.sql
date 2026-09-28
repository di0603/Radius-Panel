-- ---------------------------------------------------------------------------
-- Firewall de la VM VPN (192.168.10.29) generado desde el panel: permisos de
-- red por dispositivo y token de la puerta de enlace para descargar el
-- fichero nftables (GET /vpn/gateway/firewall.nft).
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-firewall.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente y NO destructiva (no borra tablas ni filas). Requiere
-- MariaDB (ADD COLUMN IF NOT EXISTS, 10.0.2+).
-- ---------------------------------------------------------------------------

--
-- Excepciones explicitas (marcadas por un admin, con aviso en el panel) al
-- bloqueo permanente de 192.168.10.28 (RADIUS) y 192.168.10.30 (MariaDB)
-- para los clientes VPN. Por defecto ambas en 0: bloqueado.
--
ALTER TABLE panel_vpn_devices
  ADD COLUMN IF NOT EXISTS allow_radius_host TINYINT(1) NOT NULL DEFAULT 0 AFTER enabled,
  ADD COLUMN IF NOT EXISTS allow_mariadb_host TINYINT(1) NOT NULL DEFAULT 0 AFTER allow_radius_host;

--
-- Solo se guarda el hash del token de la puerta de enlace (igual que los
-- tokens de alta EST): el valor en claro se ensena una unica vez al
-- generarlo o regenerarlo desde "Ajustes".
--
ALTER TABLE panel_vpn_settings
  ADD COLUMN IF NOT EXISTS gateway_token_sha256 CHAR(64) NULL DEFAULT NULL;

--
-- Permisos de red por dispositivo ("internet" = 0.0.0.0/0, "lan" = la red
-- local segun panel_vpn_settings.lan_cidr, "custom" = destino/protocolo/
-- puerto concretos). El acceso a EST (192.168.10.28, puerto EST_PORT) y el
-- bloqueo de RADIUS/MariaDB no se guardan aqui: se aplican siempre al
-- generar el fichero, ver server/src/services/vpnFirewall.ts.
--
CREATE TABLE IF NOT EXISTS panel_vpn_device_rules (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username    VARCHAR(32) NOT NULL,
  kind        ENUM('internet', 'lan', 'custom') NOT NULL,
  dest_cidr   VARCHAR(45) NULL DEFAULT NULL,
  protocol    ENUM('tcp', 'udp', 'any') NULL DEFAULT NULL,
  port        SMALLINT UNSIGNED NULL DEFAULT NULL,
  created_by  INT UNSIGNED NULL DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY username (username)
) ENGINE=InnoDB;
