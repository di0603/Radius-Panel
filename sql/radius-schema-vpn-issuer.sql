-- ---------------------------------------------------------------------------
-- Enlaza cada certificado de dispositivo con la CA intermedia que lo firmo
-- (radius_panel.panel_pki_ca.id), para poder regenerar la CRL correcta al
-- revocar. Corrige la correccion 4.5: la version anterior de este fichero
-- anadia `ca_serial VARCHAR(64)`; el modelo de CLAUDE.md pide `ca_id INT`.
--
--   mysql -u root -p radius < sql/radius-schema-vpn-issuer.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente. Requiere MariaDB (ADD/DROP COLUMN IF [NOT] EXISTS, 10.0.2+).
--
-- `ca_serial` nunca ha llegado a rellenarse con datos reales (no existe
-- todavia emision automatica de certificados de dispositivo), asi que
-- sustituirla por `ca_id` no pierde nada; tampoco toca la fila de prueba
-- "vps" (queda con ca_id NULL, como con ca_serial).
--
-- NULL significa "no emitido por una intermedia gestionada por el panel": el
-- modulo de emision de certificados de dispositivo (pendiente, ver ideas.md)
-- es quien rellena esta columna al firmar.
-- ---------------------------------------------------------------------------

ALTER TABLE vpn_certificates
  ADD COLUMN IF NOT EXISTS ca_id INT NULL DEFAULT NULL,
  DROP COLUMN IF EXISTS ca_serial,
  ADD INDEX IF NOT EXISTS ca_id (ca_id);
