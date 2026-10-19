# Interview-context regression and Cue 0.4.2 build 37

## Scope and findings

Tested interview transitions and context delivery rather than a long audio session. The integration suite runs the actual shared desktop transcription client, cloud capture session, answer assembler, MCP reader and SQLite schema. OpenAI events, transport faults and media are synthetic; these checks do not claim live speech-recognition quality.

Found and reproduced two related client defects:

1. Stop followed immediately by answer could calculate two different cutoffs while an earlier audio commit was still unconfirmed. The stop operation submitted the tail first; the answer then observed an empty buffer and could omit that tail. Each retiring channel now owns one immutable final boundary shared by stop, handover and overlapping answers.
2. Cancelling an answer that was observing a shared retirement boundary did not immediately release the preparation state. The observer now cancels independently; completing and saving the recording tail continues.

Screenshot capture, upload queues, image selection and cloud production code were not modified.

## Automated scenario results

`node --test tests/interview-context.test.mjs`: 10 passed.

| Scenario | Verified result |
| --- | --- |
| New questions, old cursor and two independent readers | Newly captured pages remain visible; advancing one reader does not consume another reader's content. |
| Database writes fail during 12 alternating utterances | All complete sentences remain pending; recovery saves all 12, while screenshots remain readable. |
| Save succeeds but its acknowledgement is lost | Answer waits, retry does not duplicate the sentence, and the saved sentence is already readable through MCP. |
| Next question saves before the current tail | Answer includes only the exact cutoff, excluding later speech. |
| Stop followed immediately by answer | Answer waits for the stopped tail to finish and save. |
| Disconnect and reconnect | Retained finals save under the new connection; recording remains stopped until explicitly started. |
| 11-image burst, lost reply, then a twelfth image | Latest image is first, all 12 drain through pagination, and another reader can still read them. |
| Restart while the previous recording tail finishes | Answer includes both relevant recordings; finishing the old tail does not stop the new recording. |
| Stop while an answer is pending | Pending answer is cancelled; both earlier and final speech are saved. |
| Read a partial transcript before its final correction | The same utterance appears again with the corrected final text. |

Regular desktop capture checks: 44 passed, one existing platform-specific skip. Two new regressions cover the shared stop/answer boundary and cancellation without discarding its tail. Packaged UI tests passed for 24 originals, twelve pending uploads, remote controls, captions and synthetic dual audio with real VAD WASM. Mac release checks, including 114 native audio-delivery checks, passed. Windows packaging and private-file archive inspection passed.

## Actual device and reader checks

- Installed and launched `/Applications/Cue.app`, version 0.4.2 build 37; capture and answer controls became enabled while recording stayed stopped. Build 36 is preserved in `artifacts/apps.noindex/Cue-before-0.4.2-build37.app`.
- The unchanged private cloud remains at `cfa3f36e90ca0a644b533bab5f35e991008e56ad`.
- Both original authorized readers, ChatGPT `面试辅助设置` and Work `准备 Cue 面试救急`, called the old incident cursor `5370157b-0fb2-4661-b9c2-43440d9f52f8`. Both received `reset: protocol`, matching structured/text metadata, and the actual new image `15fecf02-e940-41e9-9270-4f3b86002fcc` captured at `2026-10-19T09:08:52.000Z`. It was the current foreground window, not the controlled test page; this checks transport and migration only.
- The temporary TextEdit page was then put into full screen through native UI automation. Cue captured and uploaded three distinct test pages, each independently viewed through production MCP: A / ORCHID-4837 (`fa2f0739-c56d-4ea3-b653-48da985ad9ec`), B / COBALT-7194 (`cf37ff70-0336-4ee6-a862-5d6e4cd324e2`), C / MAPLE-2605 (`32f840a9-a63b-4391-9525-2654b0f0325e`).
- Reading C while upload was still pending returned no new image. Reading from that returned cursor after upload finished returned C normally; the early read did not skip the arriving image.
- Both original ChatGPT and Work conversations then used their own previous cursors and independently identified all three test pages, markers and constraints from actual image blocks. Both reported `more.new: 0`; neither reader consumed the other's images.
- After that read, D / AMBER-9362 (`d85aeff3-19b0-4e92-a06a-2493157a843f`, captured `2026-10-19T09:22:43.000Z`) was captured normally. Both readers then identified only the new D test page, including returning the substring length and the empty-input rule. An intervening capture had contained another foreground app; both readers correctly reported that actual non-test screen instead of inventing a test question.
- Reusing the live checkpoint from before A after capturing D returned D first, with `more.new: 2`; following the new cursor delivered the two remaining images and `more.new: 0`. It did not replay a frozen old page or consume omitted images.
- Restored and minimized the temporary TextEdit window, removed only this test's six pending Cue attachments, and returned Cue to its collapsed connected control bar with recording stopped. Server screenshot records were retained.

## Artifacts

- Installed Mac UI bundle `content-BImQWMyh.js`: SHA-256 `2769ecc273ae7fcb0cdb3fbd321edac1afa800ce465fc23065b1cd6e20802e5e`.
- Windows `releases/windows/Cue-Setup-0.4.2.exe`: SHA-256 `433eb2f1c4a9105b77f8f91bacdb82a5a17691bc73e6baeed6cae7e52a0a56f5`.

No microphone or system-audio recording was started. Long-duration audio and Windows hardware capture were not exercised.
