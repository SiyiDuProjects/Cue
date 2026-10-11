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
