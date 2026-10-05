#!/usr/bin/env bash
# Prueba FUNCIONAL de los perfiles de acceso en un netns de usuario: no toca el
# sistema real (ni /etc, ni la red de la maquina, ni nftables del host).
#
#   unshare -rn bash deploy/test-vpn-profiles-netns.sh <directorio-con-ficheros>
#
# El directorio lo genera:  node --import tsx server/src/scripts/exportNftExamples.ts <dir>
# (nftables.conf.ensamblado = stand-in de la .29 + fragmento + sets de ejemplo, y
# nftables.conf.ensamblado-sets-vacios). Necesita nft, iproute2, nsenter y python3.
#
# Topologia (todo dentro del namespace de red "gateway", que es el actual):
#   cliente (pool VPN, 6 IPs de origen) --gwvpn-- GATEWAY --gwlan-- lan (.28 .29* .30 .50 ... 8.8.8.8 10.1.1.1)
# El gateway reenvia (ip_forward) y lleva el nftables.conf ensamblado. Se manda un
# paquete (tcp/udp/icmp) desde la IP de cada perfil hacia cada destino y se
# compara el veredicto con el esperado. Con los sets VACIOS no debe pasar nada.
set -uo pipefail

DIR="${1:?Uso: $0 <directorio-con-ficheros>}"
GW_PID=$$
fails=0
checks=0

need() { command -v "$1" >/dev/null || { echo "Falta $1" >&2; exit 2; }; }
need nft; need ip; need nsenter; need python3

# --- namespaces cliente y lan (procesos "sleep" con su propio netns) ---
unshare -n sleep 3600 &
CL_PID=$!
unshare -n sleep 3600 &
LAN_PID=$!
trap 'kill $CL_PID $LAN_PID $(jobs -p) 2>/dev/null' EXIT
sleep 0.3
in_cl() { nsenter -t "$CL_PID" -n "$@"; }
in_lan() { nsenter -t "$LAN_PID" -n "$@"; }

ip link add gwvpn type veth peer name cl0 netns "$CL_PID"
ip link add gwlan type veth peer name lan0 netns "$LAN_PID"
ip link set lo up; ip link set gwvpn up; ip link set gwlan up
in_cl ip link set lo up; in_cl ip link set cl0 up
in_lan ip link set lo up; in_lan ip link set lan0 up
sysctl -qw net.ipv4.ip_forward=1 net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.default.rp_filter=0
in_cl sysctl -qw net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.default.rp_filter=0
in_lan sysctl -qw net.ipv4.conf.all.rp_filter=0 net.ipv4.conf.default.rp_filter=0

GW_IP=192.168.10.29
ip addr add "$GW_IP/32" dev gwlan

# Perfil -> IP de origen (todas /32 en el cliente: un unico "dispositivo" con varias IPs)
declare -A SRC=(
  [lan_full]=192.168.10.105
  [internet_lan_full]=192.168.10.80
  [internet_only]=192.168.10.110
  [lan_restricted]=192.168.10.100
  [internet_lan_restricted]=192.168.10.115
  [sin_perfil]=192.168.10.121
)
for ip in "${SRC[@]}"; do
  in_cl ip addr add "$ip/32" dev cl0
  ip route add "$ip/32" dev gwvpn
done
in_cl ip route add "$GW_IP/32" dev cl0
in_cl ip route add default via "$GW_IP" dev cl0 onlink

# Destinos (todos en "lo" del namespace lan; el gateway llega a cada /32 por gwlan)
LAN_HOSTS="192.168.10.28 192.168.10.30 192.168.10.50 192.168.10.60 192.168.10.5 192.168.10.70 192.168.10.77 8.8.8.8 10.1.1.1"
for ip in $LAN_HOSTS; do
  in_lan ip addr add "$ip/32" dev lo
  ip route add "$ip/32" dev gwlan
done
in_lan ip route add "$GW_IP/32" dev lan0
in_lan ip route add default via "$GW_IP" dev lan0 onlink

# --- listeners (tcp en cada destino/puerto; udp/53 en .5; tcp/22 en el propio gateway) ---
PROBE="$(mktemp)"
cat >"$PROBE" <<'PYEOF'
import socket, sys
mode = sys.argv[1]
if mode == "serve":
    socks = []
    for spec in sys.argv[2:]:
        proto, ip, port = spec.split(":")
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM if proto == "tcp" else socket.SOCK_DGRAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((ip, int(port)))
        if proto == "tcp":
            s.listen(16)
        socks.append((proto, s))
    import selectors
    sel = selectors.DefaultSelector()
    for proto, s in socks:
        sel.register(s, selectors.EVENT_READ, proto)
    while True:
        for key, _ in sel.select():
            if key.data == "tcp":
                c, _ = key.fileobj.accept(); c.close()
            else:
                data, addr = key.fileobj.recvfrom(64); key.fileobj.sendto(b"y", addr)
else:
    proto, src, dst, port = sys.argv[2:6]
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM if proto == "tcp" else socket.SOCK_DGRAM)
    s.settimeout(0.8)
    s.bind((src, 0))
    try:
        if proto == "tcp":
            s.connect((dst, int(port))); print("OK")
        else:
            s.sendto(b"x", (dst, int(port))); s.recvfrom(8); print("OK")
    except Exception:
        print("DROP")
PYEOF
in_lan python3 "$PROBE" serve tcp:192.168.10.28:443 tcp:192.168.10.28:8443 tcp:192.168.10.30:3306 \
  tcp:192.168.10.50:22 tcp:192.168.10.50:80 tcp:192.168.10.70:9999 tcp:192.168.10.77:80 \
  tcp:8.8.8.8:443 tcp:10.1.1.1:80 udp:192.168.10.5:53 &
python3 "$PROBE" serve tcp:"$GW_IP":22 &
sleep 0.5

probe() { # perfil proto dst port -> OK|DROP
  local profile="$1" proto="$2" dst="$3" port="$4"
  if [ "$proto" = icmp ]; then
    in_cl ping -c1 -W1 -I "${SRC[$profile]}" "$dst" >/dev/null 2>&1 && echo OK || echo DROP
  else
    in_cl python3 "$PROBE" probe "$proto" "${SRC[$profile]}" "$dst" "$port"
  fi
}

check() { # perfil etiqueta esperado proto dst port
  local profile="$1" label="$2" expected="$3"
  shift 3
  local got
  got="$(probe "$profile" "$@")"
  checks=$((checks + 1))
  if [ "$got" = "$expected" ]; then
    printf '  ok    %-24s %-16s %s\n' "$profile" "$label" "$got"
  else
    printf '  FALLO %-24s %-16s esperado %s, obtenido %s\n' "$profile" "$label" "$expected" "$got"
    fails=$((fails + 1))
  fi
}

# Destinos: etiqueta proto dst port
DESTS=(
  "radius-443 tcp 192.168.10.28 443"
  "est-8443 tcp 192.168.10.28 8443"
  "gw-ssh-22 tcp $GW_IP 22"
  "mariadb-3306 tcp 192.168.10.30 3306"
  "lista-tcp22 tcp 192.168.10.50 22"
  "no-lista-tcp80 tcp 192.168.10.50 80"
  "lista-icmp icmp 192.168.10.60 0"
  "lista-udp53 udp 192.168.10.5 53"
  "lista-tcp-todos tcp 192.168.10.70 9999"
  "otra-ip-lan tcp 192.168.10.77 80"
  "internet-443 tcp 8.8.8.8 443"
  "privada-10.x tcp 10.1.1.1 80"
)
# Esperado por perfil, en el orden de DESTS (1 = pasa, 0 = cae)
declare -A EXPECT=(
  [lan_full]="1 1 1 1 1 1 1 1 1 1 0 0"
  [internet_lan_full]="1 1 1 1 1 1 1 1 1 1 1 0"
  [internet_only]="0 1 0 0 0 0 0 0 0 0 1 0"
  [lan_restricted]="0 1 0 0 1 0 1 1 1 0 0 0"
  [internet_lan_restricted]="0 1 0 0 1 0 1 1 1 0 1 0"
  [sin_perfil]="0 0 0 0 0 0 0 0 0 0 0 0"
)

run_matrix() { # nombre, 1 = usar EXPECT / 0 = todo cae
  local mode="$1"
  for profile in lan_full internet_lan_full internet_only lan_restricted internet_lan_restricted sin_perfil; do
    read -ra want <<<"${EXPECT[$profile]}"
    [ "$mode" = empty ] && want=(0 0 0 0 0 0 0 0 0 0 0 0)
    i=0
    for d in "${DESTS[@]}"; do
      read -r label proto dst port <<<"$d"
      expected=DROP
      [ "${want[$i]}" = 1 ] && expected=OK
      check "$profile" "$label" "$expected" "$proto" "$dst" "$port"
      i=$((i + 1))
    done
  done
}

echo "== A) sets rellenos (nftables.conf.ensamblado)"
nft -f "$DIR/nftables.conf.ensamblado" || { echo "no carga el nftables.conf ensamblado" >&2; exit 2; }
run_matrix full

echo "== B) sets VACIOS (nftables.conf.ensamblado-sets-vacios): falla cerrando, no pasa nada"
nft -f "$DIR/nftables.conf.ensamblado-sets-vacios" || { echo "no carga el conf con sets vacios" >&2; exit 2; }
run_matrix empty

echo
echo "Comprobaciones: $checks, fallos: $fails"
[ "$fails" -eq 0 ]
