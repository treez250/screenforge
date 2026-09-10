#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Use nvm's node if the developer has nvm installed, without hardcoding a
# version or a home directory.
if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null 2>&1 || true
fi

exec ./node_modules/.bin/electron .
