# Cue panel in ChatGPT and settings page layout — build 27

User decisions: the remote is the Cue panel inside ChatGPT (sidebar app and conversation side panel) with start/stop transcription, screenshot and "让 GPT 回答"; ChatGPT answers with its own model, so the panel never uses the Responses API. No separate web remote page. The settings website becomes an ordinary page layout sharing the overlay's visual language. No hour-long live test (the user reconnects by hand if a long session drops).

## Implementation

- Cloud MCP: model-visible tools stay read-only (`read_context`, `list_materials`, `read_material`, plus `cue_panel` which opens the panel). The panel resource `ui://cue/panel` (`text/html;profile=mcp-app`) is one self-contained page bundling `@modelcontextprotocol/ext-apps` 2.0.1 (pinned). `cue_panel` registers `openai/ui` entrypoints `thread` and `global`. The panel's `remote_status` and `remote_command` (start, stop, shot) are `visibility: ["app"]`, so the model cannot list or call them.
- "让 GPT 回答" calls `ui/update-model-context` with Cue's answer instructions (read once on open) and `ui/message` asking ChatGPT to read the latest transcript and screenshots and answer the interviewer's current question.
- Relay through D1 (Sites has no shared memory between connections): append-only migration adds `remote_commands` and `remote_state`. Opening the panel marks it present; the desktop socket polls commands every second only while it is present, skips commands older than 15 seconds or queued before it connected, and runs each once. The desktop reports allow/phase/since/selected/error/source; only the current owner's report counts, and clients report only when `session_ready` carries `remote: true`, so build 27 stays quiet on the currently deployed server.
- Mac and Windows: panel commands run the overlay's own start/stop/screenshot code. "允许 ChatGPT 遥控" (default on) in the more menu; a phone icon while the panel is open; recordings started from the panel are marked 「面板」.
- Settings website: side navigation (回答设置, 个人资料), prompt editor filling the page with model and a segmented depth control beside it, materials as a list with the selected file's text editable on the right (download, replace, delete in its header); phones get a top bar and stacked columns. Same IDs and parsing paths as before.
- Dropped during the work: a web remote page and its API (`/remote`, `/api/remote/*`), removed before commit at the user's request.

## Verification

- Cloud: 26 tests passed, including the panel tool surface (model-visible tools read-only, app-only write tool, entrypoints, resource MIME) and the relay (offline/old-client/disabled rejection, dedupe by command ID, no stale or pre-connection commands, replaced owner cannot report). Build and artifact validation passed.
- Settings page: real-browser check (Electron, loopback) passed: settings save, UTF-8 upload, PDF/DOCX Worker parsing, saved materials. Desktop and phone layouts inspected from captures.
- Panel: Electron check with a minimal MCP Apps host passed: handshake, resource read through the real MCP endpoint, app-only tools queue screenshot and start that a simulated desktop connection receives, status/timer/captions/selection count, the GPT message with Cue instructions, and the remote switch.
- Desktop: capture/transcription 31 passed (1 Windows-only skipped); both UI builds; Windows overlay check now also covers panel status reporting, panel start/stop, the 「面板」 mark and the switch; Mac bridge check passed. Mac offline 23 + 55 checks passed; signed build 27 verified, executable SHA-256 `0c8bdb3ae4adfb4d954a6e4c81833faba4fbb81df09b50497dfc259833ae4f42`; preview shows the panel mark.
- Not verified: the panel inside real ChatGPT (needs the Sites deployment; whether ChatGPT asks for confirmation on panel button calls is undocumented), real remote start/stop/screenshot on the installed app, Windows device behavior and packaging, and long-session stability.

## Delivery

- Installed `/Applications/Cue.app` 0.4.1 build 27; build 25 kept in ignored `artifacts/acceptance/20261010-chatgpt-panel/` with the preview, panel and settings captures.
- Cloud changes committed and pushed to the private Cue-cloud repository; Sites deployment is pending and must be done with the Sites tooling from that commit. After deploying, reconnect the Cue app in ChatGPT so it reloads the tool list.

## 2026-10-11 follow-up: receipt fixes, Sites v24 and Mac build 28

This section supersedes the deployment and installed-build status above. The user authorized deployment after requesting fixes and regression tests for three review findings.

### Correctness fixes

- Commands bind to the desktop generation observed by the panel. The database verifies the current owner when claiming a command; a final owner check prevents a replaced connection from receiving it during the heartbeat interval.
- Before sending the ChatGPT message, the panel requests `prepare`: the desktop drains both PCM streams through its ordered control queue, fixes the transcription cutoff, and waits for the corresponding text to persist. This does not start recording or call Responses.
- Screenshot and other command results require completion receipts. A screenshot succeeds only after upload acknowledgement; pending actions block repeated panel questions, and failed or unknown outcomes are shown without automatic retries. Remote state protocol version 2 requires updated desktop clients.

### Release evidence

- Sites source and private GitHub cloud source: `ea4ea2151532fb3355f7050062fae97c417bd8ea`. The official source workflow built and validated the archive from that exact pushed commit.
- Sites version **24**, version ID `appgprj_6ac3050911388191a096e3850daec725~appgver_9d817509fcfc8191bb5f59d8badf18d8`; deployment `appgdep_6acb3823279c8191aae55f2a70ebd225` returned **succeeded** at `2026-10-11T07:18:04.692491+00:00`. The receipt migration is deployed. The existing project, custom domain, MCP endpoint and owner-only access were retained.
- Mac **0.4.1 build 28** was signed with the existing local identity, verified and installed at `/Applications/Cue.app`, then launched. Executable SHA-256: `7f588a386932abeeee6a335c102563987827fcb7ff526c1163a2f644fd6775b6`. Previous build 27 is backed up in ignored `artifacts/acceptance/20261011-panel-fixes/Cue-build27-1791703218.app`.
- Cloud: **36 tests passed**, build and artifact validation passed. Desktop capture/transcription: **34 passed, 1 Windows-only skipped**. Both UI builds and UI checks passed. Mac offline **23 + 71** checks passed, including native completion/failure handling. The panel SDK host test exercises the real MCP handler and database code with a simulated desktop and delayed tail transcriptions; it remains a simulated host test.
- After deployment, the existing authenticated Cue connection successfully called `list_materials` and returned the five existing materials. This verifies a live read-only MCP operation, not panel registration or control execution.

### Remaining acceptance

- The current chat still exposes the cached pre-panel tool catalogue. Refresh/reconnect the existing Cue plugin in ChatGPT to load the new tools; opening and using the panel in the real ChatGPT host remains unverified. The existing plugin identity was retained. Its app-owned description still has the old wording; available metadata tools do not support editing that field.
- Build 28 is running, but no new `remote_state` report was observed during release checks, so its authenticated connection and actual remote operations remain unverified. A new build may require the user to grant Keychain access again; no automatic recording, screenshot or paid-model check was performed.
- Windows packaging and real-device behavior, real microphone/system audio, real screenshot capture, and long-session stability remain unverified. The prior decision to omit an hour-long live test remains in force.

## 2026-10-11 real ChatGPT follow-up: Sites v25

- Opened the existing Cue plugin in the authenticated ChatGPT web UI, used **Refresh tools** (HTTP 200), and changed its app description to: `面试助手：在 ChatGPT 面板控制电脑转录和手动截图，读取最近上下文，由 ChatGPT 回答。` The UI readback confirmed the saved text; no new plugin or connection was created.
- The first real panel launch returned “应用不可用”: ChatGPT's widget resource request was HTTP 404 although the Worker received `resources/read`. Unlike the older simulated host, ChatGPT used MCP `2026-07-28`. Cue omitted the required `ttlMs` and `cacheScope` fields on resource/discovery responses. Added private, immediately stale cache hints and recognition of the protocol version in request metadata, preserving legacy responses. The regression failed before the fix and passed afterward; all **37 cloud tests**, build and artifact validation passed. Specification: https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching.
- Cloud source `e01721d8aa77a7ffb3b57e643636c3fe4e75ff55` was pushed to Sites and the private GitHub repository. Sites **v25**, version `appgprj_6ac3050911388191a096e3850daec725~appgver_11c3855b75a08191b480e31373d0a810`, deployment `appgdep_6acb3d8b9cfc8191be14257cfe198df3`, returned **succeeded** at `2026-10-11T07:41:11.044171+00:00`. Existing owner-only access was preserved; Mac remains build 28.
- After refreshing tools again, the real ChatGPT panel resource returned HTTP **200** and rendered its Cue iframe. Chrome accessibility readback showed `电脑未连接`, the caption placeholder, and the three buttons `开始转录`, `截图`, `让 GPT 回答`. Live Worker logs showed successful `remote_status` calls from that panel. This confirms the real ChatGPT web panel loads, initializes its MCP Apps bridge and reads status.
- The Mac connection is blocked by an observed system dialog: Cue requests access to `Sage Sites connection`, and macOS requires the **login Keychain password**. The agent brought the dialog forward but did not read, obtain or enter a password. Actual recording, screenshot and ChatGPT-answer actions remain untested until that authorization is completed. No media was captured and no answer was requested during these checks.
