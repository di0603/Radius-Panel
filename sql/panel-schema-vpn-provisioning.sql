-- ---------------------------------------------------------------------------
-- Aprovisionamiento por perfil firmado (.didevvpn) para las apps propias
-- (Windows y Android): version minima de app soportada, publicada por
-- GET /.well-known/est/status para poder forzar actualizaciones.
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-provisioning.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente y NO destructiva (no borra tablas ni filas). Requiere
-- MariaDB (ADD COLUMN IF NOT EXISTS, 10.0.2+).
--
-- No hay tabla nueva para el perfil en si: se construye al vuelo a partir de
-- panel_vpn_settings + panel_pki_ca (cadena de CA) + el token de alta recien
-- generado, y se firma con la clave Ed25519 de VPN_PROFILE_SIGNING_KEY (fuera
-- de la base de datos, ver server/.env.example) - no hay nada que persistir.
-- ---------------------------------------------------------------------------

ALTER TABLE panel_vpn_settings
  ADD COLUMN IF NOT EXISTS min_app_version VARCHAR(32) NOT NULL DEFAULT '0.0.0';
