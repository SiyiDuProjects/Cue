# Native screenshot cleanup — build 24

User decision: remove App Shot, accessibility text extraction, recent-app tracking and window/page selection. Keep transcript viewing, screenshot previews, manual capture and answering. Capture the current main-display pixels, excluding Cue itself.

## Implementation

- Mac uses `SCScreenshotManager.captureImage` with a display filter excluding the current Cue process. PNG dimensions follow the display's native pixel scale. No target activation, synthetic input, automatic scrolling, OCR or page/editor inspection occurs in the capture path.
- Removed `WindowText`, the entire `SageAppShot` target, its window identity/traversal/budget checks, recent-app activation observer, persisted source handling and source-picker UI. Existing `capture.source` preferences are ignored; no user settings or privacy grants are reset.
- Cloud no longer stores incoming `appshot` payloads or attaches window text to new screenshot inputs. MCP exposes only source/time metadata with original images, including when reading legacy image records. Existing database/history records remain intact.
- Transcript/audio lifecycle, screenshot previews and manual multi-image attachment behavior remain. Windows capture implementation is unchanged; its UI fixture now uses real display choices instead of the removed Mac recent-app option.

## Verification

- Mac debug checks: 23 core/transport checks and 55 native audio-delivery checks passed with synthetic audio.
- Mac release package: the same checks passed; fixed signing identity verified. The binary imports no `AXUIElement` or `AXIsProcessTrusted` interfaces.
- Cloud: 24 tests passed, build and artifact validation passed. Added a regression covering original PNG readback, multiple selected images, ignored legacy text uploads, and exclusion of legacy window text from MCP/new model input while preserving old database records.
- Desktop capture/transcription: 31 passed, 1 Windows-specific check skipped on macOS. Windows UI build, Mac answer-page build and both Electron UI checks passed. These are not Windows-device or live microphone acceptance.
- Installed `/Applications/Cue.app` 0.4.1 build 24. Its executable SHA-256 is `5be700dee49e14846722b17397c10f5f4c52172f3cdb5ca97222747a537cb8f0`; designated signing requirement matches the previous installed build 22.
- Real installed-app screenshot clicks uploaded 3840×2160 PNG originals and were read back through Cue MCP. Metadata contains `source_id: display:1` and capture time, with no window text/status. Original PNG SHA-256 matches the server hash.
- A system comparison image records the restored Cue window over the main screen. The subsequent native capture contains the underlying screen without the Cue window. The desktop was also being used during testing, so these are visual checks rather than a frozen-pixel comparison or a general claim of being undetectable.
- Settings no longer lists App Shot, recent applications or window sources. No microphone, paid model answer, code execution or submission was started. Test attachments were removed from the next-question selection.

## Delivery

- Cloud source: `5e0831dda53194eb2c5ef19250b5aa99350e827b`.
- Sites deployment: `appgdep_6aca065900388191ab81d6a3c62fc3b9`, succeeded; owner-private access preserved.
- Saved version: `appgprj_6ac3050911388191a096e3850daec725~appgver_e0a7ea6106a881919efa9708e5ff6803`.
- Production: `https://interview.siyidu.com`; platform/MCP origin remains `https://sage-capture.dusiyi0916.chatgpt.site`.
- Local evidence and previous installed app: ignored `artifacts/acceptance/20261010-native-screenshot/`. Desktop screenshots stay in ignored evidence, not public Git source.

The initial sandboxed release build was blocked by `dsymutil` filesystem restrictions; it succeeded when rerun with the normal local build permissions. Screen Recording permission and macOS capture indicators remain controlled by the OS. This change excludes Cue from its own captures; it does not assert exclusion from other applications' screen sharing.
