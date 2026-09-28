-- ---------------------------------------------------------------------------
-- Ampliacion de panel_vpn_devices (creada en sql/panel-schema-vpn.sql) para
-- la gestion de dispositivos VPN: dueno, modo de tunel y vida de certificado
-- propia por dispositivo (sobrescribe panel_vpn_settings cuando no es NULL).
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-devices.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente. Requiere que panel_vpn_devices ya exista y MariaDB
-- (ADD COLUMN IF NOT EXISTS, 10.0.2+).
-- ---------------------------------------------------------------------------

ALTER TABLE panel_vpn_devices
  ADD COLUMN IF NOT EXISTS owner VARCHAR(255) NULL DEFAULT NULL AFTER display_name,
  ADD COLUMN IF NOT EXISTS tunnel_mode ENUM('full', 'split') NOT NULL DEFAULT 'split',
  ADD COLUMN IF NOT EXISTS cert_days SMALLINT UNSIGNED NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS renew_after_days SMALLINT UNSIGNED NULL DEFAULT NULL;
