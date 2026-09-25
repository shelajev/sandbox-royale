#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { echo "Install Node.js 22 or newer, then run this again." >&2; exit 1; }
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$SCRIPT_DIR/create-character.mjs" "$@"
