-- ChargeGuard installer app. make-dmg.sh puts the app files in Contents/Resources/payload.
-- Each step shows a clear message if it fails. The full output goes to ~/.chargeguard/install.log.

property logPath : ""

on run
	set payload to (POSIX path of (path to me)) & "Contents/Resources/payload/"
	set userName to short user name of (system info)
	set helper to "/usr/local/libexec/chargeguard/cg-helper"
	try
		display dialog "ChargeGuard holds your MacBook battery at 80% at Home and at the Office. At other places, it charges to 100%." & return & return & "The installer asks for your admin password one time." buttons {"Cancel", "Install"} default button "Install" cancel button "Cancel" with title "Install ChargeGuard" with icon note
	on error number -128
		return
	end try

	-- The admin step runs as root, so use the full path, not $HOME.
	set logPath to quoted form of ((POSIX path of (path to home folder)) & ".chargeguard/install.log")
	do shell script "mkdir -p \"$HOME/.chargeguard\" && : > " & logPath

	-- Step 1. User part: copy the app, start the daemon and the widget.
	if not (runStep("Copy ChargeGuard and start the widget", "/bin/bash " & quoted form of (payload & "scripts/install.sh"), false)) then return

	-- Step 2. Root part: smc, cg-helper, and the sudoers rule. macOS asks for the password.
	if not (runStep("Install the battery helper", "CG_USER=" & quoted form of userName & " /bin/bash " & quoted form of (payload & "scripts/install-root.sh"), true)) then return

	-- Step 3. Test the helper as the user, the same way the daemon calls it.
	-- "adapter on" is safe: it lets the charger charge, which is the normal state.
	if not (runStep("Test the battery helper", "/usr/bin/sudo -n " & helper & " adapter on", false)) then return

	do shell script "touch \"$HOME/.chargeguard/kick\""
	display dialog "ChargeGuard is installed." & return & return & "1. The widget is at the bottom left of the screen." & return & "2. Click the gear on the widget to open Settings." & return & "3. At home, click \"Use current Wi-Fi\" next to Home. At the office, do the same next to Office." buttons {"OK"} default button "OK" with title "ChargeGuard" with icon note
end run

-- Runs one step. Returns true if it worked. On an error, shows a message with a fix, and returns false.
on runStep(stepName, cmd, asAdmin)
	set shCmd to "{ " & cmd & " ; } >> " & logPath & " 2>&1 || { tail -n 5 " & logPath & " >&2; exit 1; }"
	try
		if asAdmin then
			do shell script shCmd with administrator privileges
		else
			do shell script shCmd
		end if
		return true
	on error errMsg number errNum
		if errNum is -128 then
			display dialog "The install stopped because the password was not given." & return & return & "ChargeGuard needs the admin password one time to control the charger. Open Install ChargeGuard again to finish." buttons {"OK"} default button "OK" with title "ChargeGuard" with icon caution
			return false
		end if
		showError(stepName, errMsg)
		return false
	end try
end runStep

on showError(stepName, errMsg)
	set tip to fixFor(errMsg)
	set choice to button returned of (display dialog "This step failed: " & stepName & "." & return & return & tip & return & return & "Details:" & return & errMsg buttons {"Show Log", "OK"} default button "OK" with title "ChargeGuard" with icon stop)
	if choice is "Show Log" then do shell script "open -e " & logPath
end showError

-- Gives a fix in plain words for the known errors.
on fixFor(errMsg)
	if errMsg contains "Apple silicon" then return "ChargeGuard works only on a Mac with Apple silicon (M1 or later)."
	if errMsg contains "native charge limit" then return "Update macOS in System Settings > General > Software Update. Then open Install ChargeGuard again."
	if errMsg contains "smc" and (errMsg contains "quarantine" or errMsg contains "does not run" or errMsg contains "Killed") then return "macOS blocked the smc tool. Open System Settings > Privacy & Security. Click Allow Anyway for smc. Then open Install ChargeGuard again."
	if errMsg contains "SHA-256" then return "A file in the disk image is damaged. Download the disk image again."
	if errMsg contains "not owned by root" or errMsg contains "writable by group" then return "The folder /usr/local has unsafe permissions. Ask for help on the ChargeGuard GitHub page."
	if errMsg contains "password is required" or errMsg contains "sudo" then return "The helper rule did not install. Open Install ChargeGuard again."
	if errMsg contains "Bun" then return "A file in the disk image is missing. Download the disk image again."
	return "Open Install ChargeGuard again. If it fails again, click Show Log and send the log on the ChargeGuard GitHub page."
end fixFor
