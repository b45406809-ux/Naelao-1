#!/bin/sh
set -eu
export DISPLAY="${DISPLAY:-:99}"
Xvfb "$DISPLAY" -screen 0 "${DISPLAY_GEOMETRY:-1440x900x24}" -nolisten tcp &
fluxbox >/tmp/fluxbox.log 2>&1 &
if [ "${ENABLE_NOVNC:-0}" = "1" ]; then
  x11vnc -display "$DISPLAY" -forever -shared -rfbport 5900 >/tmp/x11vnc.log 2>&1 &
  websockify --web=/usr/share/novnc 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
fi
exec node /app/server.mjs
