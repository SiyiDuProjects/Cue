# Continuous manual capture without Cue answers

## Cause and correction

The running Mac app showed eight selected screenshots and the error “最多待发 8 张截图，请先回答或移除。” The cloud's newest image remained at 17:39:28 local time. The native and Windows clients rejected the next screenshot when saved attachments plus unuploaded originals reached eight. ChatGPT and Work reads do not clear Cue answer attachments, so a normal MCP-only session eventually stopped capturing before upload even began.

The combined limit was introduced by outer commit `94e6f68` on October 11. The preserved October 2 migration snapshot `c55d818` has an independent manual-capture path without this gate. That snapshot is not proven to be the exact binary used on September 30; no exact September 30 performance comparison is claimed.

Capture now limits only the queue of unuploaded originals to eight. Saved images no longer block another capture. Cue's own next answer keeps the latest eight attachments, with a visible explanation; older cloud originals remain available. Upload failures retain their originals and fixed upload IDs and still block Cue answers until explicitly retried. The cloud's cumulative 32-images-per-hour upload rejection was removed. MCP's bounded default catalog remains the latest 32, reports `has_older_images`, and can retrieve older still-recent originals by known ID. Pure reads, original pixels, owner authorization and the one-hour retention view are unchanged.

## Release

- Private cloud commit: `23f22003d085c333819c836995385c3654d6b353`, pushed and verified against GitHub main.
- Sites deployment: `appgdep_6ad5694ec5a08191a1c83b285f820108`, succeeded at `2026-10-19T00:51:15.142760Z`.
- Sites version: `appgprj_6ac3050911388191a096e3850daec725~appgver_e3605f60e7c88191bb816f77421e2f62`.
- Mac 0.4.1 build 32, signed with the existing local identity. The verified package was also installed at `/Applications/Cue.app`; build 31 was preserved in a temporary backup. Running and installed executables have SHA-256 `921333bfd962a5b0b414c42df504a5b81ca64c260c8b2ec4961f59eedf614c40`.

## Verification

Cloud: 46 tests and build passed. A regression saves 40 originals without any answer or read acknowledgement, returns the newest catalog and image, and still retrieves the oldest recent image by ID. Mac offline: 23 protocol and 100 native orchestration checks passed, including 12 successive uploads without an answer and explicit backpressure preserving eight unuploaded originals. Desktop capture: 38 passed, one existing skip. Desktop, Mac answer-page and private web builds passed. Web DOM tests passed.

The complete Electron UI suite passed, including a new 20-image continuity check and the Mac bridge checks. Initially the existing caption-scroll check timed out in its hidden BrowserWindow. Running the same test with background throttling disabled passed; that setting is now explicit in the test harness. Production caption behavior was not changed.

With the user's authorization, one new TextEdit test document was placed in the foreground. Its content was changed for each of ten captures using the running build 32's normal screenshot button. No Cue answer was generated, no recording started, and no screenshots were cleared during this sequence. Preparatory attempts before the user foregrounded TextEdit were not counted as these ten fixtures. All ten captures appeared with distinct IDs in the live MCP catalog:

| Test | UTC capture time, October 19 | Image ID |
| --- | --- | --- |
| 01 | 01:02:08 | `2fefb443-f76a-4965-8504-0b406f5ceeb3` |
| 02 | 01:02:33 | `e37a1a7f-9806-428d-945d-e11348518378` |
| 03 | 01:02:34 | `40e25f5b-f49a-456d-a19f-a832f655941e` |
| 04 | 01:02:36 | `ff743363-22cb-43f0-b0b2-ea40084aab29` |
| 05 | 01:02:47 | `276e7e11-d37e-4eaf-ba34-7e7704a38a22` |
| 06 | 01:02:48 | `d4aa325e-9e9d-4165-922c-6559ffdc103d` |
| 07 | 01:02:50 | `4553c372-def0-49f2-a150-1906a8dd9375` |
| 08 | 01:02:51 | `752c7eb8-dbfa-43f5-a1df-11d2c06b7742` |
| 09 | 01:02:52 | `088ad48f-f9d2-4225-b858-68bab6e98a66` |
| 10 | 01:04:47 | `3514674f-ad6c-4b11-a1bc-d54ea6f055fd` |

The two authorized original conversations, ChatGPT “面试辅助设置” and Work “准备 Cue 面试救急”, each received a prompt without expected image text. Both made one default read and correctly reported `CUE CONTINUOUS CAPTURE 09`, `JUNIPER-9472`, `83`, and the matching ID/time. After both completed, test 10 was captured. Each again made one default read and correctly reported `CUE CONTINUOUS CAPTURE 10`, `SEQUOIA-5268`, `69`, and that it was 1 minute 55 seconds newer. A root read before each conversation did not consume either image. No repeat request was needed in these four acceptance turns.

Work tool durations were 5.058 seconds for test 09 and 3.983 seconds for test 10; whole turns were 18.867 and 16.926 seconds. ChatGPT whole turns were approximately 16.6 and 20.9 seconds. The thread-reading tool exposed ChatGPT's persisted response later than its recorded completion time, so polling delay is not counted as model execution time.

The temporary test document was saved under `/private/tmp` and closed; the user's pre-existing TextEdit document was preserved. This verifies Mac continuous capture and both consumers at this release. Windows real-device capture, individual oversized originals, and an entire interview's stability are not claimed.

## Earlier 11-second startup delay

The original slow Work turn spent 11.649 seconds between `task_started` and `turn_context`, before the Cue call. Subsequent cross-conversation dispatch spent 0.491 seconds there. Two normal user-message turns spent 1.379 and 0.057 seconds; their whole turns were approximately 12.5 seconds each. In this continuous-capture acceptance, cross-conversation startup was 0.341 and 0.117 seconds.

These measured samples show that cross-conversation dispatch does not inherently add 11 seconds. The exceptional startup delay was outside Cue's tool execution. They do not establish its exact host-side cause or prove that ordinary user input can never encounter it; prompts and live image state were not perfectly identical across the earlier comparison.
