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
