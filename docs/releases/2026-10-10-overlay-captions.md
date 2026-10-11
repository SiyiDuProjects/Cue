# Compact overlay and interviewer captions — build 25

User decision: the Mac window behaved like a large chat app with floating-window extras (pin toggle, translucency). Replace it with a real overlay: a small control bar, an answer card that opens on demand, and live interviewer captions. Captions are display-only and must not involve the server.

## Implementation

- Mac window is a borderless `NSPanel` with `.nonactivatingPanel`, floating level, `canJoinAllSpaces` and `fullScreenAuxiliary`. Clicking controls does not activate Cue or take keyboard focus from the meeting/browser; the panel becomes key only for the text field (`becomesKeyOnlyIfNeeded`). The hosting view and the answer `WKWebView` accept first mouse, and SwiftUI handles window-activating clicks, so controls respond to the first click while another app is active.
- The window size follows the SwiftUI content. The top-center anchor is the user's drag position (saved, never in preview); content grows downward and moves up only at the screen bottom. The answer card is at most half the screen height, then scrolls inside.
- Control bar: connection dot/drag handle, transcription (timer while active), captions toggle, screenshot (selected count), answer/stop, more menu, expand/collapse. The pin toggle, unified toolbar, chat picker and settings popover are gone; chat switching, rename, answer depth, transcript window, materials, web/connection settings and quit are in the more menu. Full transcript and screenshot selection open in a separate ordinary window.
- Answer card shows one exchange at a time (newest unless paged back) with the question reduced to one muted line; asking opens the card. The page reports its content height through a new `height` bridge call. Esc collapses the card.
- Captions: `DirectTranscription` takes an optional `caption` callback, called for every delta/full/completed text before the existing one-per-second server coalescing, inside its own try so a display failure cannot stop transcription. The Mac glue forwards only the `interviewer` role to native via a new `caption` bridge call, handled synchronously in arrival order. Native keeps the last three utterances, shows them in a two-line strip (reserved height, head truncation, CJK joined without spaces) only while transcription is active. Nothing is stored or sent to Sites. Preference `cue.captions`, default on.
- Global shortcuts: ⌃⌥⌘↩ answer (also shows the overlay), ⌃⌥⌘S screenshot, ⌃⌥⌘\ show/hide. Taken shortcuts are reported. Preview mode registers none. The answer page uses `inactiveSchedulingPolicy = .none` so transcription keeps running while the overlay is hidden.
- Windows UI and cloud are unchanged; the shared caption callback is optional there.

## Verification

- Desktop capture/transcription: 31 passed, 1 Windows-specific skipped.
- Windows UI build, Mac answer-page build and both Electron UI checks passed. The packaged Mac bridge check now also asserts that every interviewer partial reaches `caption` immediately, the server still receives one coalesced partial plus the completed event, and candidate audio yields no captions.
- Mac offline checks: 23 core/transport and 55 native audio-delivery checks passed (synthetic). Release package signed with the fixed local identity, `codesign --verify --deep --strict` passed, no `AXUIElement`/`AXIsProcessTrusted` imports. Executable SHA-256 `e18367a18d01af30538fb2d51d7a595ccf6b215980d147aa094fb7c25437dd69`.
- `--preview --render-preview` from the signed package rendered the expanded overlay with synthetic captions injected through the real page-to-native bridge, pager and compact question line. A temporary local build (not shipped) rendered the collapsed state: bar plus caption strip, window shrunk to fit.
- Not yet verified: real clicks while another app is frontmost, typing in the non-activating panel, menu, drag, Esc, hide/show and hotkeys on the installed app; captions from real system audio; Windows. Computer-use verification was blocked because the Claude desktop app lacks Screen Recording permission. No microphone, paid model or production connection was used.

## Delivery

- Built `apps/macos/output/Cue.app` 0.4.1 build 25 and installed it to `/Applications/Cue.app` after quitting build 24 normally (Apple Event quit, exited within 1 s). Installed executable SHA-256 matches the build above; designated requirement unchanged from build 24.
- Previous installed app and the preview render: ignored `artifacts/acceptance/20261010-overlay-captions/`.
- On first launch the system showed a Keychain authorization prompt for the device credential (expected with local signing across changed builds); connection waits for the user's approval.
