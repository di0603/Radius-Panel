-- ---------------------------------------------------------------------------
-- Ampliacion de panel_pki_ca para el ciclo de vida completo de la CA
-- intermedia de la VPN (generar CSR, importar el certificado firmado por la
-- raiz offline, rotacion y publicacion de CRL).
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-pki.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente. Requiere que panel_pki_ca ya exista (sql/panel-schema-vpn.sql)
-- y MariaDB (ADD COLUMN/INDEX IF NOT EXISTS, 10.0.2+).
--
-- Los MODIFY COLUMN relajan a NULL las columnas que antes eran NOT NULL:
-- ahora una fila de CA intermedia se crea en estado 'pending' (clave + CSR
-- generados) antes de tener certificado, serial ni vigencia — esos datos
-- llegan despues, al importar el certificado firmado. Ejecutar un MODIFY
-- COLUMN varias veces con la misma definicion es en si mismo idempotente.
--
-- La clave privada de la intermedia se cifra con PKI_MASTER_KEY (nunca en
-- claro, nunca en logs/auditoria) y solo existe para role='intermediate'; la
-- CA raiz es offline y el panel nunca tiene su clave privada.
-- ---------------------------------------------------------------------------

ALTER TABLE panel_pki_ca
  MODIFY COLUMN subject_cn VARCHAR(255) NULL DEFAULT NULL,
  MODIFY COLUMN serial VARCHAR(64) NULL DEFAULT NULL,
  MODIFY COLUMN not_before DATETIME NULL DEFAULT NULL,
  MODIFY COLUMN not_after DATETIME NULL DEFAULT NULL,
  MODIFY COLUMN cert_pem MEDIUMTEXT NULL DEFAULT NULL;

ALTER TABLE panel_pki_ca
  ADD COLUMN IF NOT EXISTS status ENUM('pending', 'active', 'retiring', 'retired')
    NOT NULL DEFAULT 'pending' AFTER role,
  ADD COLUMN IF NOT EXISTS private_key_encrypted MEDIUMTEXT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS csr_pem MEDIUMTEXT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spki_sha256 CHAR(64) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS issuer_serial VARCHAR(64) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS key_created_at DATETIME NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS imported_at DATETIME NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS crl_pem MEDIUMTEXT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS crl_number INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crl_last_generated_at DATETIME NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS crl_next_update DATETIME NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS created_by INT UNSIGNED NULL DEFAULT NULL,
  ADD INDEX IF NOT EXISTS role_status (role, status);

-- Las filas ya existentes (creadas por panel-schema-vpn.sql con active=1 y sin
-- `status`) pasan a 'active': si estan en la tabla es porque ya tenian
-- certificado. No afecta a instalaciones nuevas (la tabla se crea vacia).
UPDATE panel_pki_ca SET status = 'active' WHERE active = 1 AND cert_pem IS NOT NULL AND status = 'pending';
