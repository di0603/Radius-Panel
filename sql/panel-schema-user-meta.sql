-- ---------------------------------------------------------------------------
-- Metadatos del panel por usuario RADIUS (email de contacto y notas).
--
-- Deliberadamente NO toca radcheck/radreply/radusergroup ni ninguna tabla de
-- FreeRADIUS: es una tabla propia del panel, unida por username en la
-- aplicacion (no con JOIN SQL, porque puede vivir en un servidor MySQL
-- distinto al de FreeRADIUS). Si borras un usuario en FreeRADIUS y luego lo
-- recreas con el mismo nombre, recupera el email/notas que tuviera.
--
-- Aplicar:
--   mysql -u root -p radius_panel < sql/panel-schema-user-meta.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es opcional: sin esta tabla, el panel sigue funcionando igual, simplemente
-- no hay campo de email/notas en la ficha de usuario.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS panel_user_meta (
  username   VARCHAR(64)  NOT NULL,
  email      VARCHAR(255) NULL DEFAULT NULL,
  notes      TEXT         NULL,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (username),
  KEY email (email)
) ENGINE=InnoDB;
