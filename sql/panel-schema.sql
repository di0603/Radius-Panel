-- ---------------------------------------------------------------------------
-- Tablas propias del panel (independientes del esquema de FreeRADIUS).
--
--   mysql -u root -p < sql/panel-schema.sql
--
-- Despues crea el primer administrador con:
--   npm run seed:admin
-- ---------------------------------------------------------------------------

CREATE DATABASE IF NOT EXISTS radius_panel
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE radius_panel;

--
-- Administradores del panel. La contrasena se guarda como hash bcrypt.
-- role: 'admin'  -> acceso total, incluye gestion de admins y auditoria
--       'operator' -> gestion de RADIUS (usuarios, grupos, NAS, sesiones)
--
CREATE TABLE IF NOT EXISTS panel_admins (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(64)  NOT NULL,
  password_hash VARCHAR(100) NOT NULL,
  role          ENUM('admin','operator') NOT NULL DEFAULT 'operator',
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME     NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY username (username)
) ENGINE=InnoDB;

--
-- Registro de auditoria: toda operacion de escritura del panel.
--
CREATE TABLE IF NOT EXISTS panel_audit_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id    INT UNSIGNED NULL,
  admin_name  VARCHAR(64)  NOT NULL DEFAULT '',
  action      VARCHAR(32)  NOT NULL,
  entity      VARCHAR(32)  NOT NULL,
  entity_id   VARCHAR(128) NOT NULL DEFAULT '',
  detail      JSON         NULL,
  ip          VARCHAR(45)  NOT NULL DEFAULT '',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY created_at (created_at),
  KEY entity (entity, entity_id)
) ENGINE=InnoDB;
