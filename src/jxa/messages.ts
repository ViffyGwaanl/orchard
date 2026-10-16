/**
 * Sending goes through AppleScript because the Messages dictionary is far more
 * reliable there than in JXA. Arguments: text, mode (chat|handle), target,
 * service (imessage|sms), then any attachment paths.
 */
export const MESSAGES_SEND = String.raw`
on run argv
	set theText to item 1 of argv
	set theMode to item 2 of argv
	set theTarget to item 3 of argv
	set theService to item 4 of argv
	set theFiles to {}
	if (count of argv) > 4 then set theFiles to items 5 thru -1 of argv
	tell application "Messages"
		if theMode is "chat" then
			set dest to chat id theTarget
		else
			set svc to missing value
			if theService is "sms" then
				try
					set svc to 1st account whose service type = SMS
				end try
			else
				try
					set svc to 1st account whose service type = iMessage
				end try
			end if
			if svc is missing value then set svc to 1st account
			set dest to participant theTarget of svc
		end if
		if theText is not "" then send theText to dest
		repeat with f in theFiles
			send (POSIX file (f as text)) to dest
		end repeat
	end tell
	return "{\"sent\":true}"
end run
`;
