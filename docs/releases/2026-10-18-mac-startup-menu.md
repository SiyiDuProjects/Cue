# Cue macOS Build 35

The native More menu now offers launch at login and menu bar icon visibility.

- Launch at login uses `SMAppService.mainApp`. Its checkbox follows the actual system status, refreshes when switching applications, and opens Login Items settings when approval is required. Changing it is explicit; startup does not begin transcription. Preview mode cannot register a login item.
- Hide menu bar icon changes only the existing `NSStatusItem` visibility. The overlay and shortcuts remain available. Unchecking the setting or reopening Cue restores the icon. The existing accessory activation policy and absent Dock icon remain unchanged.

The native release build and bundled Mac page build completed. Build 35 was signed with the existing identity, installed at `/Applications/Cue.app` and launched. Both menu entries were observed in the installed application, and Hide menu bar icon was selected as requested. The previous Build 34 is retained at `/private/tmp/cue-build34-backup.O4329r/Cue.app`.

Login registration was not enabled on the user's behalf, and no reboot, screenshot capture, audio capture or test suite was run. This change affects only the Mac client; no cloud deployment was needed.
