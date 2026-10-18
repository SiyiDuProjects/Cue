# Cue MCP image delivery

Private cloud commit: `f45129f82a391747907591ca1f934b6c9636bd02`.
Sites deployment `appgdep_6ad551e14d68819195e73e89875a04e4` succeeded at 2026-10-18T23:10:34Z, retaining owner-only access and the existing plugin.

## Diagnosis

Production images were uploaded and retained. The latest capture at 16:02:51 Pacific was included in two independent conversation read records. The reported conversation described older 15:59 captures after a transport failure. Server logs for read_context showed HTTP 200 and outcome ok while the connector returned Transport closed. The old reader consumed image progress before response delivery, allowing retry to skip the failed newest batch and return older images. Conversation isolation was functioning; website answers did not consume MCP image progress.

## Change

Return one original per call, retaining pixels. A conversation-scoped receipt explicitly acknowledges the image on a subsequent read; missing or stale receipts never consume images. Retries repeat the unacknowledged original, while newly captured images take priority. A versioned conversation digest avoids carrying forward legacy premature image markers. No existing records are deleted. Response diagnostics contain only counts and lengths.

## Verification and limits

All 42 cloud tests and the cloud build passed. Tests cover lost-response retry, cross-conversation receipts, stale receipts, concurrent reads, newest-image priority, original bytes, and acknowledgment pagination.

After deployment, three real connector calls successfully returned the latest 3840x2160 original, including visible LeetCode 1890 content. Unacknowledged retry returned identical pixels and the same receipt. Production diagnostics measured 2,358,192 base64 characters per original. The previous multi-image failures versus successful single-image delivery narrow the failure to the response delivery path, but do not establish the connector's exact size limit or failing internal component.

This already-open chat retained the old tool schema and stripped the new ack parameter; live acknowledgment pagination is not accepted yet. Refreshed tool discovery is required to expose ack. Cached callers still retrieve the latest original safely, but may repeat it. No microphone, new screenshot, or paid model call was started. Work/ChatGPT host-specific acceptance beyond this connector remains unverified.

## Follow-up: transport root cause reproduced

A finite diagnostic sequence was restricted to this diagnostic conversation's digest, with an expiry; all probe code is removed from the final Worker. Other conversations retained the safe reader throughout.

- Same stored originals: 1, 2, and 3 image blocks succeeded; 4 originals failed twice with `Transport closed`.
- Three originals plus a tiny valid fourth PNG succeeded (~7.18 MB), ruling out a four-image count restriction.
- One unchanged original plus synthetic text padding: response target 8,000,000 bytes succeeded; 8,400,000 failed; 8,388,000 succeeded; 8,389,000 failed. This brackets the connector response limit at approximately 8 MiB (8,388,608 bytes). These are application-result targets; small JSON-RPC framing adds overhead. No claim is made about which proprietary connector component implements the limit.
- Thus the old 12 MiB **raw image** budget was wrong for the transport: base64 increases bytes by approximately one third, before JSON metadata. A multi-image result could pass Cue's raw-byte check and still be rejected downstream, while its image IDs had already been consumed.

Final reader restores up to four images but budgets encoded UTF-8 JSON, including image base64 and metadata, below 7 MiB with framing headroom. Oversized single originals return an explicit error without advancing any read progress; stored pixels remain unchanged and usable on the website. Explicit acknowledgment remains required to consume returned images.

Final private source: `aeb329037e26ad3b579ebe2321b4b9824691aa83`. All 44 cloud tests and build passed, including regression coverage for raw-versus-base64 batch budgets, unchanged original bytes, paginated acknowledgments, and oversized originals retaining progress. No paid model requests or new captures were used for this investigation.

Final deployment `appgdep_6ad5543d38c881918e19335be54f310a` succeeded at 2026-10-18T23:20:39Z. The real connector then successfully returned the three newest stored originals in one ~7.18 MB response, including the latest LeetCode 1890 screenshot; nine older originals remained available. Live acknowledgment pagination retains the tool-schema-cache limitation noted above.
