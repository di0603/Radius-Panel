-- ---------------------------------------------------------------------------
-- Enlaza cada certificado de dispositivo con el serial de la CA intermedia
-- que lo firmo, para poder regenerar la CRL correcta al revocar (ver
-- sql/panel-schema-vpn-pki.sql, panel_pki_ca.serial, en la base del panel).
--
--   mysql -u root -p radius < sql/radius-schema-vpn-issuer.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente. Requiere MariaDB (ADD COLUMN/INDEX IF NOT EXISTS, 10.0.2+).
--
-- NULL (el valor por defecto, y el de cualquier fila existente como la del
-- dispositivo de prueba 'vps', firmado directamente por la raiz) significa
-- "no emitido por una intermedia gestionada por el panel": revocar ese
-- certificado no regenera ninguna CRL automaticamente. El modulo de emision
-- de certificados de dispositivo (pendiente, ver ideas.md) es quien rellena
-- esta columna al firmar.
-- ---------------------------------------------------------------------------

ALTER TABLE vpn_certificates
  ADD COLUMN IF NOT EXISTS ca_serial VARCHAR(64) NULL DEFAULT NULL,
  ADD INDEX IF NOT EXISTS ca_serial (ca_serial);
