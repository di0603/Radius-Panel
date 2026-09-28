-- ---------------------------------------------------------------------------
-- Tablas propias del panel para la gestion de la VPN IKEv2/EAP-TLS (PKI de
-- dispositivo, enrolamiento EST y ajustes del modulo).
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente. Requiere que "radius_panel" ya exista (aplica antes
-- panel-schema.sql si es una instalacion nueva).
--
-- Opcional, igual que panel-schema-user-meta.sql: sin estas tablas el panel
-- arranca igual, el modulo VPN aparece desactivado (ver /api/meta.vpnEnabled).
-- ---------------------------------------------------------------------------

--
-- Dispositivos VPN dados de alta desde el panel. Es la vista de "gestion" del
-- dispositivo (nombre, plataforma, contacto); la validez real del certificado
-- vive en radius.vpn_certificates, en la otra base de datos.
--
CREATE TABLE IF NOT EXISTS panel_vpn_devices (
  id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username       VARCHAR(64) NOT NULL,
  display_name   VARCHAR(255) NULL DEFAULT NULL,
  platform       VARCHAR(32) NULL DEFAULT NULL,
  framed_ip      VARCHAR(45) NULL DEFAULT NULL,
  contact_email  VARCHAR(255) NULL DEFAULT NULL,
  notes          TEXT NULL,
  status         ENUM('pending', 'active', 'disabled', 'revoked') NOT NULL DEFAULT 'pending',
  created_by     INT UNSIGNED NULL DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY username (username),
  KEY status (status)
) ENGINE=InnoDB;

--
-- Tokens de alta EST (RFC 7030), un solo uso. Solo se guarda el hash SHA-256:
-- el token en claro se ensena una vez al crearlo y no se puede recuperar.
--
CREATE TABLE IF NOT EXISTS panel_vpn_enroll_tokens (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username    VARCHAR(64) NOT NULL,
  token_hash  CHAR(64) NOT NULL,
  expires_at  DATETIME NOT NULL,
  used_at     DATETIME NULL DEFAULT NULL,
  revoked_at  DATETIME NULL DEFAULT NULL,
  created_by  INT UNSIGNED NULL DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY token_hash (token_hash),
  KEY username (username)
) ENGINE=InnoDB;

--
-- CA's conocidas por el panel (raiz offline + intermedia activa). Solo
-- metadatos y el certificado publico: la clave privada de la intermedia (para
-- cuando el panel firme automaticamente) se anade en una migracion posterior,
-- cifrada con PKI_MASTER_KEY, cuando exista el modulo que la usa.
--
CREATE TABLE IF NOT EXISTS panel_pki_ca (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  role        ENUM('root', 'intermediate') NOT NULL,
  subject_cn  VARCHAR(255) NOT NULL,
  serial      VARCHAR(64) NOT NULL,
  not_before  DATETIME NOT NULL,
  not_after   DATETIME NOT NULL,
  cert_pem    MEDIUMTEXT NOT NULL,
  crl_url     VARCHAR(255) NULL DEFAULT NULL,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY serial (serial),
  KEY role_active (role, active)
) ENGINE=InnoDB;

--
-- Ajustes del modulo VPN: una unica fila (id = 1). device_cert_days /
-- renew_after_days / overlap_hours rigen la renovacion automatica por EST;
-- android_cert_days es mas largo porque Android no soporta la renovacion
-- automatica y el certificado hay que instalarlo a mano.
--
CREATE TABLE IF NOT EXISTS panel_vpn_settings (
  id                 TINYINT UNSIGNED NOT NULL,
  vpn_fqdn           VARCHAR(255) NOT NULL DEFAULT 'vpn.vlc.didev.es',
  pool_start         VARCHAR(45) NOT NULL DEFAULT '192.168.10.75',
  pool_end           VARCHAR(45) NOT NULL DEFAULT '192.168.10.99',
  dns                VARCHAR(255) NOT NULL DEFAULT '',
  device_cert_days   SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  renew_after_days   SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  overlap_hours      SMALLINT UNSIGNED NOT NULL DEFAULT 48,
  android_cert_days  SMALLINT UNSIGNED NOT NULL DEFAULT 365,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

INSERT IGNORE INTO panel_vpn_settings (id) VALUES (1);
