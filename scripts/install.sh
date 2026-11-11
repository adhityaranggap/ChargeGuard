#!/bin/bash
# ChargeGuard user install. No sudo. Run from the repo: bash scripts/install.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$HOME/.chargeguard"
APP="$DATA/app"
LA="$HOME/Library/LaunchAgents"

say() { echo "install: $*"; }

say "Copy the app to $APP."
mkdir -p "$APP" "$DATA/bin"
rsync -a --delete --exclude .git --exclude docs --exclude tests --exclude node_modules "$REPO/" "$APP/"

say "Install the command $DATA/bin/cg."
install -m 755 "$REPO/bin/cg" "$DATA/bin/cg"

say "Write the default config if it is missing."
"$DATA/bin/cg" init

# Stop the agent with label $1. bootout returns before the old agent is gone,
# so wait up to 10 s.
stop_agent() {
  local svc="gui/$(id -u)/$1"
  launchctl bootout "$svc" 2>/dev/null || true
  for _ in $(seq 1 20); do
    launchctl print "$svc" >/dev/null 2>&1 || break
    sleep 0.5
  done
}

# Copy the plist for label $1, stop the old agent, then start the new one.
start_agent() {
  local label="$1"
  cp "$REPO/launchd/$label.plist" "$LA/$label.plist"
  stop_agent "$label"
  launchctl bootstrap "gui/$(id -u)" "$LA/$label.plist"
}

say "Install and start the launchd agent."
mkdir -p "$LA"
start_agent com.chargeguard.daemon

UB_W="$HOME/Library/Application Support/Übersicht/widgets"
if [ "${CG_WIDGET:-}" = "ubersicht" ]; then
  say "CG_WIDGET=ubersicht. Stop the standalone widget agent if it runs."
  stop_agent com.chargeguard.widget
  rm -f "$LA/com.chargeguard.widget.plist"
  if [ -d "$APP/widget/chargeguard.widget" ]; then
    say "Link the Ubersicht widget."
    mkdir -p "$UB_W"
    ln -sfn "$APP/widget/chargeguard.widget" "$UB_W/chargeguard.widget"
  else
    say "The widget folder is missing. Skip the widget."
  fi
else
  if [ -L "$UB_W/chargeguard.widget" ]; then
    say "Remove the old Ubersicht widget link. This prevents two widgets."
    rm -f "$UB_W/chargeguard.widget"
  elif [ -e "$UB_W/chargeguard.widget" ]; then
    say "$UB_W/chargeguard.widget is not a link. Remove it manually to prevent two widgets."
  fi
  if [ -f "$APP/widget/standalone/host.js" ]; then
    say "Install and start the desktop widget agent."
    start_agent com.chargeguard.widget
  else
    say "The standalone widget is missing. Skip the widget."
  fi
fi

say "Link the SwiftBar plugin."
SB="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || true)"
[ -n "$SB" ] || SB="$HOME/Library/Application Support/SwiftBar/Plugins"
mkdir -p "$SB"
chmod +x "$APP/swiftbar/chargeguard.10s.sh"
ln -sfn "$APP/swiftbar/chargeguard.10s.sh" "$SB/chargeguard.10s.sh"

hook() { # $1 = target file, $2 = sleep or wake
  local f="$1" kind="$2"
  if [ -f "$f" ]; then
    if grep -q "chargeguard/bin/cg" "$f"; then
      say "$f already calls cg."
    else
      printf '\n"$HOME/.chargeguard/bin/cg" hook %s >/dev/null 2>&1 || true\n' "$kind" >> "$f"
      say "Added one line to $f."
    fi
  else
    cp "$APP/hooks/$kind" "$f"
    chmod 755 "$f"
    say "Created $f."
  fi
}
hook "$HOME/.sleep" sleep
hook "$HOME/.wakeup" wake

if command -v brew >/dev/null 2>&1 && brew list sleepwatcher >/dev/null 2>&1; then
  say "Start sleepwatcher."
  brew services start sleepwatcher || true
else
  say "sleepwatcher is not installed. Run: brew install sleepwatcher"
fi

say "Done. Check with: $DATA/bin/cg doctor"
