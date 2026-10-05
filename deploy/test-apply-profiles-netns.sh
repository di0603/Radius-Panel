#!/usr/bin/env bash
# Prueba de deploy/vpn-gateway-apply-profiles.sh con nft REAL dentro de un netns
# de usuario (no toca el sistema real: ni /etc, ni nftables del host):
#
#   unshare -rn bash deploy/test-apply-profiles-netns.sh <directorio-con-ficheros>
#
# El directorio lo genera:  node --import tsx server/src/scripts/exportNftExamples.ts <dir>
# El vigilante con la sesion muerta se prueba aparte y N veces: deploy/test-apply-watchdog-netns.sh
set -uo pipefail
DIR="${1:?Uso: $0 <directorio-con-ficheros>}"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/vpn-gateway-apply-profiles.sh"
T="$(mktemp -d)"
export SKIP_ROOT_CHECK=1 BACKUP_DIR="$T/bk" TARGET="$T/etc/nftables.d/vpn-profiles.nft" NFTABLES_CONF="$T/nftables.conf" CONFIRM_SECONDS=3
echo "include \"$TARGET\"" >"$NFTABLES_CONF" # como el final real de nftables.conf (PARTE 4 del fragmento)
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
inode() { stat -c %i "$1" 2>/dev/null; }
leftovers() { ls -A "$(dirname "$TARGET")" 2>/dev/null | grep -c '^\.vpn-profiles\.nft\.' || true; }

SETS="$DIR/vpn-profiles.nft"

echo "== 0) el include de nftables.conf apunta a un fichero que NO existe -> se niega a continuar"
nft flush ruleset
[ ! -e "$TARGET" ] && ok "precondicion: $TARGET no existe" || bad "el fichero ya existia"
expect_rc "--check-only se niega" 1 bash "$SCRIPT" --check-only "$SETS"
grep -q "NO existe: al arrancar, nft -f abortaria" "$T/out" && grep -q -- "--init-empty" "$T/out" && ok "mensaje claro (arrancaria sin firewall) y apunta a --init-empty" || bad "mensaje del include inexistente"
expect_rc "la aplicacion tambien se niega" 1 bash "$SCRIPT" "$SETS" </dev/null
[ ! -e "$TARGET" ] && ok "no se ha creado nada" || bad "se creo $TARGET sin pedirlo"

echo "== 1) --init-empty: version vacia valida, instalada de forma atomica"
expect_rc "--init-empty" 0 bash "$SCRIPT" --init-empty
[ -s "$TARGET" ] && ok "$TARGET existe y no esta vacio" || bad "$TARGET no creado"
[ "$(grep -c '^flush set inet filter vpn_' "$TARGET")" = 7 ] && ok "7 'flush set' (uno por set)" || bad "numero de flush set"
! grep -qE '^(add|table|chain|delete)' "$TARGET" && ok "solo flush set (sin add element, tablas ni cadenas)" || bad "el fichero vacio trae mas cosas"
[ "$(leftovers)" = 0 ] && ok "sin temporales sobrantes" || bad "temporales sobrantes"
[ "$(stat -c %a "$TARGET")" = 644 ] && ok "permisos 644" || bad "permisos $(stat -c %a "$TARGET")"
ino="$(inode "$TARGET")"
expect_rc "--init-empty de nuevo (ya existe y es valido)" 0 bash "$SCRIPT" --init-empty
[ "$(inode "$TARGET")" = "$ino" ] && ok "no lo reescribe si ya existe" || bad "reescribio un fichero existente"

echo "== 2) fichero instalado invalido -> --init-empty y la aplicacion se niegan"
cp "$TARGET" "$T/target.bueno"
printf 'flush ruleset\n' >"$TARGET"
expect_rc "--init-empty con instalado invalido" 1 bash "$SCRIPT" --init-empty
expect_rc "--check-only con instalado invalido" 1 bash "$SCRIPT" --check-only "$SETS"
cp "$T/target.bueno" "$TARGET"

echo "== 3) sin los sets en inet filter -> aborta con mensaje claro"
nft flush ruleset
expect_rc "falta el fragmento" 1 bash "$SCRIPT" --check-only "$SETS"
grep -q "NO existe en inet filter" "$T/out" && ok "mensaje: set no existe" || bad "mensaje claro de set inexistente"

echo "== 4) con el fragmento cargado (sets vacios)"
sed -e 's/meta ipsec exists/iifname "gwvpn"/g' -e 's/meta ipsec missing/iifname != "gwvpn"/g' "$DIR/nftables.conf.ensamblado-sets-vacios" >"$T/empty.conf" # IPsec no existe en el netns
nft -f "$T/empty.conf"
expect_rc "--check-only valido" 0 bash "$SCRIPT" --check-only "$SETS"
[ "$(count_elements vpn_lan_full_ips)" = 0 ] && ok "check-only no carga nada" || bad "check-only cargo algo"

echo "== 5) ficheros peligrosos -> rechazados sin tocar nada"
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

echo "== 6) aplicar y NO confirmar -> revierte a sets vacios y NO toca el fichero instalado"
before_sum="$(sha256sum "$TARGET" | cut -d' ' -f1)"
bash "$SCRIPT" "$SETS" </dev/null >"$T/out" 2>&1
rc=$?
[ "$rc" = 1 ] && ok "rc=1 sin confirmar" || bad "rc=$rc sin confirmar"
[ "$(count_elements vpn_lan_full_ips)" = 0 ] && [ "$(count_elements vpn_restricted_dests)" = 0 ] && ok "sets de nuevo vacios" || bad "los sets no se vaciaron"
[ "$(sha256sum "$TARGET" | cut -d' ' -f1)" = "$before_sum" ] && ok "TARGET intacto" || bad "TARGET modificado sin confirmar"

echo "== 7) aplicar y CONFIRMAR -> sets llenos e instalado de forma atomica"
ino="$(inode "$TARGET")"
echo CONFIRMAR | bash "$SCRIPT" "$SETS" >"$T/out" 2>&1
rc=$?
[ "$rc" = 0 ] && ok "rc=0" || bad "rc=$rc confirmando"
[ "$(count_elements vpn_lan_full_ips)" = 1 ] && [ "$(count_elements vpn_restricted_dests)" = 1 ] && [ "$(count_elements vpn_restricted_icmp)" = 1 ] && ok "sets rellenos (incluido el concatenado)" || bad "sets sin rellenar"
cmp -s "$SETS" "$TARGET" && ok "TARGET == fichero aplicado" || bad "TARGET distinto del aplicado"
[ "$(inode "$TARGET")" != "$ino" ] && ok "sustituido por rename (inodo nuevo), no reescrito en sitio" || bad "mismo inodo: reescrito en sitio"
[ "$(leftovers)" = 0 ] && ok "sin temporales sobrantes" || bad "temporales sobrantes"
before="$(nft list set inet filter vpn_restricted_dests | tr -s ' \n\t' ' ')"

echo "== 8) la sustitucion es atomica: un lector concurrente nunca ve el fichero a medias"
# version grande (decenas de miles de lineas de comentario: el script las admite) para que una escritura NO
# atomica fuera observable; el contenido real es pequeno y valido
{
  for i in $(seq 1 30000); do echo "# relleno $i para que el fichero sea grande y una escritura no atomica se note"; done
  echo "flush set inet filter vpn_lan_full_ips"
  echo "add element inet filter vpn_lan_full_ips { 192.168.10.150-192.168.10.159 }"
} >"$T/big.nft"
old_size="$(stat -c %s "$TARGET")"
new_size="$(stat -c %s "$T/big.nft")"
( # lector: tamanos distintos de los dos validos = fichero a medias (o inexistente)
  bad_reads=0
  for _ in $(seq 1 4000); do
    s="$(stat -c %s "$TARGET" 2>/dev/null || echo 0)"
    [ "$s" = "$old_size" ] || [ "$s" = "$new_size" ] || bad_reads=$((bad_reads + 1))
  done
  echo "$bad_reads" >"$T/bad_reads"
) &
reader=$!
echo CONFIRMAR | bash "$SCRIPT" "$T/big.nft" >"$T/out" 2>&1
wait "$reader"
[ "$(cat "$T/bad_reads")" = 0 ] && ok "0 lecturas de un fichero a medias o inexistente durante la sustitucion" || bad "$(cat "$T/bad_reads") lecturas a medias"
cmp -s "$T/big.nft" "$TARGET" && ok "contenido nuevo completo" || bad "contenido distinto"
# se vuelve al estado del paso 7 para lo siguiente
nft -f "$SETS"
cp "$SETS" "$TARGET"

echo "== 9) otra version SIN confirmar -> vuelve EXACTAMENTE a la confirmada"
printf 'flush set inet filter vpn_lan_full_ips\nadd element inet filter vpn_lan_full_ips { 192.168.10.200-192.168.10.210 }\nflush set inet filter vpn_restricted_dests\nflush set inet filter vpn_restricted_icmp\n' >"$T/v2.nft"
bash "$SCRIPT" "$T/v2.nft" </dev/null >"$T/out" 2>&1
after="$(nft list set inet filter vpn_restricted_dests | tr -s ' \n\t' ' ')"
[ "$before" = "$after" ] && ok "set concatenado restaurado identico" || bad "set concatenado distinto tras revertir"
nft list set inet filter vpn_lan_full_ips | grep -q "192.168.10.105-192.168.10.109" && ok "vpn_lan_full_ips restaurado" || bad "vpn_lan_full_ips no restaurado"
[ "$(count_elements vpn_restricted_icmp)" = 1 ] && ok "set icmp restaurado" || bad "set icmp no restaurado"

echo
echo "Fallos: $fails"
[ "$fails" -eq 0 ]
