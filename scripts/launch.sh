#!/usr/bin/env bash
# Launch the HypeDexer MCP server under WSL for Claude Desktop (Windows).
#
# Why this exists: Claude Desktop spawns the server with a NON-interactive,
# NON-login shell, so an nvm-installed node is not on PATH (`wsl.exe node ...`
# fails with "command not found"). We resolve node via nvm here instead.
#
# CRITICAL: never write to stdout — it carries the MCP JSON-RPC stream. All nvm
# chatter is redirected to /dev/null; node inherits stdio directly via `exec`.

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
  nvm use --silent default >/dev/null 2>&1 || true
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$DIR/dist/index.js" "$@"
