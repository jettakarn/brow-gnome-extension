#!/usr/bin/env bash
# Build brow@jettakarn.shell-extension.zip for GitHub Releases and
# extensions.gnome.org. Usage: tools/pack.sh [output-dir]
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${1:-$root/dist}"
mkdir -p "$out"

cd "$root"
glib-compile-schemas schemas

gnome-extensions pack \
    --force \
    --out-dir="$out" \
    --extra-source=lib \
    --extra-source=fonts \
    .

echo "Built: $out/brow@jettakarn.shell-extension.zip"
