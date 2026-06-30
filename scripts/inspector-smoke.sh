#!/usr/bin/env bash
# Headless smoke test: build, boot the server over stdio, list tools, and make a
# live keyless call against the Hyperliquid public API. No HypeDexer key needed.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> building"
npm run build >/dev/null

echo "==> in-memory MCP client smoke (public group, keyless)"
node scripts/smoke-quick.mjs

echo
echo "==> (optional) interactive MCP Inspector:"
echo "    npx @modelcontextprotocol/inspector node dist/index.js"
