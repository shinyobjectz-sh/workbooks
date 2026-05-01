#!/bin/bash
# Build a single-file workbook polyglot binary from a workbook .html
# payload.
#
# Usage:
#   build.sh <input.html> <output-dir> [--name <basename>]
#
# Produces ONE artifact:
#   <output-dir>/<name>.com
#
# Same APE polyglot bytes; the .com extension is the universal pivot:
#   - Windows Explorer treats .com as a native executable (double-click works)
#   - macOS Finder right-click → Open → "Open Anyway" once per file
#       (after that, Mac trusts double-click forever)
#   - Linux: chmod +x && ./<name>.com
#
# This deliberately ships ONE file, not per-OS variants. Packaging
# affordances per OS (.app bundle, etc.) sit behind the global Workbook
# runner, not in the polyglot itself.

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
#    Layout: [APE stub bytes] [HTML payload] [4-byte BE length]
PAYLOAD_LEN=$(wc -c < "$INPUT_HTML" | tr -d ' ')
OUT_FILE="$OUT_DIR/$NAME.com"
cat "$STUB" "$INPUT_HTML" > "$OUT_FILE"
python3 -c "
import struct
with open('$OUT_FILE', 'ab') as f:
    f.write(struct.pack('>I', $PAYLOAD_LEN))
"
chmod +x "$OUT_FILE"

TOTAL_BYTES=$(wc -c < "$OUT_FILE" | tr -d ' ')
TOTAL_MB=$(awk "BEGIN { printf \"%.2f\", $TOTAL_BYTES / 1024 / 1024 }")
echo "✓ polyglot built: $OUT_FILE ($TOTAL_MB MB; payload $PAYLOAD_LEN bytes)"

# 3. Optional code-signing.
#    macOS: codesign signs the bare binary if APPLE_DEVELOPER_ID set.
#    Windows: osslsigncode signs the .com (treated as PE on Windows).
if [ -n "${APPLE_DEVELOPER_ID:-}" ]; then
  if command -v codesign >/dev/null 2>&1; then
    echo "[sign] macOS: codesign --sign \"$APPLE_DEVELOPER_ID\" $OUT_FILE"
    codesign --force --sign "$APPLE_DEVELOPER_ID" --options runtime "$OUT_FILE" || \
      echo "[sign] codesign failed; shipping unsigned" >&2
  fi
fi
if [ -n "${WIN_CODESIGN_CERT_PATH:-}" ] && [ -n "${WIN_CODESIGN_CERT_PASS:-}" ]; then
  if command -v osslsigncode >/dev/null 2>&1; then
    echo "[sign] Windows: osslsigncode $OUT_FILE"
    osslsigncode sign \
      -pkcs12 "$WIN_CODESIGN_CERT_PATH" \
      -pass "$WIN_CODESIGN_CERT_PASS" \
      -h sha256 -in "$OUT_FILE" -out "$OUT_FILE.signed" && \
      mv "$OUT_FILE.signed" "$OUT_FILE" || \
      echo "[sign] osslsigncode failed; shipping unsigned" >&2
  fi
fi

echo
echo "Distribution: ship the single file $OUT_FILE."
echo "  macOS:   right-click → Open → 'Open Anyway' (one-time Gatekeeper)"
echo "  Windows: double-click (SmartScreen → 'Run anyway' once)"
echo "  Linux:   chmod +x $NAME.com && ./$NAME.com"
