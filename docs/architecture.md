# Architecture: chat with optional interview context

## Product boundary

System audio and microphone are two independent transcription inputs. Speech only accumulates context. Explicit user messages and the Answer shortcut use the same local Codex thread. Screenshots are manually attached to the next message, previewable and removable. A screenshot taken while generating stays attached to the next draft.

Chat is the only answer surface. Explanations and complete implementations appear together in Markdown, with code-only copy. There is no separate code pane, file delivery obligation, automatic Git history, or code publication action. Topic changes and code follow-ups are ordinary conversation. Screenshots are evidence, never an automatic editor mirror.

## Generation and context

`codex_chat.py` retains request admission, transcript deltas and literal answer streaming. Its authenticated model WebSocket (`codex_host.py`) relays to Electron's `codex-host.cjs`; `codex-process.cjs` owns one CLI app-server process and thread per conversation, over stdio JSON-RPC. No TUI parsing, per-message exec, hosted Agents API, or hand-written Responses loop. Sol/high remains unchanged. Text streams directly without a simulated typing cadence.

The first explicit request supplies the ordered transcript. Follow-ups append only new/corrected transcript turns, the message and its attachments. Corrections identify the same turn ID. The CLI thread retains previous images, answers and tool records and owns compaction. Application raw records remain complete in private server SQLite, separate from native Codex thread state. No RAG, summary model or silent trimming is added.

The dedicated workspace contains a short AGENTS.md used as native baseInstructions, on-demand guides/, and ignored materials/. relevant personal files are read on demand by native CLI tools. A separate CODEX_HOME under .runtime/codex holds normal Codex login and thread data. No auth file is copied from the developer's desktop installation. Ancestor instructions, host skills/plugins, memories and subagents are disabled. The conversation cwd is conversations/<interview_id>/, with read-only sandbox and approvals disabled; Windows explicitly uses the unelevated sandbox; this is not a container or strict read-root isolation. CLI native web search remains available. Product code is not the agent's cwd.

Inputs are a snapshot at send. Later speech enters the next request. One request per interview is admitted under a short lock; network/tool waits do not hold it. Stop sends turn/interrupt and waits for a terminal event. Partial answers remain visible; an old task cannot overwrite a new conversation. A lost desktop relay cancels computation, retains displayed content and never resubmits input. An unacknowledged start/cancel poisons that runtime and closes its owned process; the user must start a new conversation. App exit waits for bounded cancellation before disposal. No billing-stop guarantee is made. Requests have a 120-second bound. Native thread records remain on disk. Restoring the UI performs no inference; the next explicit input uses thread/resume, with no blank-thread fallback or replay of historical tools.

No application dynamic tools are registered. Native tools read relevant materials, calculate and search to support the answer; they do not deliver files. Operation metadata is bounded, deduplicated and displayed in a collapsed disclosure; command output, arguments and reasoning are excluded. Unexpected application-tool or approval requests are rejected.

The model relay has its own bounded queue and socket; it does not block audio or share the audio binary channel. Authentication uses the desktop capture token in the first frame, never URL credentials. A browser token cannot register as a model host. Duplicate hosts are rejected; the raw app-server protocol is not exposed on a network port. CLI credentials stay local and the server OpenAI key continues to serve transcription/mock only.

## Chat and retained history

Electron no longer constructs CodeFiles, seeds old code, checkpoints files or creates Git commits. The backend rejects legacy file publication events and never includes old code in model requests. Existing files/Git/SQLite archives remain on disk, without migration or deletion. New code is part of the literal answer stream and copyable Markdown. The model prompt makes this the normal delivery method, including when resuming an older native thread.

The private SQLite database retains chat messages, screenshots, transcripts, pinned code/versions and the Codex thread association. Credentials, raw audio and active connections are not persisted. Old stepwise archives are adapted only when read; original records remain unchanged. Storage failure leaves the in-memory answer available and prevents switching away without saving. Streaming checkpoints are coalesced; completion and switching flush explicitly. The HeroUI conversation drawer lists, renames and switches these records. Switching while transcription or generation runs requires confirmation; the old request is invalidated before any new conversation becomes active. Per-conversation drafts stay in client localStorage.

## Transcription and transport

Two independent Realtime transcription connections use `gpt-live-transcribe`, 24k PCM, no server VAD, application commit after about 800 ms of silence or 30 seconds of continuous audio. All PCM is sent regardless of speech detection. Native item IDs preserve ordering and deduplicate final corrections. Disconnects retain partial text as interrupted and never reconstruct missing sound. A user correction takes precedence over late ASR.

Electron is the only capture host. Chat and manual screenshots work before any audio permission is requested. Start transcription prepares media on the desktop, including when requested from a phone. Stop releases both audio sources and transcription connections without ending chat or cancelling its generation. System audio and microphone are never mixed. Each queue has a bounded latency budget; gaps are surfaced. Images upload separately with capture credentials, not through the audio socket. All UI clients use the same React/client WebSocket and independent outbound queues. Snapshot copying is locked; network sending is not.

## Auth and optional mock mode

State is isolated by interview ID and token. Credentials stay out of URLs, renderer state and logs. Browser pairing requires desktop approval and uses a secure HttpOnly cookie. Capture credentials remain desktop-only. Formal chat materials remain in the desktop workspace; only mock background is mounted outside deployed server code, read-only.

Only mock mode retains a speaking Live interviewer and hosted expert. Candidate sound feeds it and transcription through isolated queues. Interviewer playback supplies a virtual ASR input; physical loopback is disabled. It receives true conversation/background but not helper chats or screenshots. The old pinned-code submission UI is no longer present.

## Release and verification

Protocol `interview-chat-v11` advertises `chat: true` and `pinned_code: false`. Both UI and capture require a matching protocol; v5/v6/v7/v8/v9/v10 clients are incompatible. Deploy the server through the authenticated active-interview gate, verify local/public health and assets, then distribute the matching Windows client. Private context and archive mounts stay outside code. Rollback preserves the prior image/source/config. Registry remains one process / one replica; service restart restores the selected saved conversation with fresh credentials; incomplete output is marked interrupted and neither model work nor recording restarts automatically.

Backend tests use an empty API key, loopback provider URL and disabled private history. Frontend build, state tests, capture tests and hidden Electron chat UI fixtures exercise actual React/FastAPI/WebSocket with synthetic media/provider responses. They do not establish real model quality or microphone accuracy. Superseded source/tests are retained under `artifacts/simple-code/superseded` and excluded from release packages.
