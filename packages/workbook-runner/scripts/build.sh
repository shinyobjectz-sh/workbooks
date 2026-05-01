#!/bin/bash
# Build the workbook polyglot binary from a workbook .html payload.
#
# Usage:
#   ./scripts/build.sh <input.html> <output-binary>
#
# Produces a single APE polyglot binary that runs natively on Linux,
# macOS, Windows, FreeBSD without further setup. The binary embeds
# the input HTML and serves it on a random localhost port.

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <input.html> <output-binary>" >&2
  exit 1
fi

INPUT_HTML="$1"
OUTPUT_BIN="$2"

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

GEN_HEADER="$HERE/build/payload.h"
mkdir -p "$(dirname "$GEN_HEADER")"

# Generate xxd-style header from the HTML file
python3 - <<PY > "$GEN_HEADER"
import sys
with open("$INPUT_HTML", "rb") as f:
    data = f.read()
print("// Auto-generated; do not edit. Source: $INPUT_HTML")
print("#include <stddef.h>")
print(f"const unsigned int workbook_html_len = {len(data)};")
print("const unsigned char workbook_html[] = {")
for i in range(0, len(data), 16):
    chunk = data[i:i+16]
    line = ", ".join(f"0x{b:02x}" for b in chunk)
    print(f"  {line},")
print("};")
PY

# Build the binary, putting the generated header on the include path.
"$COSMOCC" \
  -O2 \
  -static \
  -I "$HERE/build" \
  -o "$OUTPUT_BIN" \
  "$HERE/src/runner.c"

# APE binaries on macOS need to be marked executable.
chmod +x "$OUTPUT_BIN"

# Report
SIZE_BYTES=$(stat -f%z "$OUTPUT_BIN" 2>/dev/null || stat -c%s "$OUTPUT_BIN" 2>/dev/null)
SIZE_MB=$(awk "BEGIN { printf \"%.2f\", $SIZE_BYTES / 1024 / 1024 }")
echo "✓ built $OUTPUT_BIN ($SIZE_MB MB; payload $(wc -c < "$INPUT_HTML") bytes HTML)"
