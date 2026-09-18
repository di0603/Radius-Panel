-- ---------------------------------------------------------------------------
-- Esquema estandar de FreeRADIUS para MySQL / MariaDB (modulo rlm_sql).
--
-- Ejecuta este fichero SOLO si todavia no tienes la base de datos de RADIUS.
-- Si tu FreeRADIUS ya funciona con SQL, NO lo ejecutes: el panel usara tus
-- tablas existentes.
--
--   mysql -u root -p < sql/freeradius-schema.sql
-- ---------------------------------------------------------------------------

CREATE DATABASE IF NOT EXISTS radius
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE radius;

--
-- Atributos de comprobacion por usuario (p.ej. Cleartext-Password)
--
CREATE TABLE IF NOT EXISTS radcheck (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username  VARCHAR(64)  NOT NULL DEFAULT '',
  attribute VARCHAR(64)  NOT NULL DEFAULT '',
  op        CHAR(2)      NOT NULL DEFAULT '==',
  value     VARCHAR(253) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY username (username(32))
) ENGINE=InnoDB;

--
-- Atributos de respuesta por usuario (p.ej. Framed-IP-Address)
--
CREATE TABLE IF NOT EXISTS radreply (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username  VARCHAR(64)  NOT NULL DEFAULT '',
  attribute VARCHAR(64)  NOT NULL DEFAULT '',
  op        CHAR(2)      NOT NULL DEFAULT '=',
  value     VARCHAR(253) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY username (username(32))
) ENGINE=InnoDB;

--
-- Atributos de comprobacion por grupo
--
CREATE TABLE IF NOT EXISTS radgroupcheck (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  groupname VARCHAR(64)  NOT NULL DEFAULT '',
  attribute VARCHAR(64)  NOT NULL DEFAULT '',
  op        CHAR(2)      NOT NULL DEFAULT '==',
  value     VARCHAR(253) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY groupname (groupname(32))
) ENGINE=InnoDB;

--
-- Atributos de respuesta por grupo
--
CREATE TABLE IF NOT EXISTS radgroupreply (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  groupname VARCHAR(64)  NOT NULL DEFAULT '',
  attribute VARCHAR(64)  NOT NULL DEFAULT '',
  op        CHAR(2)      NOT NULL DEFAULT '=',
  value     VARCHAR(253) NOT NULL DEFAULT '',
  PRIMARY KEY (id),
  KEY groupname (groupname(32))
) ENGINE=InnoDB;

--
-- Pertenencia de usuarios a grupos
--
CREATE TABLE IF NOT EXISTS radusergroup (
  id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username  VARCHAR(64)  NOT NULL DEFAULT '',
  groupname VARCHAR(64)  NOT NULL DEFAULT '',
  priority  INT NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY username (username(32))
) ENGINE=InnoDB;

--
-- Accounting
--
CREATE TABLE IF NOT EXISTS radacct (
  radacctid           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  acctsessionid       VARCHAR(64)  NOT NULL DEFAULT '',
  acctuniqueid        VARCHAR(32)  NOT NULL DEFAULT '',
  username            VARCHAR(64)  NOT NULL DEFAULT '',
  realm               VARCHAR(64)  DEFAULT '',
  nasipaddress        VARCHAR(15)  NOT NULL DEFAULT '',
  nasportid           VARCHAR(32)  DEFAULT NULL,
  nasporttype         VARCHAR(32)  DEFAULT NULL,
  acctstarttime       DATETIME     NULL DEFAULT NULL,
  acctupdatetime      DATETIME     NULL DEFAULT NULL,
  acctstoptime        DATETIME     NULL DEFAULT NULL,
  acctinterval        INT UNSIGNED DEFAULT NULL,
  acctsessiontime     INT UNSIGNED DEFAULT NULL,
  acctauthentic       VARCHAR(32)  DEFAULT NULL,
  connectinfo_start   VARCHAR(50)  DEFAULT NULL,
  connectinfo_stop    VARCHAR(50)  DEFAULT NULL,
  acctinputoctets     BIGINT       DEFAULT NULL,
  acctoutputoctets    BIGINT       DEFAULT NULL,
  calledstationid     VARCHAR(50)  NOT NULL DEFAULT '',
  callingstationid    VARCHAR(50)  NOT NULL DEFAULT '',
  acctterminatecause  VARCHAR(32)  NOT NULL DEFAULT '',
  servicetype         VARCHAR(32)  DEFAULT NULL,
  framedprotocol      VARCHAR(32)  DEFAULT NULL,
  framedipaddress     VARCHAR(15)  NOT NULL DEFAULT '',
  framedipv6address   VARCHAR(45)  NOT NULL DEFAULT '',
  framedipv6prefix    VARCHAR(45)  NOT NULL DEFAULT '',
  framedinterfaceid   VARCHAR(44)  NOT NULL DEFAULT '',
  delegatedipv6prefix VARCHAR(45)  NOT NULL DEFAULT '',
  class               VARCHAR(64)  DEFAULT NULL,
  PRIMARY KEY (radacctid),
  UNIQUE KEY acctuniqueid (acctuniqueid),
  KEY username (username),
  KEY framedipaddress (framedipaddress),
  KEY acctsessionid (acctsessionid),
  KEY acctsessiontime (acctsessiontime),
  KEY acctstarttime (acctstarttime),
  KEY acctstoptime (acctstoptime),
  KEY nasipaddress (nasipaddress)
) ENGINE=InnoDB;

--
-- Registro post-auth (Access-Accept / Access-Reject)
--
CREATE TABLE IF NOT EXISTS radpostauth (
  id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(64)  NOT NULL DEFAULT '',
  pass     VARCHAR(64)  NOT NULL DEFAULT '',
  reply    VARCHAR(32)  NOT NULL DEFAULT '',
  authdate TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  class    VARCHAR(64)  DEFAULT NULL,
  PRIMARY KEY (id),
  KEY username (username),
  KEY authdate (authdate)
) ENGINE=InnoDB;

--
-- Clientes NAS (equivalente a clients.conf)
--
CREATE TABLE IF NOT EXISTS nas (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  nasname     VARCHAR(128) NOT NULL,
  shortname   VARCHAR(32)  DEFAULT NULL,
  type        VARCHAR(30)  DEFAULT 'other',
  ports       INT          DEFAULT NULL,
  secret      VARCHAR(60)  NOT NULL DEFAULT 'secret',
  server      VARCHAR(64)  DEFAULT NULL,
  community   VARCHAR(50)  DEFAULT NULL,
  description VARCHAR(200) DEFAULT 'RADIUS Client',
  PRIMARY KEY (id),
  KEY nasname (nasname)
) ENGINE=InnoDB;
