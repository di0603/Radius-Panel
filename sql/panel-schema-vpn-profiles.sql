-- ---------------------------------------------------------------------------
-- Perfiles de acceso por dispositivo VPN (prompt 12.14): cada dispositivo tiene
-- un perfil (lan_restricted, lan_full, internet_only, internet_lan_restricted,
-- internet_lan_full) que decide a que puede llegar por el tunel. El panel
-- reparte la IP fija (Framed-IP-Address) del rango del perfil y genera el
-- fichero nftables vpn-profiles.nft que impone el perfil en la VM VPN
-- (192.168.10.29); ver server/src/services/vpnProfilesNft.ts.
--
--   mysql -u root -p radius_panel < sql/panel-schema-vpn-profiles.sql
-- o desde el menu de administracion: npm run menu -> Esquema / migraciones.
--
-- Es idempotente y NO destructiva (no borra tablas ni filas). Requiere
-- MariaDB (ADD COLUMN IF NOT EXISTS, 10.0.2+). Va en la base del panel
-- (radius_panel); no toca la base radius.
-- ---------------------------------------------------------------------------

--
-- Perfil del dispositivo. Los dispositivos que ya existen se quedan en
-- internet_lan_full (Internet + toda la LAN): es lo que tienen hoy, asi que
-- aplicar esta migracion no cambia su comportamiento. Despues se baja el
-- DEFAULT a internet_only, el perfil de las altas nuevas (el panel tambien lo
-- manda siempre de forma explicita).
--
ALTER TABLE panel_vpn_devices
  ADD COLUMN IF NOT EXISTS access_profile
    ENUM('lan_restricted', 'lan_full', 'internet_only', 'internet_lan_restricted', 'internet_lan_full')
    NOT NULL DEFAULT 'internet_lan_full' AFTER tunnel_mode;

ALTER TABLE panel_vpn_devices
  ALTER COLUMN access_profile SET DEFAULT 'internet_only';

--
-- Rango de IPs de cada perfil (una fila por perfil, dentro de la LAN, fuera
-- del DHCP del router y sin solaparse: lo valida el panel, ver
-- vpnAccessProfiles.ts). Un perfil sin fila (o con NULL) no tiene rango y no
-- se puede dar de alta ningun dispositivo con el hasta configurarlo.
--
CREATE TABLE IF NOT EXISTS panel_vpn_profile_ranges (
  profile     ENUM('lan_restricted', 'lan_full', 'internet_only', 'internet_lan_restricted', 'internet_lan_full') NOT NULL,
  range_start VARCHAR(15) NULL DEFAULT NULL,
  range_end   VARCHAR(15) NULL DEFAULT NULL,
  updated_by  INT UNSIGNED NULL DEFAULT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (profile)
) ENGINE=InnoDB;

--
-- Semilla: el rango actual de la VPN (192.168.10.75-99, donde ya viven los
-- dispositivos existentes) pasa a ser el de internet_lan_full. El resto de
-- perfiles quedan SIN rango: los elige un admin en el panel (VPN -> Perfiles
-- de acceso) segun el DHCP real del router.
--
INSERT IGNORE INTO panel_vpn_profile_ranges (profile, range_start, range_end)
VALUES ('internet_lan_full', '192.168.10.75', '192.168.10.99');

--
-- Lista global de destinos permitidos a los dos perfiles restringidos
-- (lan_restricted e internet_lan_restricted). dest_cidr es una IPv4 o un CIDR
-- dentro de la LAN; ports es una lista "22,443,8000-8100" (NULL = todos los
-- puertos; obligatorio NULL con icmp). Nada de esto es texto libre: el panel
-- valida cada campo antes de guardarlo y antes de generar el .nft.
--
CREATE TABLE IF NOT EXISTS panel_vpn_restricted_destinations (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  dest_cidr   VARCHAR(18) NOT NULL,
  protocol    ENUM('tcp', 'udp', 'icmp') NOT NULL,
  ports       VARCHAR(64) NULL DEFAULT NULL,
  comment     VARCHAR(128) NOT NULL DEFAULT '',
  created_by  INT UNSIGNED NULL DEFAULT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB;
