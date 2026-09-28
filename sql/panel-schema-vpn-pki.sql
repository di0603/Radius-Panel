-- ---------------------------------------------------------------------------
-- Reconciliacion de panel_pki_ca con el modelo de CLAUDE.md (correccion 4.5):
-- una fila por CA intermedia, con `subject`/`root_cert_pem` en vez del
-- esquema anterior (`role`/`subject_cn`/CA raiz como fila propia).
--
-- Solo hace falta si tu base de datos aplico la version anterior de
-- sql/panel-schema-vpn.sql. En una instalacion nueva, panel-schema-vpn.sql ya
-- crea la tabla correcta y esto es practicamente un no-op (anade y vuelve a
-- quitar un par de columnas obsoletas, sin filas que migrar).
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-pki.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente y NO destructiva: nunca borra tablas ni filas (correccion
-- 4.6). Para poder convertir una fila vieja sin perder datos, primero se
-- garantiza que las columnas antiguas existan (ADD COLUMN IF NOT EXISTS: no
-- hace nada si ya estaban, y si esto es una instalacion nueva sin ellas, las
-- crea vacias para que las siguientes sentencias sean validas sin importar
-- el estado de partida) y solo despues se copian datos y se retiran.
--
-- Si existia una fila role='root' (esquema anterior), su certificado se
-- copia al `root_cert_pem` de la(s) fila(s) intermedia(s) y la fila de la
-- raiz se marca como 'retired' (no se borra: revocar/reactivar a mano si
-- hiciera falta recuperar algo de ella).
-- ---------------------------------------------------------------------------

ALTER TABLE panel_pki_ca
  ADD COLUMN IF NOT EXISTS role ENUM('root', 'intermediate') NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS subject_cn VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS subject VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS root_cert_pem MEDIUMTEXT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS status ENUM('pending', 'active', 'retiring', 'retired')
    NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS private_key_encrypted MEDIUMTEXT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS csr_pem MEDIUMTEXT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS spki_sha256 CHAR(64) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS crl_pem MEDIUMTEXT NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS crl_number INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS crl_next_update DATETIME NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ON UPDATE CURRENT_TIMESTAMP;

-- subject_cn -> subject (el modelo usa "subject").
UPDATE panel_pki_ca SET subject = subject_cn WHERE subject IS NULL AND subject_cn IS NOT NULL;

-- Copia el certificado de la fila de la raiz (si la habia) a la(s) fila(s)
-- de la intermedia, que es donde vive ahora (una fila por intermedia, la
-- raiz duplicada dentro).
UPDATE panel_pki_ca AS intermedia
  JOIN panel_pki_ca AS raiz ON raiz.role = 'root'
  SET intermedia.root_cert_pem = raiz.cert_pem
  WHERE intermedia.role = 'intermediate' AND intermedia.root_cert_pem IS NULL;

-- La fila de la raiz ya no encaja en el modelo (una fila = una intermedia):
-- se retira en vez de borrarse, para no perder el historial.
UPDATE panel_pki_ca SET status = 'retired' WHERE role = 'root';

-- Relaja a NULL las columnas que en el esquema original (prompt 1) eran
-- NOT NULL: ahora una fila puede estar en 'pending' (clave+CSR generados)
-- antes de tener certificado, serial ni vigencia.
ALTER TABLE panel_pki_ca
  MODIFY COLUMN subject VARCHAR(255) NULL DEFAULT NULL,
  MODIFY COLUMN serial VARCHAR(64) NULL DEFAULT NULL,
  MODIFY COLUMN not_before DATETIME NULL DEFAULT NULL,
  MODIFY COLUMN not_after DATETIME NULL DEFAULT NULL,
  MODIFY COLUMN cert_pem MEDIUMTEXT NULL DEFAULT NULL;

-- Columnas del esquema anterior que ya no forman parte del modelo. DROP
-- COLUMN no borra tablas ni filas, solo retira campos ya migrados arriba.
ALTER TABLE panel_pki_ca
  DROP COLUMN IF EXISTS role,
  DROP COLUMN IF EXISTS subject_cn,
  DROP COLUMN IF EXISTS crl_url,
  DROP COLUMN IF EXISTS active,
  DROP COLUMN IF EXISTS issuer_serial,
  DROP COLUMN IF EXISTS key_created_at,
  DROP COLUMN IF EXISTS imported_at,
  DROP COLUMN IF EXISTS crl_last_generated_at,
  DROP COLUMN IF EXISTS created_by,
  DROP INDEX IF EXISTS role_active,
  DROP INDEX IF EXISTS role_status,
  ADD UNIQUE INDEX IF NOT EXISTS serial (serial),
  ADD UNIQUE INDEX IF NOT EXISTS spki_sha256 (spki_sha256),
  ADD INDEX IF NOT EXISTS status (status);
