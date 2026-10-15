#!/bin/sh
set -eu
# Cloudflare HTTPS interception presents its managed CA at this runtime path. Trust it only
# inside this short-lived package-install container; local Docker builds may omit the mount.
if [ -r /etc/cloudflare/certs/cloudflare-containers-ca.crt ]; then
  install -m 0644 /etc/cloudflare/certs/cloudflare-containers-ca.crt /usr/local/share/ca-certificates/cloudflare-containers-ca.crt
  update-ca-certificates >/dev/null
fi
export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 "${DISPLAY_GEOMETRY:-1440x900x24}" -nolisten tcp &
fluxbox >/tmp/fluxbox.log 2>&1 &
if [ "${ENABLE_NOVNC:-0}" = "1" ]; then
  x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
  websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
fi
exec node /app/server.mjs
