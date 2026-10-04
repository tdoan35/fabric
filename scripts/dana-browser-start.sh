#!/usr/bin/env bash
# Service startup re-applies firewall rules after every Sprite wake. Chromium runs as
# an unprivileged dedicated UID, with no route except the validating public proxy.
set -euo pipefail
cd /opt/fabric-dana
uid=$(id -u dana-browser)
# Native nftables meta skuid works on the Sprite kernel; xt_owner/iptables does not.
# The inet table covers IPv4 and IPv6. Install rules before launching the browser UID.
if nft list table inet fabric_dana >/dev/null 2>&1; then nft delete table inet fabric_dana; fi
nft -f - <<RULES
table inet fabric_dana {
  chain output {
    type filter hook output priority 0; policy accept;
    meta skuid $uid ct state established,related accept
    meta skuid $uid ip daddr 127.0.0.1 tcp dport 9224 accept
    meta skuid $uid reject
  }
}
RULES
rm -f /tmp/.X99-lock
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp &
xvfb=$!
export DISPLAY=:99
node dana-browser-proxy.mjs &
proxy=$!
# View-only VNC stays on loopback, behind private Sprite authentication. A fresh
# password each boot prevents a previously authenticated viewer from silently reconnecting.
for i in $(seq 1 40); do test -S /tmp/.X11-unix/X99 && break; sleep .1; done
mkdir -p /run/fabric-dana
chmod 700 /run/fabric-dana
password=$(openssl rand -hex 12)
x11vnc -storepasswd "$password" /run/fabric-dana/vnc.pass >/dev/null
x11vnc -display :99 -localhost -viewonly -forever -rfbauth /run/fabric-dana/vnc.pass -rfbport 5900 >/var/log/fabric-dana-vnc.log 2>&1 &
vnc=$!
websockify --web=/usr/share/novnc 8080 127.0.0.1:5900 >/var/log/fabric-dana-novnc.log 2>&1 &
viewer=$!
# Drop inherited Sprite capabilities and prevent setuid/file-capability elevation.
setpriv --reuid=dana-browser --regid=dana-browser --clear-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs env DISPLAY=:99 PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 PLAYWRIGHT_BROWSERS_PATH=/opt/fabric-dana/browsers node /opt/fabric-dana/dana-browser-worker.mjs &
worker=$!
trap 'kill "$xvfb" "$proxy" "$vnc" "$viewer" "$worker" 2>/dev/null || true' EXIT
# A dead proxy must take the worker down too; the Sprite service restarts the full stack.
wait -n "$xvfb" "$proxy" "$vnc" "$viewer" "$worker"
exit 1
