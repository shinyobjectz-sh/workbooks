#!/bin/bash
# Workbooks installer — runs from a release ZIP.
#
# When the user double-clicks this file in Finder, macOS opens
# Terminal here and runs the script. We:
#   1. Copy the bundled `workbooksd` binary to ~/.local/bin/
#   2. Drop a per-user LaunchAgent plist that keeps the daemon up
#   3. launchctl-load it and verify /health responds
#   4. Register .workbook.html as a file association via a tiny
#      Workbooks.app launcher (mirrors install.sh's behavior)
#
# The script lives next to the workbooksd binary in the ZIP. Both
# files are signed + notarized as a unit so Gatekeeper allows
# double-click without a security prompt on the first run.
#
# Re-running is safe — every step is idempotent.
set -euo pipefail

# Resolve where THIS script (and the binary next to it) live.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY_NAME="$(ls "$HERE" | grep -E '^workbooksd-(aarch64|x86_64)-apple-darwin$' | head -1)"
if [ -z "$BINARY_NAME" ] || [ ! -f "$HERE/$BINARY_NAME" ]; then
  echo "[install] bundled workbooksd binary not found next to Install.command"
  echo "[install] (looked in $HERE)"
  echo
  echo "Press Return to close…"; read -r _
  exit 1
fi

INSTALL_BIN="$HOME/.local/bin/workbooksd"
PLIST="$HOME/Library/LaunchAgents/sh.workbooks.workbooksd.plist"
APPS_DIR="$HOME/Applications"
APP="$APPS_DIR/Workbooks.app"

say() { printf "[install] %s\n" "$1"; }

say "installing $BINARY_NAME → $INSTALL_BIN"
mkdir -p "$(dirname "$INSTALL_BIN")"
cp -f "$HERE/$BINARY_NAME" "$INSTALL_BIN"
chmod +x "$INSTALL_BIN"

say "writing LaunchAgent plist → $PLIST"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>sh.workbooks.workbooksd</string>
  <key>ProgramArguments</key>
  <array><string>$INSTALL_BIN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/workbooksd.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/workbooksd.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
PLIST

say "(re)loading LaunchAgent…"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# Wait for /health
say "waiting for daemon…"
for i in $(seq 1 20); do
  if curl -fsS -o /dev/null http://127.0.0.1:47119/health; then
    say "daemon is up."
    break
  fi
  sleep 0.25
done

# Tiny Finder-handler .app so Launch Services routes .workbook.html
# double-clicks through the daemon. Same shape as install.sh writes.
if [ "${WORKBOOKS_NO_FILEASSOC:-}" != "1" ]; then
  say "registering .workbook.html handler at $APP"
  mkdir -p "$APP/Contents/MacOS"
  cat > "$APP/Contents/Info.plist" <<APPPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>Workbooks</string>
  <key>CFBundleIdentifier</key><string>sh.workbooks.launcher</string>
  <key>CFBundleName</key><string>Workbooks</string>
  <key>CFBundleExecutable</key><string>workbooks-launcher</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.0.1</string>
  <key>CFBundleVersion</key><string>0.0.1</string>
  <key>LSMinimumSystemVersion</key><string>10.13</string>
  <key>LSUIElement</key><true/>
  <key>UTExportedTypeDeclarations</key>
  <array><dict>
    <key>UTTypeIdentifier</key><string>sh.workbooks.workbook</string>
    <key>UTTypeDescription</key><string>Workbook</string>
    <key>UTTypeConformsTo</key><array><string>public.html</string></array>
    <key>UTTypeTagSpecification</key><dict>
      <key>public.filename-extension</key><array><string>workbook.html</string></array>
    </dict>
  </dict></array>
  <key>CFBundleDocumentTypes</key>
  <array><dict>
    <key>CFBundleTypeName</key><string>Workbook</string>
    <key>CFBundleTypeRole</key><string>Editor</string>
    <key>LSItemContentTypes</key><array><string>sh.workbooks.workbook</string></array>
  </dict></array>
</dict>
</plist>
APPPLIST
  cat > "$APP/Contents/MacOS/workbooks-launcher" <<LAUNCHER
#!/bin/sh
# Forwarded by Finder when a user double-clicks a .workbook.html file.
exec "$INSTALL_BIN" open "\$@"
LAUNCHER
  chmod +x "$APP/Contents/MacOS/workbooks-launcher"
  /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
fi

echo
echo "✓ Workbooks installed."
echo "  daemon: $INSTALL_BIN"
echo "  agent:  $PLIST"
echo "  app:    $APP"
echo
echo "Double-click any .workbook.html file to open it through the daemon."
echo "Press Return to close…"; read -r _
