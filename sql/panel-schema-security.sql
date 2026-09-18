-- ---------------------------------------------------------------------------
-- Ampliacion de seguridad del panel (refresh tokens, bloqueo de cuenta, 2FA).
--
-- Aplicar ANTES de arrancar la version del servidor que lo usa:
--   mysql -u root -p radius_panel < sql/panel-schema-security.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente: se puede ejecutar varias veces sin romper nada.
-- Para instalaciones nuevas no hace falta, ya va incluido en panel-schema.sql.
--
-- Requiere MariaDB (soporta ADD COLUMN IF NOT EXISTS desde 10.0.2). En MySQL
-- puro esta sintaxis no existe: si tu servidor es MySQL, anade las columnas
-- a mano con ALTER TABLE panel_admins ADD COLUMN <definicion>, comprobando
-- antes en information_schema.COLUMNS si ya existen.
-- ---------------------------------------------------------------------------

--
-- Bloqueo de cuenta tras N intentos fallidos.
--
ALTER TABLE panel_admins
  ADD COLUMN IF NOT EXISTS failed_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until DATETIME NULL DEFAULT NULL;

--
-- 2FA (TOTP). El secreto se guarda cifrado con AES-256-GCM derivado de JWT_SECRET,
-- nunca en claro. totp_enabled solo pasa a 1 cuando el admin confirma un codigo.
--
ALTER TABLE panel_admins
  ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS totp_enabled TINYINT(1) NOT NULL DEFAULT 0;

--
-- Fecha del ultimo cambio de contrasena (para politicas de caducidad).
--
ALTER TABLE panel_admins
  ADD COLUMN IF NOT EXISTS password_changed_at DATETIME NULL DEFAULT NULL;

--
-- Sesiones del panel: un registro por refresh token emitido.
-- Se guarda solo el hash SHA-256 del token, nunca el token en claro.
-- Permite listar las sesiones abiertas y revocarlas una a una.
--
CREATE TABLE IF NOT EXISTS panel_refresh_tokens (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  admin_id     INT UNSIGNED NOT NULL,
  token_hash   CHAR(64)     NOT NULL,
  family       CHAR(36)     NOT NULL,
  expires_at   DATETIME     NOT NULL,
  revoked_at   DATETIME     NULL DEFAULT NULL,
  last_used_at DATETIME     NULL DEFAULT NULL,
  ip           VARCHAR(45)  NOT NULL DEFAULT '',
  user_agent   VARCHAR(255) NOT NULL DEFAULT '',
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY token_hash (token_hash),
  KEY admin_id (admin_id),
  KEY family (family),
  KEY expires_at (expires_at)
) ENGINE=InnoDB;

--
-- Intentos de acceso al panel (correctos y fallidos).
-- Sirve para el rate-limit por usuario y para investigar ataques de fuerza bruta.
--
CREATE TABLE IF NOT EXISTS panel_login_attempts (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username   VARCHAR(64) NOT NULL,
  ip         VARCHAR(45) NOT NULL DEFAULT '',
  success    TINYINT(1)  NOT NULL DEFAULT 0,
  reason     VARCHAR(32) NOT NULL DEFAULT '',
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY username_created (username, created_at),
  KEY created_at (created_at)
) ENGINE=InnoDB;
