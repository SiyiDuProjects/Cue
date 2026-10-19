# Cue MCP pure context reads

Follow-up: this read-path acceptance did not cover sustained capture without a Cue answer. The later eight-attachment capture regression and its ten-image real-device verification are recorded in [continuous capture](2026-10-18-continuous-capture.md).

## Published source

Private cloud source and verified GitHub backup: `b48bd287fcfa795f866d4b29f809b50843040d1b`.
Sites deployment `appgdep_6ad55ecbe3248191a856af197b716c9f` succeeded at `2026-10-19T00:05:42.122127Z` (October 18 local time).
Version: `appgprj_6ac3050911388191a096e3850daec725~appgver_5e71ea57f5bc8191a631caa713b76071`.
Existing Site, plugin identity, owner-only audience and URLs are unchanged.

## Behavior

Default `read_context()` directly returns recent transcripts and original image blocks, with a complete recent image catalog. Reading never consumes content. There is no session digest, read-state update, receipt, pending delivery, or CAS loop. The unused context_reads table and its records remain intact.

Explicit `images` requests retrieve selected originals without repeated transcripts; `before` reads earlier transcript rows after selecting current revisions. Old `ack`/`history` arguments are ignored. `content_index` ties each attached original to its catalog entry. Budget, oversized, unavailable and unrequested images have distinct statuses. One unavailable or oversized original does not block other images or text.

The result includes actual encoded JSON escaping and catalog bytes in a 3.75 MiB budget with envelope headroom; original pixels are unchanged. Individual oversized originals remain an explicit limitation; no tiling or shrinking was added. Time and live data changes can alter repeated results; fixed-clock tests establish deterministic content for unchanged inputs.

## Offline verification

All 45 cloud tests passed, along with build and packaged Worker validation. Regression coverage includes dropped-response retry for both text and images, concurrent non-consuming reads, a six-image catalog with direct-ID retrieval, new arrivals, original-byte equality and response budgets, missing/oversized originals, removed/expired IDs, revision-safe history, legacy arguments, no-session callers, owner authorization, and no reader writes even on an empty database.

## Live verification

The initial pure-query deployment at `7ce7b3908990f8da2ac7490537b1634c8936ae92` retained the proposed 7 MiB budget. Work read three originals, but ChatGPT failed with `AioRpcError` on the same approximately 6.13 MB reply. Controlled ChatGPT requests with the same count (two images) succeeded at 4,063,388 base64 bytes and failed at 4,409,024 base64 bytes; each had 950 metadata characters. Both images from the failed pair succeeded individually. The server logged successful response construction in each case. The exception did not expose a gRPC status or documented hard limit, so the exact platform boundary is not claimed. The final shared budget is conservatively below the successful payload at 3.75 MiB, with 4 KiB reserved for the envelope. There are no client-specific branches or delivery state additions.

Three distinct RTF test documents were displayed on the Mac and captured through the running Cue application's existing global screenshot shortcut, using its real upload path. No microphone was started and no Cue Responses answer was requested. The connector returned all three new 3840×2160 originals. A subsequent call using old `history`/`ack` arguments returned identical image bytes after another conversation had read them.

The user explicitly authorized verification in the existing ChatGPT chat “面试辅助设置” and Work chat “准备 Cue 面试救急”. Prompts did not contain the expected image markers or numbers.

- Work: after the final deployment, default reading returned C and a complete catalog, then the model independently fetched A and B by ID. It correctly read A / CEDAR-5817 / 42, B / ORBIT-9264 / 73, and C / MAPLE-3048 / 19, including the incidental lowercase s and input-method candidate bar visible on C.
- ChatGPT: after the final deployment, default reading returned C, then A and B were fetched individually from the catalog. All three titles, markers and numbers were correct, with zero transport errors in that acceptance run.
- New fourth screenshot: captured through Cue at `2026-10-19T00:08:00Z`, after both conversations had read A/B/C. Both conversations made one default call and correctly identified the new D / CORAL-7621 / 86 image without receiving its expected text in the prompt. A root connector read before them did not consume it.

Observed end-to-end turn durations (tool use, image reading and generated verification reply; not isolated transfer benchmarks): three images took about 32.1 seconds in ChatGPT and 31.1 seconds in Work. The subsequent single new image took 24.5 seconds in ChatGPT and 26.7 seconds in Work. These small-sample timings do not establish a latency SLA or the latency of solving an actual interview problem. The final budget trades extra image-fetch round trips for delivery within the tested transport range.

Both existing test conversations obtained the new optional selectors and used them successfully. Callers still caching an older definition can use default reads, but need a schema refresh to use the new selectors. These checks do not claim indefinite session reliability or support for individual oversized originals. Only temporary test documents were closed after capture; Cue and the user's other documents were preserved.
