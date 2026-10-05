#!/usr/bin/env bash
# Aplica el vpn-profiles.nft de los perfiles de acceso VPN en la VM VPN
# (192.168.10.29) con "confirmar o revertir": si no confirmas en 60 s (o se te
# cae la sesion SSH porque las reglas te dejaron sin acceso), el estado
# anterior se restaura SOLO.
#
# NO lo lanza el panel ni ningun timer: lo revisas y lo ejecutas tu, como root:
#
#   1. Descarga el fichero desde el panel (VPN -> Perfiles de acceso ->
#      "Descargar vpn-profiles.nft") y copialo a la .29.
#   2. Revisalo (nada de el se ejecuta hasta el paso 3).
#   3. sudo deploy/vpn-gateway-apply-profiles.sh --check-only vpn-profiles.nft
#      sudo deploy/vpn-gateway-apply-profiles.sh vpn-profiles.nft
#      -> abre OTRA sesion SSH para comprobar que sigues entrando, vuelve a esta
#         y escribe CONFIRMAR antes de que acabe la cuenta atras.
#
# Que hace, en orden (parando en el primer fallo):
#   - Rechaza el fichero si no declara la tabla "inet vpn_profiles" o si trae
#     "flush ruleset" o toca otras tablas (solo gestiona la suya).
#   - nft -c -f (comprueba la sintaxis sin cargar nada).
#   - Copia de seguridad en $BACKUP_DIR: nftables.conf, el fichero instalado
#     anterior, el ruleset completo y la tabla inet vpn_profiles actual.
#   - Carga atomica (nft -f es una unica transaccion) y lanza un vigilante
#     independiente de esta sesion (setsid) que revierte la tabla a su estado
#     anterior pasados $CONFIRM_SECONDS salvo que se confirme.
#   - Solo tras CONFIRMAR instala el fichero en $TARGET (el que incluye
#     /etc/nftables.conf para sobrevivir a un reinicio). No toca nftables.conf.
#
# Revertir a mano despues de confirmar:
#   nft delete table inet vpn_profiles
#   y, si lo quieres fuera tambien tras reinicios, restaura $TARGET desde
#   $BACKUP_DIR (o quita la linea include de /etc/nftables.conf).
#
# Variables (todas opcionales): NFT_BIN, NFTABLES_CONF, TARGET, BACKUP_DIR,
# CONFIRM_SECONDS.
set -euo pipefail

NFT_BIN="${NFT_BIN:-nft}"
NFTABLES_CONF="${NFTABLES_CONF:-/etc/nftables.conf}"
TARGET="${TARGET:-/etc/nftables.d/vpn-profiles.nft}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vpn-gateway}"
CONFIRM_SECONDS="${CONFIRM_SECONDS:-60}"
TABLE_FAMILY="inet"
TABLE_NAME="vpn_profiles"

usage() {
  echo "Uso: $0 [--check-only] <vpn-profiles.nft>" >&2
  exit 2
}

check_only=0
file=""
for arg in "$@"; do
  case "$arg" in
    --check-only) check_only=1 ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      [ -z "$file" ] || usage
      file="$arg"
      ;;
  esac
done
[ -n "$file" ] || usage

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() {
  echo "ERROR: $*" >&2
  exit 1
}

case "$CONFIRM_SECONDS" in
  '' | *[!0-9]*) die "CONFIRM_SECONDS debe ser un numero de segundos (es '$CONFIRM_SECONDS')" ;;
esac

if [ "${SKIP_ROOT_CHECK:-0}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  die "ejecutalo como root (sudo): nft necesita privilegios"
fi
[ -r "$file" ] || die "no se puede leer $file"

# 1) Solo gestiona su propia tabla.
grep -q "^table $TABLE_FAMILY $TABLE_NAME {" "$file" || die "$file no declara 'table $TABLE_FAMILY $TABLE_NAME'"
if grep -Eq '^[[:space:]]*flush[[:space:]]+ruleset' "$file"; then
  die "$file trae 'flush ruleset': este script solo gestiona la tabla $TABLE_FAMILY $TABLE_NAME"
fi
if grep -E '^[[:space:]]*(delete|flush|destroy)[[:space:]]' "$file" | grep -Ev "^[[:space:]]*delete[[:space:]]+table[[:space:]]+$TABLE_FAMILY[[:space:]]+$TABLE_NAME[[:space:]]*$" | grep -q .; then
  die "$file contiene comandos delete/flush sobre algo distinto de la tabla $TABLE_FAMILY $TABLE_NAME"
fi
if grep -E '^[[:space:]]*table[[:space:]]' "$file" | grep -Ev "^table $TABLE_FAMILY $TABLE_NAME " | grep -q .; then
  die "$file declara tablas distintas de $TABLE_FAMILY $TABLE_NAME"
fi

# 2) Sintaxis, sin cargar nada.
log "Comprobando la sintaxis (nft -c -f)..."
"$NFT_BIN" -c -f "$file" || die "nft -c -f rechaza el fichero; no se ha tocado nada"
log "Sintaxis correcta."

if [ -f "$NFTABLES_CONF" ] && ! grep -q "$(basename "$TARGET")" "$NFTABLES_CONF"; then
  log "AVISO: $NFTABLES_CONF no incluye $TARGET; las reglas se perderian en el proximo reinicio."
  log "       Anade a mano: include \"$TARGET\"   (este script no edita nftables.conf)"
fi

if [ "$check_only" -eq 1 ]; then
  log "--check-only: fichero valido, no se ha aplicado nada."
  exit 0
fi

# 3) Copias de seguridad.
stamp="$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$BACKUP_DIR"
backup_conf="$BACKUP_DIR/nftables.conf.$stamp"
backup_target="$BACKUP_DIR/vpn-profiles.nft.installed.$stamp"
backup_ruleset="$BACKUP_DIR/ruleset.$stamp.nft"
revert_file="$BACKUP_DIR/revert-vpn-profiles.$stamp.nft"
confirm_flag="$BACKUP_DIR/confirm.$stamp"

[ ! -f "$NFTABLES_CONF" ] || cp -p "$NFTABLES_CONF" "$backup_conf"
[ ! -f "$TARGET" ] || cp -p "$TARGET" "$backup_target"
"$NFT_BIN" list ruleset >"$backup_ruleset"
log "Copias de seguridad en $BACKUP_DIR (sufijo $stamp)."

# Fichero de reversion: la tabla tal como esta ahora (o su ausencia).
{
  echo "table $TABLE_FAMILY $TABLE_NAME {}"
  echo "delete table $TABLE_FAMILY $TABLE_NAME"
  if "$NFT_BIN" list table "$TABLE_FAMILY" "$TABLE_NAME" >/dev/null 2>&1; then
    "$NFT_BIN" list table "$TABLE_FAMILY" "$TABLE_NAME"
  fi
} >"$revert_file"

revert_now() {
  log "Revirtiendo a la tabla anterior..."
  if "$NFT_BIN" -f "$revert_file"; then
    log "Revertido: vuelve el estado de antes de aplicar."
  else
    echo "ERROR: no se pudo revertir automaticamente; restaura a mano desde $backup_ruleset" >&2
  fi
}

# 4) Carga atomica + vigilante independiente de esta sesion.
log "Aplicando $file (carga atomica)..."
"$NFT_BIN" -f "$file" || die "nft -f ha fallado; la carga es atomica, no ha cambiado nada"

watchdog_pid=""
setsid nohup bash -c '
  sleep "$1"
  if [ ! -e "$2" ]; then
    "$3" -f "$4" && echo "[vigilante] sin confirmacion: tabla revertida" || echo "[vigilante] FALLO al revertir; restaura desde $5" >&2
  fi
' _ "$CONFIRM_SECONDS" "$confirm_flag" "$NFT_BIN" "$revert_file" "$backup_ruleset" >>"$BACKUP_DIR/watchdog.log" 2>&1 </dev/null &
watchdog_pid=$!

echo
log "Reglas cargadas. Abre OTRA sesion SSH para comprobar que sigues entrando y que la VPN va."
log "Tienes $CONFIRM_SECONDS s. Escribe CONFIRMAR para dejarlas; cualquier otra cosa (o nada) las revierte."

answer=""
if read -r -t "$CONFIRM_SECONDS" -p "> " answer; then
  :
else
  answer=""
fi

if [ "$answer" = "CONFIRMAR" ]; then
  touch "$confirm_flag"
  kill "$watchdog_pid" 2>/dev/null || true
  mkdir -p "$(dirname "$TARGET")"
  install -m 0644 "$file" "$TARGET"
  log "Confirmado. Instalado en $TARGET."
  log "Reversion manual: nft delete table $TABLE_FAMILY $TABLE_NAME  (y restaura $backup_target si existia)."
  exit 0
fi

kill "$watchdog_pid" 2>/dev/null || true
revert_now
die "no se ha confirmado: revertido. $TARGET no se ha modificado."
