#!/usr/bin/env bash
# Build the Windows desktop staging tree from a finished production build.
# Usage: bash packaging/prepare-stage.sh (from the repo root, after `npm run build`).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/dist/stage"
APP="$STAGE/app"
NODE_BIN="${NODE_BIN:-C:/Users/saiya/tools/node-v22.23.5-win-x64/node.exe}"

rm -rf "$STAGE"
mkdir -p "$APP"

# Next standalone output, with the CDN-ready assets Next intentionally omits.
cp -r "$ROOT/.next/standalone/." "$APP/"
cp -r "$ROOT/.next/static" "$APP/.next/static"
cp -r "$ROOT/public" "$APP/public"

# Next 16 standalone omits the app-route runtimes that route handlers require at
# runtime (they are resolved through next/dist/compiled/next-server). Without
# these, every API route returns 500 while pages still render.
RUNTIME_SRC="$ROOT/node_modules/next/dist/compiled/next-server"
RUNTIME_DEST="$APP/node_modules/next/dist/compiled/next-server"
mkdir -p "$RUNTIME_DEST"
cp -f "$RUNTIME_SRC"/app-route*.prod.js "$RUNTIME_DEST"/

cp "$NODE_BIN" "$STAGE/node.exe"

# The launcher is compiled separately with csc (see packaging/launcher.cs):
#   csc /target:winexe /out:dist\stage\LHVideo.exe /win32icon:packaging\lh-video.ico \
#       /r:System.Windows.Forms.dll /r:System.Drawing.dll packaging\launcher.cs
echo "stage ready: $STAGE"
du -sh "$STAGE"
