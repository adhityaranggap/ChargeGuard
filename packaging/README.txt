ChargeGuard

ChargeGuard holds your MacBook battery at 80% at Home and at the Office.
At other places, it charges to 100%. A widget on the desktop shows the battery and has all settings.

You need:
- A Mac with Apple silicon (M1 or later).
- A macOS version with the native charge limit. The installer checks this.
- An admin account.

Install:
1. Double-click "Install ChargeGuard".
2. If macOS says that it cannot check the app, click "Done".
   Open System Settings > Privacy & Security. Scroll down and click "Open Anyway" for "Install ChargeGuard".
   This app is not signed with an Apple developer account. That is why macOS asks.
3. Click "Install". Type your Mac password when macOS asks.
4. At home, click the gear on the widget. Click "Use current Wi-Fi" next to Home.
   At the office, do the same next to Office.

If something fails:
- The installer shows the failed step and a fix. Click "Show Log" to see the full log.
  The log is in ~/.chargeguard/install.log.
- "smc Not Opened" or "Apple could not verify smc": click "Done". Open "Install ChargeGuard" again.
  The new installer removes the download flag from smc, so macOS does not block it.
- "Install ChargeGuard Not Opened": do Install step 2.
- If you did not give the password, open "Install ChargeGuard" again.

Use:
- Click the gear on the widget to open Settings: theme, size, corner, place, charge limit, office hours, and more.
- The place is found automatically by your Wi-Fi router. You can also choose it by hand in Settings > Places.

Remove:
- Double-click "Uninstall ChargeGuard". Do step 2 again if macOS asks.

Optional:
- Menu bar icon: install SwiftBar (https://swiftbar.app), then install ChargeGuard again.
- Stop charging while the Mac sleeps: install sleepwatcher with Homebrew, then install ChargeGuard again.

Third-party parts are listed in "Install ChargeGuard.app/Contents/Resources/payload/runtime/THIRD-PARTY.txt".
