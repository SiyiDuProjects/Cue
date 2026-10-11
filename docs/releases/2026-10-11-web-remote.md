# Cue web remote and incremental MCP — Sites v29, Mac build 29

The website now provides the interview controls, captions and one-answer view shared with the desktop. Settings remain at `/settings`. The ChatGPT panel and its private tools/resources are removed; the existing Cue plugin exposes only `read_context`, `list_materials` and `read_material`.

## Implementation

- Mac and Windows report remote protocol version 3. Web ask uses the desktop's ordered answer path with text and optional effort; its receipt identifies the reserved answer. Cancel also cancels an answer waiting for uploads. Unselect removes a pending attachment without deleting its saved original.
- Capturing a screenshot acknowledges capture before upload. Originals upload sequentially; successful uploads enter the selection. Answers wait for capture and upload completion. Failed originals remain in memory for this app run, block answering and support explicit retry with the same upload ID. This is not durable storage across application exit.
- Updated desktops negotiate HTTPS command pickup, removing D1 command polling from their long-lived WebSocket execution. Ownership, generation fencing, atomic claims and expiration checks remain. Older desktops retain their existing pickup path.
- `read_context` hashes the verified owner and ChatGPT's anonymous `openai/session` hint; the hint never grants access. An additive `context_reads` table stores revision-checked progress. First read returns the latest approximately 22,000 characters; subsequent reads return new/corrected turns, and `history:true` reads earlier turns. Each call returns up to four unseen originals within approximately 12 MiB and remaining counts. Missing hints and explicit cursors use the existing fallback.

## Release

- Private cloud source: `a476f87c42d53e7644079f4a24dfef90dd67b655`, pushed to Sites and the existing private GitHub backup. Shared UI assets were regenerated before the cloud build; licensed HeroUI Pro output remains only in the private repository.
- Sites **v29**, version `appgprj_6ac3050911388191a096e3850daec725~appgver_2888a8342684819180d1aba26a6df449`, deployment `appgdep_6acb68be16508191881ea86e16c45fc3`, succeeded at `2026-10-11T10:45:30.702405+00:00`. Sites accepted the 5,952,088-byte Worker (gzip 1,462,688 bytes). Existing owner-only access, domain and plugin identity are preserved.
- Mac **0.4.1 build 29** is signed, installed at `/Applications/Cue.app`, running and connected with remote version 3. Build 28 is backed up under ignored `artifacts/Cue-build28-before29.app`. An initial overlaid copy retained old hashed UI assets; installation was replaced with a clean bundle and strict signature verification passed. Executable SHA-256: `a628a8ef7c612b8dcbb1e71853984721633999be311023eb2d1761282e6cb45a`.
- Windows installer: `releases/windows/Cue-Setup-0.4.1.exe`; SHA-256 `7fbf22400e518eef117eadf0615994c1b3f7bc5fb68d078284ac08096122c427`. Built on Mac; not installed or accepted on a real Windows device.

## Validation

- Cloud: **43 tests passed**, build and artifact validation passed. Incremental-read tests cover separate conversations/owners, corrected turns, multiple pages, history, concurrent calls, image count/byte bounds, failed image reads and legacy fallback. HTTPS pickup tests cover owner fencing, one-time claims, expiration and bypassing WebSocket polling.
- Capture/transcription: **34 passed, 1 Windows-only skipped**. Desktop and Mac webview builds, desktop UI/direct-transcription checks and native offline checks passed. Native coverage includes three delayed uploads, early capture receipts, waiting/cancellation, complete image selection, failure retention and explicit retry.
- The built web UI at 390 px passed against the real Worker with simulated desktop/media: three queued captures, upload feedback, removal, cancellation while waiting, progressive answer updates and light/dark layout. Settings UI and synthetic PDF/DOCX parsing passed. Windows packaging and ASAR privacy checks passed.
- Real Chrome on this Mac, `https://interview.siyidu.com`: connected to installed build 29, captured and uploaded three originals, then completed a paid quick answer whose persisted context contained all three image IDs. Second and third clicks were approximately 1 second apart; this is a spot check, not a mobile latency benchmark. An apparent stuck spinner during testing was the inactive browser tab pausing polling; bringing the correct tab forward displayed the three attachments.
- Real ChatGPT web: refreshed Cue tools and opened a new verification conversation. First `read_context` returned `mode:latest`, 9 turns and 3 images; the second returned `mode:incremental`, 0 turns and 0 images, with all remaining counts zero. The production progress row contained only a hashed conversation key, corroborating receipt of a usable session hint. The new conversation reported no `cue_panel` tool. The app description was updated through its existing settings to the read-only use and saved text was read back.
- Real web removal and cancellation: captured one additional original and removed it from the pending attachments. A bounded quick-answer test then persisted zero image IDs, showed a 167-character partial answer, and changed to `cancelled` with 319 visible characters after pressing Stop. The observed first partial was at about 5.45 seconds and cancellation confirmation at 6.69 seconds after this test click; these are individual observations, not latency guarantees. Two paid Responses requests were made during live acceptance in total.

## Remaining acceptance

Physical phone/iPad interaction and latency, real Windows installation/media, and long-session behavior remain unverified. The user has declined an hour-long soak. No microphone or system-audio capture was started during this release; synthetic tests do not replace those device checks.
