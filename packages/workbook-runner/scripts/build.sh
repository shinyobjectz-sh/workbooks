#!/bin/bash
# Build workbook polyglot binary (or three-platform artifact set) from
# a workbook .html payload.
#
# Usage:
#   build.sh <input.html> <output-dir> [--name <basename>]
#
# Default produces three artifacts in <output-dir>:
#   <name>-mac.zip      Mac Finder-friendly .app bundle
#   <name>-win.exe      Windows-runnable polyglot
#   <name>-linux        Bare polyglot (chmod +x and run)
#
# All three contain the same APE binary inside. Differs only in
# packaging affordances per OS.

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <input.html> <output-dir> [--name <basename>]" >&2
  exit 1
fi

INPUT_HTML="$1"
OUT_DIR="$2"
shift 2

NAME="workbook"
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
done

HERE="$(cd "$(dirname "$0")/.." && pwd)"
COSMOCC="$HERE/../../../cosmocc/bin/cosmocc"

if [ ! -x "$COSMOCC" ]; then
  echo "cosmocc not found at $COSMOCC" >&2
  echo "install: mkdir -p vendor/cosmocc && cd vendor/cosmocc && curl -sSL -O https://cosmo.zip/pub/cosmocc/cosmocc.zip && unzip cosmocc.zip" >&2
  exit 1
fi

if [ ! -f "$INPUT_HTML" ]; then
  echo "input HTML not found: $INPUT_HTML" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

# 1. Compile the C runner stub.
STUB="$HERE/build/runner-stub"
mkdir -p "$(dirname "$STUB")"
"$COSMOCC" -O2 -static -o "$STUB" "$HERE/src/runner.c"
chmod +x "$STUB"

# 2. Append payload + 4-byte BE length to make the polyglot.
#    Layout: [stub bytes] [HTML payload] [4-byte BE length]
PAYLOAD_LEN=$(wc -c < "$INPUT_HTML" | tr -d ' ')
BIN="$HERE/build/$NAME-bin"
cat "$STUB" "$INPUT_HTML" > "$BIN"
# Append big-endian 4-byte length.
python3 -c "
import struct, sys
with open('$BIN', 'ab') as f:
    f.write(struct.pack('>I', $PAYLOAD_LEN))
"
chmod +x "$BIN"

TOTAL_BYTES=$(wc -c < "$BIN" | tr -d ' ')
TOTAL_MB=$(awk "BEGIN { printf \"%.2f\", $TOTAL_BYTES / 1024 / 1024 }")
echo "✓ polyglot built ($TOTAL_MB MB; payload $PAYLOAD_LEN bytes)"

# 3. Per-platform packaging.
#    Linux: bare binary, just rename.
cp "$BIN" "$OUT_DIR/$NAME-linux"
chmod +x "$OUT_DIR/$NAME-linux"

#    Windows: same bytes, just .exe extension so Windows Explorer
#    double-click works.
cp "$BIN" "$OUT_DIR/$NAME-win.exe"

#    macOS: wrap in a .app bundle so Finder double-click works without
#    user gymnastics. Then zip the bundle.
APP_DIR="$HERE/build/$NAME.app"
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
cp "$BIN" "$APP_DIR/Contents/MacOS/$NAME"
chmod +x "$APP_DIR/Contents/MacOS/$NAME"

cat > "$APP_DIR/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>sh.workbooks.$NAME</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleVersion</key><string>0.1</string>
  <key>CFBundleShortVersionString</key><string>0.1</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><false/>
</dict>
</plist>
PLIST

# Zip the .app bundle (preserves exec bits via -X)
ZIP_OUT="$OUT_DIR/$NAME-mac.zip"
( cd "$HERE/build" && zip -qr "$ZIP_OUT" "$NAME.app" )

# 4. Optional: code-sign if env vars present.
if [ -n "${APPLE_DEVELOPER_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
  if command -v codesign >/dev/null 2>&1; then
    echo "[sign] macOS: codesign --sign \"$APPLE_DEVELOPER_ID\" $APP_DIR"
    codesign --force --sign "$APPLE_DEVELOPER_ID" --deep --options runtime "$APP_DIR" || \
      echo "[sign] codesign failed; ship unsigned" >&2
    # Re-zip after signing
    ( cd "$HERE/build" && rm -f "$ZIP_OUT" && zip -qr "$ZIP_OUT" "$NAME.app" )
  fi
fi
if [ -n "${WIN_CODESIGN_CERT_PATH:-}" ] && [ -n "${WIN_CODESIGN_CERT_PASS:-}" ]; then
  if command -v osslsigncode >/dev/null 2>&1; then
    echo "[sign] Windows: osslsigncode $OUT_DIR/$NAME-win.exe"
    osslsigncode sign \
      -pkcs12 "$WIN_CODESIGN_CERT_PATH" \
      -pass "$WIN_CODESIGN_CERT_PASS" \
      -h sha256 -in "$OUT_DIR/$NAME-win.exe" -out "$OUT_DIR/$NAME-win.exe.signed" && \
      mv "$OUT_DIR/$NAME-win.exe.signed" "$OUT_DIR/$NAME-win.exe" || \
      echo "[sign] osslsigncode failed; ship unsigned" >&2
  fi
fi

echo
echo "Output: $OUT_DIR/"
ls -lh "$OUT_DIR" | tail -n +2
echo
echo "Distribution paths:"
echo "  macOS:   download $NAME-mac.zip → unzip → double-click $NAME.app"
echo "  Windows: download $NAME-win.exe → double-click → SmartScreen → Run anyway"
echo "  Linux:   download $NAME-linux → chmod +x → ./$NAME-linux"
