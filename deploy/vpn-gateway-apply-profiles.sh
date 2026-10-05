#!/usr/bin/env bash
# Aplica el fichero de sets de los perfiles de acceso VPN (vpn-profiles.nft) en
# la VM VPN (192.168.10.29) con "confirmar o revertir": si no confirmas en 60 s
# (o se te cae la sesion SSH porque las reglas te dejaron sin acceso), el estado
# anterior de los sets se restaura SOLO.
#
# El fichero SOLO rellena sets que YA existen dentro de "inet filter"
# (flush set + add element, en una carga atomica): las reglas que los usan
# viven en /etc/nftables.conf (fragmento revisado e integrado a mano una vez,
# ver el boton "Descargar fragmento de nftables.conf" del panel). Este script
# NO crea tablas, cadenas ni reglas, y NO edita /etc/nftables.conf.
#
# NO lo lanza el panel ni ningun timer: lo revisas y lo ejecutas tu, como root:
#
#   1. Descarga vpn-profiles.nft desde el panel (VPN -> Perfiles de acceso) y
#      copialo a la .29. Revisalo: nada de el se carga hasta el paso 3.
#   2. sudo deploy/vpn-gateway-apply-profiles.sh --check-only vpn-profiles.nft
#   3. sudo deploy/vpn-gateway-apply-profiles.sh vpn-profiles.nft
#      -> abre OTRA sesion SSH para comprobar que sigues entrando, vuelve a esta
#         y escribe CONFIRMAR antes de que acabe la cuenta atras.
#
# Que hace, en orden (parando en el primer fallo):
#   - Rechaza el fichero si trae CUALQUIER linea que no sea comentario, linea
#     vacia, "flush set inet filter <set vpn_...>" o "add element inet filter
#     <set vpn_...> { ... }" (adios a "flush ruleset", tablas, cadenas, reglas).
#   - Comprueba que cada set que toca EXISTE en inet filter; si no, aborta con
#     un mensaje claro (falta integrar el fragmento en /etc/nftables.conf).
#   - nft -c -f (comprueba la sintaxis sin cargar nada).
#   - Copia de seguridad en $BACKUP_DIR: nftables.conf, el fichero instalado
#     anterior, el ruleset completo y el contenido actual de los sets.
#   - Carga atomica (nft -f es una unica transaccion) y lanza un vigilante
#     independiente de esta sesion (setsid) que restaura los sets pasados
#     $CONFIRM_SECONDS salvo que se confirme.
#   - Solo tras CONFIRMAR instala el fichero en $TARGET (el que incluye
#     /etc/nftables.conf para que sobreviva a un reinicio).
#
# Revertir a mano despues de confirmar: restaura el fichero anterior de
# $BACKUP_DIR (vpn-profiles.nft.installed.<fecha>) en $TARGET y vuelve a
# cargarlo (nft -f), o carga $BACKUP_DIR/revert-vpn-profiles.<fecha>.nft.
#
# Variables (todas opcionales): NFT_BIN, NFTABLES_CONF, TARGET, BACKUP_DIR,
# CONFIRM_SECONDS.
set -euo pipefail

NFT_BIN="${NFT_BIN:-nft}"
NFTABLES_CONF="${NFTABLES_CONF:-/etc/nftables.conf}"
TARGET="${TARGET:-/etc/nftables.d/vpn-profiles.nft}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vpn-gateway}"
CONFIRM_SECONDS="${CONFIRM_SECONDS:-60}"
FAMILY="inet"
TABLE="filter"
# Sets que este script puede tocar (los mismos que declara el fragmento).
ALLOWED_SETS="vpn_lan_restricted_ips vpn_lan_full_ips vpn_internet_only_ips vpn_internet_lan_restricted_ips vpn_internet_lan_full_ips vpn_restricted_dests vpn_restricted_icmp"

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

# 1) Lista blanca estricta de lineas: solo rellena sets, nada mas.
set_re="vpn_[a-z_]+"
bad_lines="$(
  grep -Ev \
    -e '^[[:space:]]*$' \
    -e '^[[:space:]]*#' \
    -e "^flush set $FAMILY $TABLE $set_re\$" \
    -e "^add element $FAMILY $TABLE $set_re \\{ [0-9A-Za-z./, -]+ \\}\$" \
    "$file" || true
)"
if [ -n "$bad_lines" ]; then
  echo "Lineas no permitidas en $file (solo 'flush set' y 'add element' sobre sets vpn_*):" >&2
  echo "$bad_lines" | head -5 >&2
  die "$file no es un fichero de sets valido; no se ha tocado nada"
fi

referenced_sets="$(grep -Eo "^(flush set|add element) $FAMILY $TABLE $set_re" "$file" | awk '{print $NF}' | sort -u)"
[ -n "$referenced_sets" ] || die "$file no rellena ningun set"
for name in $referenced_sets; do
  case " $ALLOWED_SETS " in
    *" $name "*) ;;
    *) die "el set '$name' no esta entre los que gestiona este script ($ALLOWED_SETS)" ;;
  esac
done

# 2) Los sets tienen que existir ya en inet filter (los declara el fragmento).
for name in $referenced_sets; do
  if ! "$NFT_BIN" list set "$FAMILY" "$TABLE" "$name" >/dev/null 2>&1; then
    die "el set '$name' NO existe en $FAMILY $TABLE: integra primero el fragmento de nftables.conf (sets vacios + reglas) y recarga /etc/nftables.conf. No se ha tocado nada."
  fi
done
log "Los $(echo "$referenced_sets" | wc -l) sets existen en $FAMILY $TABLE."

# 3) Sintaxis, sin cargar nada.
log "Comprobando la sintaxis (nft -c -f)..."
"$NFT_BIN" -c -f "$file" || die "nft -c -f rechaza el fichero; no se ha tocado nada"
log "Sintaxis correcta."

# Sets de intervalos concatenados: nft >= 0.9.4 y kernel >= 5.6. Solo aviso (la carga es atomica:
# si no los soporta, nft -f falla y no cambia nada).
kernel="$(uname -r | cut -d- -f1)"
if [ "$(printf '%s\n%s\n' "5.6" "$kernel" | sort -V | head -1)" != "5.6" ]; then
  log "AVISO: kernel $kernel < 5.6: puede no soportar sets de intervalos concatenados (vpn_restricted_dests)."
fi

if [ -f "$NFTABLES_CONF" ] && ! grep -q "$(basename "$TARGET")" "$NFTABLES_CONF"; then
  log "AVISO: $NFTABLES_CONF no incluye $TARGET; los sets se vaciarian en el proximo reinicio (la VPN fallaria cerrando)."
  log "       Anade a mano al final: include \"$TARGET\"   (este script no edita nftables.conf)"
fi

if [ "$check_only" -eq 1 ]; then
  log "--check-only: fichero valido, no se ha aplicado nada."
  exit 0
fi

# 4) Copias de seguridad.
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

# Fichero de reversion: el contenido ACTUAL de cada set que se va a tocar.
{
  echo "#!/usr/sbin/nft -f"
  for name in $referenced_sets; do
    echo "flush set $FAMILY $TABLE $name"
    elements="$(
      "$NFT_BIN" list set "$FAMILY" "$TABLE" "$name" | tr '\n' ' ' |
        sed -n 's/.*elements = {\(.*\)}[[:space:]]*}[[:space:]]*}[[:space:]]*$/\1/p'
    )"
    if [ -n "${elements// /}" ]; then
      echo "add element $FAMILY $TABLE $name { $(echo "$elements" | tr -s ' ' | sed 's/^ //; s/ $//') }"
    fi
  done
} >"$revert_file"

revert_now() {
  log "Revirtiendo los sets al estado anterior..."
  if "$NFT_BIN" -f "$revert_file"; then
    log "Revertido: los sets vuelven al estado de antes de aplicar."
  else
    echo "ERROR: no se pudo revertir automaticamente; carga a mano $revert_file o restaura desde $backup_ruleset" >&2
  fi
}

# 5) Carga atomica + vigilante independiente de esta sesion.
log "Aplicando $file (carga atomica)..."
"$NFT_BIN" -f "$file" || die "nft -f ha fallado; la carga es atomica, no ha cambiado nada"

watchdog_pid=""
setsid nohup bash -c '
  sleep "$1"
  if [ ! -e "$2" ]; then
    "$3" -f "$4" && echo "[vigilante] sin confirmacion: sets revertidos" || echo "[vigilante] FALLO al revertir; carga a mano $4" >&2
  fi
' _ "$CONFIRM_SECONDS" "$confirm_flag" "$NFT_BIN" "$revert_file" >>"$BACKUP_DIR/watchdog.log" 2>&1 </dev/null &
watchdog_pid=$!

echo
log "Sets cargados. Abre OTRA sesion SSH para comprobar que sigues entrando y que la VPN va."
log "Tienes $CONFIRM_SECONDS s. Escribe CONFIRMAR para dejarlos; cualquier otra cosa (o nada) los revierte."

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
  log "Reversion manual: nft -f $revert_file  (y restaura $backup_target en $TARGET si existia)."
  exit 0
fi

kill "$watchdog_pid" 2>/dev/null || true
revert_now
die "no se ha confirmado: revertido. $TARGET no se ha modificado."
