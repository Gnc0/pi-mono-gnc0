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

# Copy files from my-plugins to .pi/extensions (overwrites existing files)
LOCAL_EXT_DIR="$SCRIPT_DIR/.pi/extensions"
if [ -d "$SCRIPT_DIR/my-plugins" ]; then
    echo "Copying files from my-plugins to $LOCAL_EXT_DIR..."
    for file in "$SCRIPT_DIR/my-plugins"/*; do
        name=$(basename "$file")
        if [ -f "$file" ] && [ -e "$LOCAL_EXT_DIR/$name" ]; then
            cp "$file" "$LOCAL_EXT_DIR/"
            echo "  Copied: $name"
        fi
    done
fi

echo "Done! pi-mono built and extensions updated."
