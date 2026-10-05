#!/usr/bin/env bash
# Prueba REPETIDA del vigilante de vpn-gateway-apply-profiles.sh con nft real en un netns de usuario
# (no toca el sistema real): aplica una version nueva de los sets, MATA la sesion (kill -9 del script
# en primer plano) y comprueba que el vigilante restaura el estado anterior solo.
#
#   unshare -rn bash deploy/test-apply-watchdog-netns.sh <directorio-con-ficheros> [repeticiones=50] [script]
#
# Modos (variable MODE):
#   asap   (por defecto) mata la sesion en el INSTANTE en que los sets nuevos son visibles: la peor
#          carrera posible (sesion muerta justo despues de la carga atomica).
#   samesecond  como asap, pero con el reloj CONGELADO (un `date` simulado que devuelve siempre el mismo
#          sello de 1 s) y SIN limpiar $BACKUP_DIR entre repeticiones: antes de cada una se hace una
#          ejecucion confirmada. Reproduce el peor caso de "dos ejecuciones en el mismo segundo".
#   lateconfirm  la sesion sigue VIVA y se confirma en los ULTIMOS segundos del prompt (CONFIRM_SECONDS - 0.3 s,
#          con CONFIRM_SECONDS=3): el resultado tiene que ser "confirmado" -rc 0, sets nuevos, fichero instalado-
#          y el vigilante NO debe revertir despues (se espera CONFIRM_SECONDS + 10 + 2 s para comprobarlo).
#   fixed  temporizaciones fijas como la prueba original: PRE_S segundos despues de lanzar mata la
#          sesion y comprueba UNA vez a los POST_S segundos (CONFIRM_SECONDS=3: el vigilante actua a los 13 s). Con trazas de tiempos.
#
# El directorio lo genera:  node --import tsx server/src/scripts/exportNftExamples.ts <dir>
set -uo pipefail
DIR="${1:?Uso: $0 <directorio-con-ficheros> [repeticiones] [script]}"
RUNS="${2:-50}"
SCRIPT="${3:-$(cd "$(dirname "$0")" && pwd)/vpn-gateway-apply-profiles.sh}"
MODE="${MODE:-asap}"
PRE_S="${PRE_S:-2}"
POST_S="${POST_S:-16}"
T="$(mktemp -d)"
if [ "$MODE" = fixed ] || [ "$MODE" = lateconfirm ]; then CONFIRM_SECONDS="${CONFIRM_SECONDS:-3}"; else CONFIRM_SECONDS="${CONFIRM_SECONDS:-1}"; fi
WATCHDOG_SECONDS=$((CONFIRM_SECONDS + 10)) # el vigilante espera CONFIRM_SECONDS + 10 (ver el script)
export SKIP_ROOT_CHECK=1 BACKUP_DIR="$T/bk" TARGET="$T/etc/vpn-profiles.nft" NFTABLES_CONF="$T/nftables.conf" CONFIRM_SECONDS
echo "include \"$TARGET\"" >"$NFTABLES_CONF"
mkdir -p "$T/etc"
cp "$DIR/vpn-profiles.nft" "$TARGET" # que el include exista (la version nueva del script lo exige)

# fragmento cargado (IPsec no existe en el netns: se sustituye por la interfaz del cliente)
sed -e 's/meta ipsec exists/iifname "gwvpn"/g' -e 's/meta ipsec missing/iifname != "gwvpn"/g' \
  "$DIR/nftables.conf.ensamblado-sets-vacios" >"$T/empty.conf"
nft -f "$T/empty.conf" || exit 2

# estado base conocido: vpn_lan_full_ips = 192.168.10.105-109; la version nueva lo cambia a .200-.210
nft -f "$DIR/vpn-profiles.nft" || exit 2
printf 'flush set inet filter vpn_lan_full_ips\nadd element inet filter vpn_lan_full_ips { 192.168.10.200-192.168.10.210 }\n' >"$T/v2.nft"
state() { nft list set inet filter vpn_lan_full_ips | tr -s ' \n\t' ' '; }
base="$(state)"
case "$base" in *192.168.10.105-192.168.10.109*) ;; *) echo "estado base inesperado: $base" >&2; exit 2 ;; esac

now_ms() { date +%s%3N; }
if [ "$MODE" = samesecond ]; then
  mkdir -p "$T/fakebin"
  printf '#!/bin/sh
case "$*" in "+%%Y%%m%%d-%%H%%M%%S") echo 20260101-000000 ;; *) exec /bin/date "$@" ;; esac
' >"$T/fakebin/date"
  chmod +x "$T/fakebin/date"
  export PATH="$T/fakebin:$PATH"
  printf 'flush set inet filter vpn_lan_full_ips
add element inet filter vpn_lan_full_ips { 192.168.10.105-192.168.10.109 }
' >"$T/v1.nft"
fi
pass=0
fail=0
for i in $(seq 1 "$RUNS"); do
  if [ "$MODE" = lateconfirm ]; then
    rm -rf "$BACKUP_DIR"
    ( sleep "$(awk "BEGIN { print $CONFIRM_SECONDS - 0.3 }")"; echo CONFIRMAR ) | bash "$SCRIPT" "$T/v2.nft" >"$T/out.$i" 2>&1
    rc=$?
    sleep $((WATCHDOG_SECONDS + 2)) # tiempo de sobra para que un vigilante mal desarmado revirtiera
    if [ "$rc" = 0 ] && [ "$(state | grep -c '192.168.10.200')" = 1 ] && cmp -s "$T/v2.nft" "$TARGET"; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1))
      echo "  FALLO en la repeticion $i (confirmacion tardia): rc=$rc, estado: $(state)"
      sed 's/^/        /' "$T/out.$i" | tail -6
      echo "        watchdog.log: $(tail -2 "$BACKUP_DIR/watchdog.log" 2>/dev/null)"
    fi
    nft -f "$DIR/vpn-profiles.nft"; cp "$DIR/vpn-profiles.nft" "$TARGET" # estado base para la siguiente
    continue
  fi
  if [ "$MODE" = samesecond ]; then
    # ejecucion CONFIRMADA justo antes (mismo "segundo"): deja su confirm.<sello> en $BACKUP_DIR
    echo CONFIRMAR | bash "$SCRIPT" "$T/v1.nft" >"$T/conf.$i" 2>&1
  else
    rm -rf "$BACKUP_DIR"
  fi
  t0=$(now_ms)
  (sleep 60 | bash "$SCRIPT" "$T/v2.nft") >"$T/out.$i" 2>&1 &
  t_applied=""
  if [ "$MODE" = fixed ]; then
    # vigia en segundo plano solo para TRAZAR cuando se ve v2 (no altera la prueba)
    (until nft list set inet filter vpn_lan_full_ips 2>/dev/null | grep -q '192.168.10.200'; do :; done; echo "$(now_ms)" >"$T/applied.$i") &
    tracer=$!
    sleep "$PRE_S"
    pkill -9 -f "bash $SCRIPT"
    pkill -9 -f "sleep 60" 2>/dev/null
    t_kill=$(now_ms)
    sleep "$POST_S"
    kill "$tracer" 2>/dev/null
    t_check=$(now_ms)
    restored=0
    [ "$(state)" = "$base" ] && restored=1
    [ -s "$T/applied.$i" ] && t_applied=$(cat "$T/applied.$i")
  else
    start=$SECONDS
    until nft list set inet filter vpn_lan_full_ips 2>/dev/null | grep -q '192.168.10.200'; do
      [ $((SECONDS - start)) -gt 20 ] && break
    done
    t_applied=$(now_ms)
    pkill -9 -f "bash $SCRIPT"
    pkill -9 -f "sleep 60" 2>/dev/null
    t_kill=$(now_ms)
    # el vigilante tiene CONFIRM_SECONDS + 10 s para restaurar; se espera hasta CONFIRM_SECONDS + 10 + 6 s
    restored=0
    start=$SECONDS
    while [ $((SECONDS - start)) -le $((WATCHDOG_SECONDS + 6)) ]; do
      if [ "$(state)" = "$base" ]; then restored=1; break; fi
      sleep 0.2
    done
    t_check=$(now_ms)
  fi
  if [ "$restored" = 1 ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "  FALLO en la repeticion $i (los sets no estaban restaurados al comprobar)."
    echo "        lanzado->aplicado: ${t_applied:+$((t_applied - t0))} ms; lanzado->kill: $((t_kill - t0)) ms; lanzado->comprobacion: $((t_check - t0)) ms; plazo del vigilante: $((WATCHDOG_SECONDS * 1000)) ms desde que se arma"
    echo "        salida del script:"
    sed 's/^/          /' "$T/out.$i" | tail -8
    echo "        watchdog.log: $(tail -2 "$BACKUP_DIR/watchdog.log" 2>/dev/null)"
    echo "        revert file: $(ls "$BACKUP_DIR" 2>/dev/null | grep -c revert) | procesos 'sleep $CONFIRM_SECONDS' vivos: $(pgrep -fc "sleep $CONFIRM_SECONDS" || true)"
    echo "        estado actual: $(state)"
  fi
  # que ningun vigilante rezagado interfiera con la repeticion siguiente
  # en fixed la comprobacion ya fue DESPUES del plazo del vigilante: no hace falta esperar otra vez
  if [ "$MODE" = fixed ]; then sleep 1; else sleep $((WATCHDOG_SECONDS + 1)); fi
  [ "$(state)" = "$base" ] || nft -f "$DIR/vpn-profiles.nft"
done

echo "Modo $MODE. Repeticiones: $RUNS, restauradas por el vigilante: $pass, fallos: $fail"
[ "$fail" -eq 0 ]
