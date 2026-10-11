# One answer timeline and Windows overlay — build 26

User decisions: drop the chat concept, so answers are one timeline like transcripts (the last hour); bring Windows to the same overlay with interviewer captions.

## Implementation

- Cloud: a new answer replays the completed answers of the last hour (still at most 16 and the 180,000-character budget), whichever chat row stored them. `history` with `scope: "recent"` returns the last hour's answers across chats; a duplicate request ID re-sends that view. Chat rows, `new_chat`, `rename_chat` and chat-scoped `history` stay for older clients. No schema change, no records removed, protocol stays `cue-chat-v2`.
- Clients (Mac and Windows): no chat picker, new chat or rename. They store new answers under the newest chat row (creating one only if none exists), request `scope: "recent"`, accept chat-scoped history from a server that predates it, and keep only the last hour (plus a running answer) in the card. Against the currently deployed server this behaves like always using the newest chat; after deployment the one-hour cross-chat context applies. Drafts are one `cue.draft` key.
- Shared card: `OneExchange` in `Messages.tsx` (one exchange, newest unless paged back) is used by the Mac page and the Windows overlay. The unused empty-chat welcome screen is removed.
- Windows overlay: frameless transparent always-on-top window, hidden from the taskbar, sized by the page to its content and anchored top-center (drag position saved to `overlay.json` in the existing profile). Not focusable on click; the text box asks the host for focus while typing and releases it on blur. The menu is a native popup (answer depth and screenshot source as radio submenus, transcript, materials, web and connection settings, hide, quit) and tooltips are native, so nothing is clipped by the window edge. Transcript, screenshot picking and image preview are views inside the card. Global shortcuts Ctrl+Alt+Enter (answer, shows the overlay), Ctrl+Alt+S (screenshot), Ctrl+Alt+\ (show/hide); taken ones are reported. Tray: show/hide, answer, screenshot, quit. The pin IPC is removed.
- Windows captions: the shared transcription callback emits interviewer captions as a local `caption` event in the same renderer; nothing is sent to the server or stored. Same two-line strip, shown only while transcribing.

## Verification

- Cloud: 25 tests passed, including a new one: answers from another chat within the hour are replayed, one older than an hour is not; `scope: "recent"` returns the hour across chats while chat-scoped history keeps old behavior. Build and artifact validation passed. Settings page DOM/file parsing check passed.
- Desktop capture/transcription: 31 passed, 1 Windows-specific skipped.
- Windows UI build and Mac answer-page build passed. Electron UI checks passed: the rewritten overlay smoke test covers hidden newest chat with recent history, content-sized window (collapsed and expanded), focus requested only for typing, screenshot attachment, streaming reasoning/Markdown/table/math, copy, one exchange with paging, native-menu depth/source/failure, interviewer captions, transcript view, collapse and reconnect. The packaged Mac bridge check still passes.
- Mac offline checks: 23 core/transport and 55 native audio-delivery checks passed. Signed build 26 verified; executable SHA-256 `60e32ef4f918dfb13dcc131f5298bd72ee829873fc903fa2031a11219896fc66`. Preview render unchanged from build 25 apart from data.
- Not verified: Windows packaging (`package:windows` builds the NSIS installer and was not run on this Mac), any Windows device behavior (transparent window, focus handover, native menu, shortcuts, captions from real audio), Mac interactive acceptance (computer use blocked by missing Screen Recording permission for the Claude app), and the cloud change on Sites.

## Delivery

- Cloud source changed in `apps/cloud` (not committed, not pushed, not deployed). Sites deployment must be done through the Sites tooling from the pushed commit.
- Mac package built at `apps/macos/output/Cue.app` 0.4.1 build 26; not installed (installed app is build 25).
