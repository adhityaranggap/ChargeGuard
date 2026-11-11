-- ChargeGuard uninstaller app.
on run
	set helper to "/usr/local/libexec/chargeguard/cg-helper"
	try
		set choice to button returned of (display dialog "Remove ChargeGuard from this Mac?" & return & return & "Choose the charge limit that macOS keeps after the removal." buttons {"Cancel", "Keep the limit", "Charge to 100%"} default button "Charge to 100%" cancel button "Cancel" with title "Uninstall ChargeGuard" with icon caution)
		set rootCmd to "rm -rf /usr/local/libexec/chargeguard /etc/sudoers.d/chargeguard"
		if choice is "Charge to 100%" then set rootCmd to "[ -x " & helper & " ] && " & helper & " limit 100; " & rootCmd
		-- The user part first: it stops the agents and sets the adapter on through the helper.
		do shell script "[ -f \"$HOME/.chargeguard/app/scripts/uninstall.sh\" ] && /bin/bash \"$HOME/.chargeguard/app/scripts/uninstall.sh\" --purge 2>&1 || true"
		do shell script rootCmd with administrator privileges
		display dialog "ChargeGuard is removed. The Mac charges as normal." buttons {"OK"} default button "OK" with title "ChargeGuard" with icon note
	on error errMsg number errNum
		if errNum is -128 then return
		display dialog "The removal failed." & return & return & errMsg buttons {"OK"} default button "OK" with title "ChargeGuard" with icon stop
	end try
end run
