#!/usr/bin/env bash
# Agente de firewall para la VM VPN (192.168.10.29): descarga el fichero
# nftables generado por Radius Panel (GET /vpn/gateway/firewall.nft), lo
# valida con `nft -c -f` y solo entonces lo aplica. Si la descarga, la
# validacion o la aplicacion fallan, conserva el firewall que ya estaba
# cargado -nunca lo deja a medias ni sin reglas-.
#
# Configuracion (no se versiona, crear a mano en la VM):
#   /etc/vpn-gateway-agent/config.sh
#     PANEL_URL='https://pki.vlc.didev.es:8443'
#     GATEWAY_TOKEN='...'   # generado en el panel: VPN > Ajustes
set -euo pipefail

CONFIG_FILE="${VPN_GATEWAY_AGENT_CONFIG:-/etc/vpn-gateway-agent/config.sh}"
STATE_DIR="${VPN_GATEWAY_AGENT_STATE_DIR:-/var/lib/vpn-gateway-agent}"

if [ ! -f "$CONFIG_FILE" ]; then
  echo "Falta $CONFIG_FILE (PANEL_URL y GATEWAY_TOKEN)" >&2
  exit 1
fi
# shellcheck source=/dev/null
. "$CONFIG_FILE"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
current_file="$STATE_DIR/firewall.nft"
new_file="$(mktemp)"
trap 'rm -f "$new_file"' EXIT

echo "Descargando el firewall generado desde $PANEL_URL..."
if ! curl -sS --fail --max-time 15 \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  "$PANEL_URL/vpn/gateway/firewall.nft" -o "$new_file"; then
  echo "No se pudo descargar el fichero: se conserva el firewall actual." >&2
  exit 1
fi

if [ ! -s "$new_file" ]; then
  echo "El fichero descargado esta vacio: se conserva el firewall actual." >&2
  exit 1
fi

echo "Validando sintaxis (nft -c -f)..."
if ! nft -c -f "$new_file"; then
  echo "El fichero nuevo no es valido: se conserva el firewall actual." >&2
  exit 1
fi

echo "Aplicando..."
if nft -f "$new_file"; then
  mv "$new_file" "$current_file"
  chmod 600 "$current_file"
  echo "Firewall actualizado correctamente."
else
  echo "Fallo al aplicar el fichero nuevo: se reaplica el anterior." >&2
  if [ -f "$current_file" ] && nft -f "$current_file"; then
    echo "Firewall anterior reaplicado; el nuevo NO se ha guardado." >&2
  else
    echo "ATENCION: tambien fallo reaplicar el firewall anterior -revisa 'nft list ruleset' a mano-." >&2
  fi
  exit 1
fi
