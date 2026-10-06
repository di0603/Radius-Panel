#!/usr/bin/env bash
# Aplica el fichero de sets de los perfiles de acceso VPN (vpn-profiles.nft) en
# la VM VPN (192.168.10.29) con "confirmar o revertir": si no confirmas en 60 s (o, con la
# sesion muerta, a los 70 s)
# (o se te cae la sesion SSH porque las reglas te dejaron sin acceso), el estado
# anterior de los sets se restaura SOLO.
#
# El fichero SOLO rellena sets que YA existen dentro de "inet filter"
# (flush set + add element, en una carga atomica): las reglas que los usan
# viven en /etc/nftables.conf (fragmento revisado e integrado a mano una vez,
# ver el boton "Fragmento de nftables.conf" del panel). Este script NO crea
# tablas, cadenas ni reglas, y NO edita /etc/nftables.conf.
#
# NO lo lanza el panel ni ningun timer: lo revisas y lo ejecutas tu, como root.
#
# PRIMERA VEZ (ANTES de integrar el fragmento en /etc/nftables.conf):
#   sudo deploy/vpn-gateway-apply-profiles.sh --init-empty
# Crea (de forma atomica: temporal + rename) la version VACIA valida de
# $TARGET -solo con los "flush set"- si no existe. Es imprescindible: el
# fragmento termina con `include "$TARGET"` y, si ese fichero no existe, nft -f
# aborta TODA la carga de nftables.conf y la maquina arranca sin firewall.
#
# USO NORMAL:
#   1. Descarga vpn-profiles.nft desde el panel (VPN -> Perfiles de acceso) y
#      copialo a la .29. Revisalo: nada de el se carga hasta el paso 3.
#   2. sudo deploy/vpn-gateway-apply-profiles.sh --check-only vpn-profiles.nft
#   3. sudo deploy/vpn-gateway-apply-profiles.sh vpn-profiles.nft
#      -> abre OTRA sesion SSH para comprobar que sigues entrando, vuelve a esta
#         y escribe CONFIRMAR antes de que acabe la cuenta atras.
#
# Que hace, en orden (parando en el primer fallo):
#   - SE NIEGA A CONTINUAR si /etc/nftables.conf incluye $TARGET y ese fichero
#     no existe (el arranque abortaria), o si existe pero no es un fichero de
#     sets valido.
#   - Rechaza el fichero si trae CUALQUIER linea que no sea comentario, linea
#     vacia, "flush set inet filter <set vpn_...>" o "add element inet filter
#     <set vpn_...> { ... }" (adios a "flush ruleset", tablas, cadenas, reglas).
#   - Comprueba que cada set que toca EXISTE en inet filter; si no, aborta con
#     un mensaje claro (falta integrar el fragmento en /etc/nftables.conf).
#   - nft -c -f (comprueba la sintaxis sin cargar nada).
#   - Copia de seguridad en $BACKUP_DIR: nftables.conf, el fichero instalado
#     anterior, el ruleset completo y el contenido actual de los sets.
#   - ARMA el vigilante (independiente de esta sesion: setsid) ANTES de cargar y
#     despues carga de forma atomica (nft -f es una unica transaccion). Armarlo
#     antes elimina la ventana en la que una sesion muerta justo tras la carga
#     dejaba los sets nuevos sin vigilante. El vigilante espera $CONFIRM_SECONDS + 10 s (el prompt espera
#     $CONFIRM_SECONDS): con la sesion VIVA y sin confirmar, el propio script revierte al agotarse el
#     prompt; el vigilante (70 s por defecto) solo actua si la sesion ha muerto, y una confirmacion
#     en los ultimos segundos nunca coincide con su reversion.
#   - Solo tras CONFIRMAR instala el fichero en $TARGET, de forma atomica
#     (temporal en el mismo directorio + rename): nunca queda a medias.
#
# Revertir a mano despues de confirmar: restaura el fichero anterior de
# $BACKUP_DIR/run.<fecha>.<id>/vpn-profiles.nft.installed en $TARGET y vuelve a
# cargarlo (nft -f), o carga $BACKUP_DIR/run.<fecha>.<id>/revert-vpn-profiles.nft.
#
# Variables (todas opcionales): NFT_BIN, NFTABLES_CONF, TARGET, BACKUP_DIR,
# CONFIRM_SECONDS.
set -euo pipefail

NFT_BIN="${NFT_BIN:-nft}"
NFTABLES_CONF="${NFTABLES_CONF:-/etc/nftables.conf}"
TARGET="${TARGET:-/etc/nftables.d/vpn-profiles.nft}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/vpn-gateway}"
CONFIRM_SECONDS="${CONFIRM_SECONDS:-60}"
# El vigilante espera MAS que el prompt: "read -t" espera CONFIRM_SECONDS y el vigilante CONFIRM_SECONDS + 10.
# Asi una confirmacion en los ultimos segundos (touch de la bandera + kill del vigilante) nunca coincide con la
# reversion del vigilante: el margen de 10 s cubre la latencia de tocar la bandera, matar y cualquier retraso.
WATCHDOG_MARGIN_SECONDS=10
FAMILY="inet"
TABLE="filter"
# Sets que este script puede tocar (los mismos que declara el fragmento).
ALLOWED_SETS="vpn_lan_restricted_ips vpn_lan_full_ips vpn_internet_only_ips vpn_internet_lan_restricted_ips vpn_internet_lan_full_ips vpn_restricted_dests vpn_restricted_icmp"
set_re="vpn_[a-z_]+"

usage() {
  echo "Uso: $0 --init-empty" >&2
  echo "     $0 [--check-only] <vpn-profiles.nft>" >&2
  exit 2
}

check_only=0
init_empty=0
file=""
for arg in "$@"; do
  case "$arg" in
    --check-only) check_only=1 ;;
    --init-empty) init_empty=1 ;;
    -h | --help) usage ;;
    -*) usage ;;
    *)
      [ -z "$file" ] || usage
      file="$arg"
      ;;
  esac
done
if [ "$init_empty" -eq 1 ]; then
  { [ -z "$file" ] && [ "$check_only" -eq 0 ]; } || usage
else
  [ -n "$file" ] || usage
fi

log() { echo "[$(date '+%H:%M:%S')] $*"; }
die() {
  echo "ERROR: $*" >&2
  exit 1
}

case "$CONFIRM_SECONDS" in
  '' | *[!0-9]*) die "CONFIRM_SECONDS debe ser un numero de segundos (es '$CONFIRM_SECONDS')" ;;
esac
WATCHDOG_SECONDS=$((CONFIRM_SECONDS + WATCHDOG_MARGIN_SECONDS))

if [ "${SKIP_ROOT_CHECK:-0}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  die "ejecutalo como root (sudo): nft necesita privilegios"
fi

# Valida un fichero de sets con una lista blanca estricta de lineas: solo rellena
# sets vpn_*, nada mas. Deja en REFERENCED_SETS los sets que toca.
REFERENCED_SETS=""
validate_sets_file() {
  local f="$1" bad name
  [ -r "$f" ] || die "no se puede leer $f"
  bad="$(
    grep -Ev \
      -e '^[[:space:]]*$' \
      -e '^[[:space:]]*#' \
      -e "^flush set $FAMILY $TABLE $set_re\$" \
      -e "^add element $FAMILY $TABLE $set_re \\{ [0-9A-Za-z./, -]+ \\}\$" \
      "$f" || true
  )"
  if [ -n "$bad" ]; then
    echo "Lineas no permitidas en $f (solo 'flush set' y 'add element' sobre sets vpn_*):" >&2
    echo "$bad" | head -5 >&2
    die "$f no es un fichero de sets valido; no se ha tocado nada"
  fi
  REFERENCED_SETS="$(grep -Eo "^(flush set|add element) $FAMILY $TABLE $set_re" "$f" | awk '{print $NF}' | sort -u)"
  [ -n "$REFERENCED_SETS" ] || die "$f no rellena ningun set"
  for name in $REFERENCED_SETS; do
    case " $ALLOWED_SETS " in
      *" $name "*) ;;
      *) die "el set '$name' no esta entre los que gestiona este script ($ALLOWED_SETS)" ;;
    esac
  done
}

# Instalacion ATOMICA: temporal en el MISMO directorio + rename. Nunca deja el destino a medias.
atomic_install() {
  local src="$1" dest="$2" dir tmp
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  tmp="$(mktemp "$dir/.$(basename "$dest").XXXXXX")"
  if ! { cp "$src" "$tmp" && chmod 0644 "$tmp"; }; then
    rm -f "$tmp"
    die "no se pudo preparar el temporal junto a $dest"
  fi
  sync "$tmp" 2>/dev/null || sync 2>/dev/null || true
  mv -f "$tmp" "$dest" || {
    rm -f "$tmp"
    die "no se pudo renombrar el temporal a $dest"
  }
}

# --init-empty: version vacia valida de $TARGET (solo los flush set), ANTES de integrar el fragmento.
if [ "$init_empty" -eq 1 ]; then
  if [ -e "$TARGET" ]; then
    validate_sets_file "$TARGET"
    log "$TARGET ya existe y es un fichero de sets valido: no se toca."
    exit 0
  fi
  empty_src="$(mktemp)"
  {
    echo "#!/usr/sbin/nft -f"
    echo "# Version VACIA valida de los sets de los perfiles de acceso VPN (solo 'flush set')."
    echo "# La crea deploy/vpn-gateway-apply-profiles.sh --init-empty ANTES de integrar el fragmento en"
    echo "# /etc/nftables.conf: el 'include' de este fichero no puede apuntar a algo que no existe."
    for name in $ALLOWED_SETS; do echo "flush set $FAMILY $TABLE $name"; done
  } >"$empty_src"
  validate_sets_file "$empty_src"
  atomic_install "$empty_src" "$TARGET"
  rm -f "$empty_src"
  log "Creado $TARGET (version vacia valida, instalacion atomica)."
  log "Ya puedes integrar el fragmento en /etc/nftables.conf (su 'include' apunta a este fichero)."
  exit 0
fi

# 0) El include de nftables.conf no puede apuntar a un fichero que no existe: nft -f abortaria TODA la
#    carga al arrancar y la maquina se quedaria sin firewall.
include_found=0
if [ -f "$NFTABLES_CONF" ]; then
  while IFS= read -r line; do
    inc="$(printf '%s\n' "$line" | sed -n 's/^[[:space:]]*include[[:space:]]*"\([^"]*\)".*$/\1/p')"
    [ -n "$inc" ] || continue
    case "$inc" in *'*'* | *'?'* | *'['*) continue ;; esac # comodines: nft admite que no haya coincidencias
    if [ "$inc" = "$TARGET" ]; then
      include_found=1
      [ -e "$TARGET" ] || die "$NFTABLES_CONF incluye $TARGET y ese fichero NO existe: al arrancar, nft -f abortaria toda la carga y la maquina se quedaria sin firewall. Crealo ya con: $0 --init-empty"
    elif [ ! -e "$inc" ]; then
      log "AVISO: $NFTABLES_CONF incluye $inc, que no existe (no es nuestro, pero al arrancar nft -f abortaria)."
    fi
  done <"$NFTABLES_CONF"
fi
if [ -e "$TARGET" ]; then
  validate_sets_file "$TARGET" # si esta instalado, tiene que ser valido
fi

# 1) Lista blanca estricta de lineas del fichero a aplicar.
validate_sets_file "$file"
referenced_sets="$REFERENCED_SETS"

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

if [ -f "$NFTABLES_CONF" ] && [ "$include_found" -eq 0 ]; then
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
# Directorio UNICO por ejecucion (mktemp -d): todo lo de esta ejecucion -copias, fichero de reversion y la
# bandera de confirmacion- vive aqui y nunca puede coincidir con lo de otra. (Antes los nombres salian solo
# de un sello de 1 s: dos ejecuciones en el mismo segundo compartian "confirm.<sello>" y el vigilante de la
# segunda veia la bandera de la primera, creia que ya estaba confirmada y NO revertia.)
run_dir="$(mktemp -d "$BACKUP_DIR/run.$stamp.XXXXXX")"
backup_conf="$run_dir/nftables.conf"
backup_target="$run_dir/vpn-profiles.nft.installed"
backup_ruleset="$run_dir/ruleset.nft"
revert_file="$run_dir/revert-vpn-profiles.nft"
confirm_flag="$run_dir/confirm"

[ ! -f "$NFTABLES_CONF" ] || cp -p "$NFTABLES_CONF" "$backup_conf"
[ ! -f "$TARGET" ] || cp -p "$TARGET" "$backup_target"
"$NFT_BIN" list ruleset >"$backup_ruleset"
log "Copias de seguridad en $run_dir."

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

# 5) ARMAR el vigilante ANTES de cargar (setsid: sobrevive a que se muera esta sesion) y despues cargar.
#    Si la sesion muere en cualquier punto a partir de aqui -incluso justo despues de la carga atomica-
#    el vigilante ya existe y restaura los sets. Si no llega a cargarse nada, restaurar es inocuo
#    (el fichero de reversion es el estado actual).
watchdog_pid=""
setsid nohup bash -c '
  sleep "$1"
  if [ ! -e "$2" ]; then
    "$3" -f "$4" && echo "[vigilante] sin confirmacion: sets revertidos" || echo "[vigilante] FALLO al revertir; carga a mano $4" >&2
  fi
' _ "$WATCHDOG_SECONDS" "$confirm_flag" "$NFT_BIN" "$revert_file" >>"$BACKUP_DIR/watchdog.log" 2>&1 </dev/null &
watchdog_pid=$!

log "Aplicando $file (carga atomica)..."
if ! "$NFT_BIN" -f "$file"; then
  kill "$watchdog_pid" 2>/dev/null || true
  die "nft -f ha fallado; la carga es atomica, no ha cambiado nada"
fi

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
  atomic_install "$file" "$TARGET"
  log "Confirmado. Instalado en $TARGET (instalacion atomica)."
  log "Reversion manual: nft -f $revert_file  (y restaura $backup_target en $TARGET si existia)."
  exit 0
fi

kill "$watchdog_pid" 2>/dev/null || true
revert_now
die "no se ha confirmado: revertido. $TARGET no se ha modificado."
