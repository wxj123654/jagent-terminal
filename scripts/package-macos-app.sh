#!/usr/bin/env bash
set -euo pipefail

# Build a self-contained, ad-hoc signed macOS .app from the Rust release binary.
# Developer ID signing/notarization is intentionally not attempted without user credentials.
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-release}"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64) TARGET="aarch64-apple-darwin" ;;
  x86_64) TARGET="x86_64-apple-darwin" ;;
  *) echo "unsupported macOS architecture: $ARCH" >&2; exit 2 ;;
esac
BIN="$ROOT/target/$TARGET/$PROFILE/j-agent"
# Cargo omits the triple directory for the host target unless --target was passed.
if [[ ! -x "$BIN" && "$TARGET" == "$(rustc -vV | awk '/^host:/ {print $2}')" ]]; then
  BIN="$ROOT/target/$PROFILE/j-agent"
fi
if [[ ! -x "$BIN" ]]; then
  echo "release executable missing: $BIN (run cargo build --release -p jagent-app --target $TARGET)" >&2
  exit 1
fi
ICON="$ROOT/crates/jagent-app/assets/icons/app.icns"
[[ -f "$ICON" ]] || { echo "missing icon: $ICON" >&2; exit 1; }
APP="$ROOT/target/package/JAgent.app"
CONTENTS="$APP/Contents"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
install -m 755 "$BIN" "$CONTENTS/MacOS/j-agent"
install -m 644 "$ICON" "$CONTENTS/Resources/app.icns"
VERSION="$(awk -F '"' '/^version = / { print $2; exit }' "$ROOT/Cargo.toml")"
cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>JAgent</string>
<key>CFBundleDisplayName</key><string>JAgent</string>
<key>CFBundleIdentifier</key><string>com.jagent.terminal</string>
<key>CFBundleVersion</key><string>${VERSION}</string>
<key>CFBundleShortVersionString</key><string>${VERSION}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleExecutable</key><string>j-agent</string>
<key>CFBundleIconFile</key><string>app.icns</string>
<key>LSMinimumSystemVersion</key><string>11.0</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
printf 'APPL????' > "$CONTENTS/PkgInfo"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
plutil -lint "$CONTENTS/Info.plist"
echo "created and verified: $APP"
