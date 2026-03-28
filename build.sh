#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Building pi-mono..."
cd "$SCRIPT_DIR"

# Build
npm run build

# Copy extensions to global
GLOBAL_EXT_DIR="$HOME/.pi/agent/extensions"
mkdir -p "$GLOBAL_EXT_DIR"
echo "Copying extensions to $GLOBAL_EXT_DIR..."
cp -r "$SCRIPT_DIR/.pi/extensions"/* "$GLOBAL_EXT_DIR/"

echo "Done! pi-mono built and extensions updated."
