#!/usr/bin/env bash
set -euo pipefail

echo "Starting Naelao development environment..."

# If pnpm or wrangler are missing, run node server.ts directly on port 3000
if ! command -v pnpm >/dev/null 2>&1 || ! command -v wrangler >/dev/null 2>&1; then
  echo "Wrangler/pnpm not in PATH; starting platform server on port 3000..."
  exec node server.ts
fi

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  pnpm install
fi

echo "Starting workers in parallel..."
(cd workers/auth && wrangler dev --port 8787) &
AUTH_PID=$!

(cd workers/spaces && wrangler dev --port 8788) &
SPACES_PID=$!

(cd workers/router && wrangler dev --port 8080) &
ROUTER_PID=$!

node server.ts &
SERVER_PID=$!

echo "Workers starting:"
echo "  Auth:   http://localhost:8787"
echo "  Spaces: http://localhost:8788"
echo "  Router: http://localhost:8080 (entry point)"
echo "  Server: http://localhost:3000"

# Wait for all background processes
trap "kill $AUTH_PID $SPACES_PID $ROUTER_PID $SERVER_PID 2>/dev/null" EXIT INT TERM
wait

