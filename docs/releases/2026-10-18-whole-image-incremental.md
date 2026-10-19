# Cue incremental screenshots — build 34

This revision separates live followups from unread historical context, matching the September 30 baseline. It also makes the stored image record authoritative for screenshot readiness and retains consecutive capture requests while uploads run.

## Final behavior

- `updates_cursor` contains only new images, new turns and transcript revisions after the first observed baseline. `history_cursor` independently exposes older unread items. `next_cursor` continues the selected mode. The initial one-hour lower bound stays fixed when following a cursor.
- A selected original fetch failure fails the whole read before saving its next position. Retrying the same input cursor fetches originals again; cached pages never turn an unavailable original into an empty successful result. Removed images remain removed.
- Whole images only. Desktop capture uses a maximum 1920-pixel long edge and PNG first. If necessary, JPEG quality and then dimensions are adjusted automatically until the image fits 2.5 MiB. The server accepts the same size bound. No image tiles, partial-image endpoints or additional tools are introduced.
- Multiple images are returned within the existing conservative 3.75 MiB encoded result budget. Originals omitted for page capacity remain available to subsequent pages. This budget follows the earlier ChatGPT transport observations; it is not claimed to be a documented Sites hard limit. The previous 10.5 MiB allowance was an upload ceiling, not an observed typical screenshot size.
- Capture requests serialize separately from uploads. There is no eight-unsaved-image guard. Successful capture remains queued in memory until upload is confirmed; a failed upload retains the queue for explicit retry. The latest eight attachments for Cue's own answer remain a separate selection, not an MCP storage limit. Queue persistence across process exit is unchanged.
- The server stores the image object, then commits the image row and screenshot command completion in one database transaction. The website's ready state follows that server receipt. A separate client success message is no longer required. Accepted screenshots still in the online desktop's capture/upload queue do not get a false thirty-second timeout.

## Delivery evidence

This change uses source review and compilation/packaging only, following the user's instruction not to run more tests or live capture acceptance. Regression fixtures were updated for independent history/update positions, retry after object failure, the upload byte contract, serial bursts and server-owned readiness. They were not executed for this revision.

Mac build 34 retains the existing bundle ID, signing identity, credentials and user directories. The existing private Site, plugin identity, tools and domains are retained. No schema migration or user-record deletion is required.

## Publication and installation

The earlier automatic approval service capacity failure was resolved after the user updated the execution permissions and requested continuation. The normal source workflow was then used without an alternative publication path.

- Private cloud source and GitHub backup: `e7869810b66f2c0f8b8282c129fd073df754abf0`.
- Sites deployment: `appgdep_6ad5993f10d08191b4e11180fda8d9c8`, succeeded at `2026-10-19T04:15:06.884179Z` (October 18 in Los Angeles).
- Saved version: `appgprj_6ac3050911388191a096e3850daec725~appgver_66f636fbfe0c8191a368527d5114a414`.
- Existing production URLs: https://cue.siyidu.com and https://cue-app.dusiyi0916.chatgpt.site. MCP remains enabled.
- Mac Build 34 installed at `/Applications/Cue.app`; its signature was verified. The prior Build 33 bundle is retained at `/private/tmp/cue-build33-backup.wvwohV/Cue.app`.
- Cloud Worker, web UI and Windows renderer builds completed. Mac Build 34 was compiled, packaged and signed. No test suite, live capture or model acceptance was run for this revision.
