#!/bin/bash
# ChargeGuard uninstall. Run: bash scripts/uninstall.sh [--purge]
# --purge also removes ~/.chargeguard (config, state, log).
set -uo pipefail

DATA="$HOME/.chargeguard"
HELPER=/usr/local/libexec/chargeguard/cg-helper
LA="$HOME/Library/LaunchAgents/com.chargeguard.daemon.plist"
LA_WIDGET="$HOME/Library/LaunchAgents/com.chargeguard.widget.plist"
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

say() { echo "uninstall: $*"; }

say "Restore the adapter and the LED."
sudo -n "$HELPER" adapter on 2>/dev/null || say "Could not set the adapter. Ignore this if the helper is gone."
sudo -n "$HELPER" led system 2>/dev/null || say "Could not set the LED. Ignore this if the helper is gone."

say "Stop the daemon and remove the launchd agent."
launchctl bootout "gui/$(id -u)/com.chargeguard.daemon" 2>/dev/null || true
rm -f "$LA"

say "Stop the desktop widget and remove its launchd agent."
launchctl bootout "gui/$(id -u)/com.chargeguard.widget" 2>/dev/null || true
rm -f "$LA_WIDGET"

say "Remove the widget and the SwiftBar plugin links."
rm -f "$HOME/Library/Application Support/Übersicht/widgets/chargeguard.widget"
SB="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)"
[ -n "$SB" ] || SB="$HOME/Library/Application Support/SwiftBar/Plugins"
rm -f "$SB/chargeguard.10s.sh"

say "Remove the cg lines from ~/.sleep and ~/.wakeup."
for f in "$HOME/.sleep" "$HOME/.wakeup"; do
  [ -f "$f" ] && sed -i '' '/chargeguard\/bin\/cg/d' "$f"
done

if [ "$PURGE" = "1" ]; then
  say "Remove $DATA."
  rm -rf "$DATA"
else
  say "Keep $DATA. Use --purge to remove it."
fi

echo
echo "To remove the root parts, run:"
echo "  sudo rm -rf /usr/local/libexec/chargeguard /etc/sudoers.d/chargeguard"
echo
echo "NOTE: The native charge limit stays in macOS after the uninstall."
echo "To remove it, run 'cg limit 100' before you uninstall."
