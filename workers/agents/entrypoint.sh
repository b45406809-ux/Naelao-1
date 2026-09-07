#!/bin/bash

# Start Xvfb virtual display server on screen 99 (1280x800x24)
Xvfb :99 -screen 0 1280x800x24 &
export DISPLAY=:99

# Start Fluxbox window manager
fluxbox &

# Start x11vnc bridged over noVNC on port 8081
websockify --web=/usr/share/novnc/ 8081 localhost:5900 &
x11vnc -display :99 -forever -shared -nopw &

# Keep container alive by executing sandbox control server daemon
node /app/server.mjs
