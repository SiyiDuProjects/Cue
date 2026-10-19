# Incremental reads and saved-image readiness

## Scope

Restore the September reader's independent, replayable positions. The first `read_context()` reads recent material; subsequent calls pass `cursor: next_cursor` to receive new revisions and remaining undelivered items. `has_more` continues batches, including images beyond the first 32-item catalog. Each input cursor has an immutable replay page; one reader cannot consume another reader's material. No conversation identity or mutable global read watermark is used. Reusing an input cursor intentionally replays its page; continuing uses its returned next cursor.

Per-reader positions and text-only replay pages use the append-only schema migration `0008_context_cursors`. Old read-progress data is preserved and unused. Expired positions fail explicitly. Cached tool definitions that cannot send `cursor` still receive the initial recent view; incrementality requires the refreshed tool schema.

Images record their original byte length on upload. Historical images use object HEAD metadata. Encoded result-size selection happens before fetching original bytes; only included images are downloaded. Original dimensions and PNG encoding are unchanged. Oversized images are explicitly reported rather than falsely delivered; unavailable originals stay retryable, and neither blocks later pages indefinitely.

Capture unlocks as soon as pixels are captured. Remote shot success is sent only after the server stores the original and must name that image. The remote command ID is also its stable upload ID. Desktop status lists uploading IDs so the website can render one pending slot per screenshot; saved receipts/attachments produce a thumbnail and “已就绪”. Failure stays explicit and originals remain available for manual retry. The existing eight-unsaved-original queue bound and latest-eight Cue answer selection are unchanged; saved images never block later captures.

## Delivery boundaries

Web, cloud, Windows renderer and Mac build 33 were compiled. The user explicitly requested no further validation, so no test suites, browser checks, screenshot fixtures, paid model requests or ChatGPT/Work cross-conversation acceptance were run. Affected regression fixtures were updated for the new contract, without claiming they passed. The existing package procedure was used with test invocations omitted for this build.

Cloud source `22037e562eb8bb262a368440797e9e796f96fad4` was pushed to Sites and the private GitHub backup. Sites deployment `appgdep_6ad57804a0748191907fd57ecda032bc` succeeded at the existing production site. Mac build 33 was installed at `/Applications/Cue.app` and opened after the idle previous clients exited. The previous installed bundle was preserved at `/private/tmp/Cue-before-build33.app`. These delivery checks are not screenshot or model acceptance.

No new notifications, automatic answers, capture sources, image compression, or plugin UI were added.
