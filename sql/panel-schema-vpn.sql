-- ---------------------------------------------------------------------------
-- Tablas propias del panel para la gestion de la VPN IKEv2/EAP-TLS (PKI de
-- dispositivo, enrolamiento EST y ajustes del modulo). Esquema segun
-- CLAUDE.md (correccion 4.5): si vienes de una instalacion que aplico la
-- version anterior de este fichero, aplica tambien sql/panel-schema-vpn-pki.sql
-- y sql/panel-schema-vpn-devices.sql para reconciliar el esquema.
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
-- Dispositivos VPN dados de alta desde el panel. username = vpn-<owner_user>-
-- <device_label> (unico); la validez real del certificado vive en
-- radius.vpn_certificates, en la otra base de datos (puede ser otro servidor).
--
CREATE TABLE IF NOT EXISTS panel_vpn_devices (
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

--
-- Tokens de alta EST (RFC 7030), un solo uso. Solo se guarda el hash SHA-256:
-- el token en claro se ensena una vez al crearlo y no se puede recuperar.
-- Generar uno nuevo borra cualquier pendiente anterior del mismo dispositivo
-- (no hay estado "revocado": o esta pendiente de usar, o ya no existe).
--
CREATE TABLE IF NOT EXISTS panel_vpn_enroll_tokens (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(32) NOT NULL,
  token_sha256  CHAR(64) NOT NULL,
  expires_at    DATETIME NOT NULL,
  used_at       DATETIME NULL DEFAULT NULL,
  created_by    INT UNSIGNED NULL DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY token_sha256 (token_sha256),
  KEY username (username)
) ENGINE=InnoDB;

--
-- CA intermedia de la VPN: una fila por CA (permite guardar la anterior
-- mientras se retira tras una rotacion). La raiz es offline -el panel nunca
-- tiene su clave privada- asi que se guarda solo su certificado publico,
-- duplicado en `root_cert_pem` en cada fila (siempre la misma raiz: usar
-- varias raices no esta soportado).
--
CREATE TABLE IF NOT EXISTS panel_pki_ca (
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

--
-- Ajustes del modulo VPN: una unica fila (id = 1). device_cert_days /
-- renew_after_days / overlap_hours rigen la renovacion automatica por EST;
-- android_cert_days es mas largo porque Android no soporta la renovacion
-- automatica y el certificado hay que instalarlo a mano. aaa_id es la
-- identidad que deben configurar los clientes para validar el certificado
-- de FreeRADIUS; est_url es donde escucha el endpoint EST (RFC 7030).
--
CREATE TABLE IF NOT EXISTS panel_vpn_settings (
  id                 TINYINT UNSIGNED NOT NULL,
  vpn_fqdn           VARCHAR(255) NOT NULL DEFAULT 'vpn.vlc.didev.es',
  aaa_id             VARCHAR(255) NOT NULL DEFAULT 'CN=radius.vpn.vlc.didev.es',
  pool_start         VARCHAR(45) NOT NULL DEFAULT '192.168.10.75',
  pool_end           VARCHAR(45) NOT NULL DEFAULT '192.168.10.99',
  dns                VARCHAR(255) NOT NULL DEFAULT '',
  device_cert_days   SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  renew_after_days   SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  overlap_hours      SMALLINT UNSIGNED NOT NULL DEFAULT 48,
  android_cert_days  SMALLINT UNSIGNED NOT NULL DEFAULT 365,
  est_url            VARCHAR(255) NOT NULL DEFAULT 'https://pki.vlc.didev.es:8443',
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;

INSERT IGNORE INTO panel_vpn_settings (id) VALUES (1);
