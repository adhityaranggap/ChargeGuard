#!/bin/bash
# ChargeGuard M0 probe. Run once as root: sudo bash probe-root.sh
# It sets the native macOS charge limit to 80, tests the MagSafe LED key,
# and tests the adapter key for 3 seconds. It restores the adapter and the LED at the end.
set -u
SMC="/private/tmp/claude-504/-Users-rangga-sa-NE/481dc4ef-3b2e-49e6-a89f-2fa2989b3bcc/scratchpad/dl/bin/smc"
LOG="/Users/rangga-sa/NE/chargeguard/docs/probe-$(date +%Y%m%d-%H%M%S).log"
DOM="com.apple.smartcharging.topoffprotection"

if [ "$(id -u)" != "0" ]; then echo "Run with sudo."; exit 1; fi

restore() {
  "$SMC" -k CHIE -w 00 >/dev/null 2>&1
  "$SMC" -k ACLC -w 00 >/dev/null 2>&1
}
trap restore EXIT INT TERM

batt() { ioreg -r -c AppleSmartBattery | egrep '"(ExternalConnected|IsCharging|CurrentCapacity)"' | tr -s ' ' | tr '\n' ' '; echo; }

exec > >(tee "$LOG") 2>&1
echo "== probe $(date)"
echo "smc sha256: $(shasum -a 256 "$SMC" | cut -d' ' -f1)"
echo "-- before"
pmset -g battlimit
defaults read "$DOM" 2>&1
batt

echo "-- native limit: write MCLFeatureState=1 mclLimitValue=80, notify"
defaults write "$DOM" MCLFeatureState -int 1
defaults write "$DOM" mclLimitValue -int 80
notifyutil -p com.apple.smartcharging.defaultschanged
sleep 3
defaults read "$DOM" 2>&1
pmset -g battlimit

echo "-- LED: read, write 03 (green), read"
"$SMC" -k ACLC -r
"$SMC" -k ACLC -w 03; echo "write rc=$?"
"$SMC" -k ACLC -r
sleep 2

echo "-- adapter: write CHIE=08 for 3 s"
"$SMC" -k CHIE -w 08; echo "write rc=$?"
sleep 3
"$SMC" -k CHIE -r
batt
"$SMC" -k CHIE -w 00; echo "restore rc=$?"
sleep 3
"$SMC" -k CHIE -r
batt

echo "-- charge keys (expect gated)"
for k in CHTE CH0B CH0C; do "$SMC" -k $k -r; done

echo "== done. Log: $LOG"
chown rangga-sa "$LOG"
