#!/bin/bash
# ChargeGuard root install. Run as root. For example: sudo bash scripts/install-root.sh
# Set SMC_SRC to the path of the smc binary if it is not installed yet.
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin

DEST=/usr/local/libexec/chargeguard
SMC_SHA=e3b4392c966dee700f3e1d6cc3812c0d487954c3d6d77b91f521a9590aadae44
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { echo "install-root: $*"; }
die() { echo "install-root: ERROR: $*" >&2; exit 1; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

say "Step 1. Check that the user is root."
[ "$(id -u)" = "0" ] || die "Run this script as root."

say "Step 2. Make the folder $DEST."
# A user-writable parent lets a user process replace cg-helper and get root. Stop if so.
for d in /usr/local /usr/local/libexec; do
  if [ -e "$d" ]; then
    [ "$(stat -f %Su "$d")" = "root" ] || die "$d is not owned by root."
    perm="$(stat -f %Lp "$d")"
    [ $(( 8#$perm & 8#022 )) -eq 0 ] || die "$d is writable by group or others."
  fi
done
mkdir -p "$DEST"
chown root:wheel "$DEST"
chmod 755 "$DEST"

say "Step 3. Install the smc binary."
# The disk image puts smc in runtime/.
[ -n "${SMC_SRC:-}" ] || [ ! -f "$HERE/../runtime/smc" ] || SMC_SRC="$HERE/../runtime/smc"
if [ ! -f "$DEST/smc" ]; then
  [ -n "${SMC_SRC:-}" ] || die "smc is missing. Set SMC_SRC to the path of the smc binary."
  [ -f "$SMC_SRC" ] || die "SMC_SRC file not found: $SMC_SRC"
  [ "$(sha "$SMC_SRC")" = "$SMC_SHA" ] || die "The SHA-256 of $SMC_SRC does not match."
  install -o root -g wheel -m 755 "$SMC_SRC" "$DEST/smc"
  say "smc is installed."
else
  [ "$(sha "$DEST/smc")" = "$SMC_SHA" ] || die "The SHA-256 of $DEST/smc does not match. Remove the file and try again."
  chown root:wheel "$DEST/smc"
  chmod 755 "$DEST/smc"
  say "smc is already installed. The SHA-256 matches."
fi

say "Step 4. Install cg-helper."
[ -f "$HERE/cg-helper" ] || die "cg-helper not found next to this script."
install -o root -g wheel -m 755 "$HERE/cg-helper" "$DEST/cg-helper"

say "Step 5. Remove the quarantine flag, and test smc."
# Files from a downloaded disk image carry the quarantine flag, and install keeps it.
# smc is not notarized, so macOS blocks a quarantined smc with "Apple could not verify smc".
# This step also repairs an older install that has the flag.
xattr -c "$DEST/smc" "$DEST/cg-helper" 2>/dev/null || true
if xattr -p com.apple.quarantine "$DEST/smc" >/dev/null 2>&1; then
  die "macOS keeps the quarantine flag on $DEST/smc. Remove it with: sudo xattr -c $DEST/smc"
fi
"$DEST/smc" -k ACLC -r >/dev/null 2>&1 || die "smc does not run. macOS can block it. Open System Settings > Privacy & Security, click Allow Anyway for smc, then install again."
say "smc runs."

say "Step 6. Write the sudoers rule."
# The installer app runs this script through an admin dialog, so SUDO_USER is not set.
# It gives the user name in CG_USER.
if [ -n "${CG_USER:-}" ] && [ "$CG_USER" != "root" ]; then
  U="$CG_USER"
elif [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  U="$SUDO_USER"
else
  U="$(stat -f %Su "$HERE/$(basename "$0")")"
fi
[ "$U" != "root" ] || die "Cannot find the user name. Run with sudo from the user account."
[[ "$U" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || die "The user name is not valid: $U"
TMP="$(mktemp /tmp/chargeguard-sudoers.XXXXXX)"
trap 'rm -f "$TMP"' EXIT
echo "$U ALL=(root) NOPASSWD: $DEST/cg-helper" > "$TMP"
visudo -cf "$TMP" >/dev/null || die "visudo found an error in the sudoers rule."
install -o root -g wheel -m 440 "$TMP" /etc/sudoers.d/chargeguard
say "The rule is installed for user $U."

say "Done. Check with: sudo -n -l $DEST/cg-helper"
