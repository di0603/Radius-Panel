#!/usr/bin/env bash
# Prueba de deploy/vpn-gateway-apply-profiles.sh con nft REAL dentro de un netns
# de usuario (no toca el sistema real: ni /etc, ni nftables del host):
#
#   unshare -rn bash deploy/test-apply-profiles-netns.sh <directorio-con-ficheros>
#
# El directorio lo genera:  node --import tsx server/src/scripts/exportNftExamples.ts <dir>
set -uo pipefail
DIR="${1:?Uso: $0 <directorio-con-ficheros>}"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/vpn-gateway-apply-profiles.sh"
T="$(mktemp -d)"
export SKIP_ROOT_CHECK=1 BACKUP_DIR="$T/bk" TARGET="$T/etc/vpn-profiles.nft" NFTABLES_CONF="$T/nftables.conf" CONFIRM_SECONDS=3
echo 'include "/etc/nftables.d/vpn-profiles.nft"' >"$NFTABLES_CONF"
fails=0
ok() { echo "  ok    $*"; }
bad() { echo "  FALLO $*"; fails=$((fails + 1)); }
count_elements() { nft list set inet filter "$1" 2>/dev/null | grep -c 'elements ='; }
expect_rc() { # descripcion rc_esperado comando...
  local desc="$1" want="$2"
  shift 2
  "$@" >"$T/out" 2>&1
  local rc=$?
  if [ "$rc" = "$want" ]; then ok "$desc (rc=$rc)"; else bad "$desc: rc=$rc, esperado $want"; sed 's/^/        /' "$T/out" | head -5; fi
}

SETS="$DIR/vpn-profiles.nft"

echo "== 0) sin los sets en inet filter -> aborta con mensaje claro"
nft flush ruleset
expect_rc "falta el fragmento" 1 bash "$SCRIPT" --check-only "$SETS"
grep -q "NO existe en inet filter" "$T/out" && ok "mensaje: set no existe" || bad "mensaje claro de set inexistente"

echo "== 1) con el fragmento cargado (sets vacios)"
nft -f "$DIR/nftables.conf.ensamblado-sets-vacios"
expect_rc "--check-only valido" 0 bash "$SCRIPT" --check-only "$SETS"
[ "$(count_elements vpn_lan_full_ips)" = 0 ] && ok "check-only no carga nada" || bad "check-only cargo algo"

echo "== 2) ficheros peligrosos -> rechazados sin tocar nada"
printf 'flush ruleset\nflush set inet filter vpn_lan_full_ips\n' >"$T/b1.nft"
printf 'table inet filter {}\n' >"$T/b2.nft"
printf 'flush set inet filter vpn_lan_full_ips\nadd rule inet filter forward accept\n' >"$T/b3.nft"
printf 'flush set inet filter vpn_otro_set\n' >"$T/b4.nft"
printf 'add element inet filter vpn_lan_full_ips { 1.2.3.4 } ; flush ruleset\n' >"$T/b5.nft"
printf 'flush set inet filter vpn_lan_full_ips\nadd element inet filter vpn_lan_full_ips { 1.2.3.4 }\n}\n' >"$T/b6.nft"
printf 'flush set ip nat vpn_lan_full_ips\n' >"$T/b7.nft"
printf '# solo comentarios\n' >"$T/b8.nft"
for f in b1 b2 b3 b4 b5 b6 b7 b8; do
  expect_rc "rechaza $f" 1 bash "$SCRIPT" "$T/$f.nft" </dev/null
done
[ "$(count_elements vpn_lan_full_ips)" = 0 ] && ok "ningun fichero peligroso toco los sets" || bad "algun fichero toco los sets"

echo "== 3) aplicar y NO confirmar -> revierte a sets vacios"
bash "$SCRIPT" "$SETS" </dev/null >"$T/out" 2>&1
rc=$?
[ "$rc" = 1 ] && ok "rc=1 sin confirmar" || bad "rc=$rc sin confirmar"
[ "$(count_elements vpn_lan_full_ips)" = 0 ] && [ "$(count_elements vpn_restricted_dests)" = 0 ] && ok "sets de nuevo vacios" || bad "los sets no se vaciaron"
[ ! -e "$TARGET" ] && ok "TARGET no instalado" || bad "TARGET instalado sin confirmar"

echo "== 4) aplicar y CONFIRMAR -> sets llenos e instalado"
echo CONFIRMAR | bash "$SCRIPT" "$SETS" >"$T/out" 2>&1
rc=$?
[ "$rc" = 0 ] && ok "rc=0" || bad "rc=$rc confirmando"
[ "$(count_elements vpn_lan_full_ips)" = 1 ] && [ "$(count_elements vpn_restricted_dests)" = 1 ] && [ "$(count_elements vpn_restricted_icmp)" = 1 ] && ok "sets rellenos (incluido el concatenado)" || bad "sets sin rellenar"
[ -e "$TARGET" ] && ok "TARGET instalado" || bad "TARGET no instalado"
before="$(nft list set inet filter vpn_restricted_dests | tr -s ' \n\t' ' ')"

echo "== 5) otra version SIN confirmar -> vuelve EXACTAMENTE a la confirmada"
printf 'flush set inet filter vpn_lan_full_ips\nadd element inet filter vpn_lan_full_ips { 192.168.10.200-192.168.10.210 }\nflush set inet filter vpn_restricted_dests\nflush set inet filter vpn_restricted_icmp\n' >"$T/v2.nft"
bash "$SCRIPT" "$T/v2.nft" </dev/null >"$T/out" 2>&1
after="$(nft list set inet filter vpn_restricted_dests | tr -s ' \n\t' ' ')"
[ "$before" = "$after" ] && ok "set concatenado restaurado idéntico" || bad "set concatenado distinto tras revertir"
nft list set inet filter vpn_lan_full_ips | grep -q "192.168.10.105-192.168.10.109" && ok "vpn_lan_full_ips restaurado" || bad "vpn_lan_full_ips no restaurado"
[ "$(count_elements vpn_restricted_icmp)" = 1 ] && ok "set icmp restaurado" || bad "set icmp no restaurado"

echo "== 6) sesion SSH muerta tras aplicar -> el vigilante revierte solo"
CONFIRM_SECONDS=5
export CONFIRM_SECONDS
(sleep 40 | bash "$SCRIPT" "$T/v2.nft") >"$T/out6" 2>&1 &
sleep 2
nft list set inet filter vpn_lan_full_ips | grep -q "192.168.10.200" && ok "v2 aplicado (antes del plazo)" || bad "v2 no se aplico"
pkill -9 -f "bash $SCRIPT"
sleep 6
nft list set inet filter vpn_lan_full_ips | grep -q "192.168.10.105-192.168.10.109" && ok "el vigilante restauro los sets" || bad "el vigilante no restauro"

echo
echo "Fallos: $fails"
[ "$fails" -eq 0 ]
