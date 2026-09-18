-- ---------------------------------------------------------------------------
-- Login con Google como alternativa al login local (opcional).
--
-- Aplicar ANTES de activar GOOGLE_CLIENT_ID en el servidor:
--   mysql -u root -p radius_panel < sql/panel-schema-google.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente. Requiere MariaDB (ADD COLUMN/INDEX IF NOT EXISTS, 10.0.2+).
--
-- email: la cuenta de Google se vincula por email la primera vez que alguien
--   con ese email inicia sesion. Un admin la establece para si mismo desde
--   "Mi cuenta" -> no hay alta libre, solo cuentas de administrador ya creadas.
-- google_sub: identificador unico de Google (mas fiable que el email a largo
--   plazo, un email se puede reciclar); se rellena solo tras el primer login.
-- ---------------------------------------------------------------------------

ALTER TABLE panel_admins
  ADD COLUMN IF NOT EXISTS email VARCHAR(255) NULL DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS google_sub VARCHAR(255) NULL DEFAULT NULL,
  ADD UNIQUE INDEX IF NOT EXISTS email (email),
  ADD UNIQUE INDEX IF NOT EXISTS google_sub (google_sub);
