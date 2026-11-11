-- ChargeGuard installer app. make-dmg.sh puts the app files in Contents/Resources/payload.
on run
	set payload to (POSIX path of (path to me)) & "Contents/Resources/payload/"
	set userName to short user name of (system info)
	try
		display dialog "ChargeGuard holds your MacBook battery at 80% at Home and at the Office. At other places, it charges to 100%." & return & return & "The installer asks for your admin password one time." buttons {"Cancel", "Install"} default button "Install" cancel button "Cancel" with title "Install ChargeGuard" with icon note
		do shell script "/bin/bash " & quoted form of (payload & "scripts/install.sh") & " 2>&1"
		do shell script "CG_USER=" & quoted form of userName & " /bin/bash " & quoted form of (payload & "scripts/install-root.sh") & " 2>&1" with administrator privileges
		do shell script "touch \"$HOME/.chargeguard/kick\""
		display dialog "ChargeGuard is installed." & return & return & "1. The widget is at the bottom left of the screen." & return & "2. Click the gear on the widget to open Settings." & return & "3. At home, click \"Use current Wi-Fi\" next to Home. At the office, do the same next to Office." buttons {"OK"} default button "OK" with title "ChargeGuard" with icon note
	on error errMsg number errNum
		if errNum is -128 then return
		display dialog "The install failed." & return & return & errMsg buttons {"OK"} default button "OK" with title "ChargeGuard" with icon stop
	end try
end run
