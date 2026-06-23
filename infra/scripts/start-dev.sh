#!/usr/bin/env bash
set -euo pipefail

echo "Starting Naelao development environment..."

# Check dependencies
command -v pnpm >/dev/null 2>&1 || { echo "pnpm is required. Install: npm i -g pnpm@9"; exit 1; }
command -v wrangler >/dev/null 2>&1 || { echo "wrangler is required. Install: npm i -g wrangler"; exit 1; }

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  pnpm install
fi

echo "Starting workers in parallel..."
# Use concurrently or simple background processes
(cd workers/auth && wrangler dev --port 8787) &
AUTH_PID=$!

(cd workers/spaces && wrangler dev --port 8788) &
SPACES_PID=$!

(cd workers/router && wrangler dev --port 8080) &
ROUTER_PID=$!

echo "Workers starting:"
echo "  Auth:   http://localhost:8787"
echo "  Spaces: http://localhost:8788"
echo "  Router: http://localhost:8080 (entry point)"

# Wait for all background processes
trap "kill $AUTH_PID $SPACES_PID $ROUTER_PID 2>/dev/null" EXIT INT TERM
wait
