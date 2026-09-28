-- ---------------------------------------------------------------------------
-- Reconciliacion de panel_pki_ca con el modelo de CLAUDE.md (correccion 4.5):
-- una fila por CA intermedia, con `subject`/`root_cert_pem` en vez del
-- esquema anterior (`role`/`subject_cn`/CA raiz como fila propia).
--
-- Solo hace falta si tu base de datos aplico la version anterior de
-- sql/panel-schema-vpn.sql. En una instalacion nueva, panel-schema-vpn.sql ya
-- crea la tabla correcta y este fichero es un no-op.
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-pki.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente. El modulo de PKI todavia no se ha desplegado en produccion
-- (no hay ninguna intermedia real, como mucho una fila 'pending' de prueba en
-- RSA, que de todas formas hay que retirar), asi que en vez de renombrar
-- columnas con datos reales, esta migracion recrea la tabla vacia con el
-- esquema correcto. NO toca radius.vpn_certificates ni ninguna otra tabla.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS panel_pki_ca;

CREATE TABLE panel_pki_ca (
  id                     INT UNSIGNED NOT NULL AUTO_INCREMENT,
  status                 ENUM('pending', 'active', 'retiring', 'retired') NOT NULL DEFAULT 'pending',
  subject                VARCHAR(255) NULL DEFAULT NULL,
  serial                 VARCHAR(64) NULL DEFAULT NULL,
  spki_sha256            CHAR(64) NULL DEFAULT NULL,
  cert_pem               MEDIUMTEXT NULL DEFAULT NULL,
  root_cert_pem          MEDIUMTEXT NULL DEFAULT NULL,
  csr_pem                MEDIUMTEXT NULL DEFAULT NULL,
  private_key_encrypted  MEDIUMTEXT NULL DEFAULT NULL,
  not_before             DATETIME NULL DEFAULT NULL,
  not_after              DATETIME NULL DEFAULT NULL,
  crl_pem                MEDIUMTEXT NULL DEFAULT NULL,
  crl_number             INT UNSIGNED NOT NULL DEFAULT 0,
  crl_next_update        DATETIME NULL DEFAULT NULL,
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY serial (serial),
  UNIQUE KEY spki_sha256 (spki_sha256),
  KEY status (status)
) ENGINE=InnoDB;
