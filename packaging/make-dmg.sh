#!/bin/bash
# Make dist/ChargeGuard-<version>.dmg for other users.
# Run from the repo: bash packaging/make-dmg.sh [version]
# BUN_SRC: the Bun binary to bundle. Default: ~/.bun/bin/bun.
# SMC_SRC: the smc binary to bundle. Default: the installed copy.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VER="${1:-$(date +%Y.%m.%d)}"
BUN_SRC="${BUN_SRC:-$HOME/.bun/bin/bun}"
SMC_SRC="${SMC_SRC:-/usr/local/libexec/chargeguard/smc}"
SMC_SHA=e3b4392c966dee700f3e1d6cc3812c0d487954c3d6d77b91f521a9590aadae44
OUT="$REPO/dist"
STAGE="$OUT/stage"
DMG="$OUT/ChargeGuard-$VER.dmg"

say() { echo "make-dmg: $*"; }
die() { echo "make-dmg: ERROR: $*" >&2; exit 1; }

[ -x "$BUN_SRC" ] || die "Bun not found at $BUN_SRC."
[ -f "$SMC_SRC" ] || die "smc not found at $SMC_SRC."
[ "$(shasum -a 256 "$SMC_SRC" | cut -d' ' -f1)" = "$SMC_SHA" ] || die "The SHA-256 of $SMC_SRC does not match."
[ "$(file -b "$BUN_SRC" | grep -c arm64)" -gt 0 ] || die "$BUN_SRC is not an arm64 binary."

say "Clean $OUT."
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"

say "Make the installer app."
osacompile -o "$STAGE/Install ChargeGuard.app" "$REPO/packaging/installer.applescript"
PAY="$STAGE/Install ChargeGuard.app/Contents/Resources/payload"
mkdir -p "$PAY/runtime"
rsync -a --exclude .git --exclude docs --exclude tests --exclude node_modules --exclude dist \
  --exclude proto --exclude packaging --exclude probe-root.sh --exclude runtime --exclude .DS_Store --exclude '*.log' \
  "$REPO/" "$PAY/"
cp "$BUN_SRC" "$PAY/runtime/bun"
cp "$SMC_SRC" "$PAY/runtime/smc"
chmod 755 "$PAY/runtime/bun" "$PAY/runtime/smc" "$PAY/bin/cg" "$PAY/scripts/cg-helper"
cat > "$PAY/runtime/THIRD-PARTY.txt" <<EOF
Third-party programs in this folder:

bun ($("$BUN_SRC" --version))
  JavaScript runtime by Oven. MIT license. Source: https://github.com/oven-sh/bun

smc
  SMC command-line tool from the "battery" project, which builds it from smcFanControl.
  GNU General Public License. Source: https://github.com/actuallymentor/battery
  and https://github.com/hholtmann/smcFanControl
EOF

say "Make the uninstaller app."
osacompile -o "$STAGE/Uninstall ChargeGuard.app" "$REPO/packaging/uninstaller.applescript"

say "Sign both apps ad hoc. The added files change the bundle, so the old signature is not valid."
codesign --force --deep --sign - "$STAGE/Install ChargeGuard.app"
codesign --force --deep --sign - "$STAGE/Uninstall ChargeGuard.app"
codesign --verify --deep "$STAGE/Install ChargeGuard.app" || die "The installer signature is not valid."

cp "$REPO/packaging/README.txt" "$STAGE/README.txt"

say "Make $DMG."
hdiutil create -quiet -volname "ChargeGuard" -srcfolder "$STAGE" -fs HFS+ -format UDZO "$DMG"
rm -rf "$STAGE"
shasum -a 256 "$DMG"
ls -lh "$DMG"
