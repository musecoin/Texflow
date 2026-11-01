#!/usr/bin/env bash
# Links dependencies from a pre-provisioned offline package directory into node_modules.
# Used in sandboxes where the npm registry is not reachable. With registry access,
# run `pnpm install` instead (package.json pins the same versions).
set -euo pipefail
SRC="${OFFLINE_NODE_MODULES:-/opt/npm-tools/node_modules}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$ROOT/node_modules/@types" "$ROOT/node_modules/@esbuild"
PKGS="zod ws react react-dom scheduler clsx esbuild playwright playwright-core tailwindcss typescript"
for p in $PKGS; do
  [ -e "$SRC/$p" ] || { echo "missing offline package: $p" >&2; exit 1; }
  ln -sfn "$SRC/$p" "$ROOT/node_modules/$p"
done
ln -sfn "$SRC/@types/node" "$ROOT/node_modules/@types/node"
ln -sfn "$SRC/undici-types" "$ROOT/node_modules/undici-types"
ln -sfn "$SRC/@esbuild/linux-x64" "$ROOT/node_modules/@esbuild/linux-x64"
# workspace packages
mkdir -p "$ROOT/node_modules/@texflow"
ln -sfn "$ROOT/packages/shared" "$ROOT/node_modules/@texflow/shared"
ln -sfn "$ROOT/packages/db" "$ROOT/node_modules/@texflow/db"
echo "offline dependencies linked from $SRC"
