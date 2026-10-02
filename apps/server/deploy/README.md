# Safe interview-server releases

The Responses/MCP release also packages public `app/prompts/*.md` and
`app/plugin/*` assets. `/health` advertises Responses and authenticated ChatGPT MCP;
the release gate validates their presence. `INTERVIEW_PUBLIC_URL` is the canonical
OAuth origin (default `https://interview.siyidu.com`). No private materials are
copied into the image. The MCP SDK is pinned in requirements; desktop 0.1.12 adds
the read-only local material bridge, provider/profile controls, and plugin setup.

The workflow stages code separately, then asks the running server to atomically
enter deployment mode. An active interview returns 409 and aborts the release
before deployed code or `.env` changes. New sessions and Start are excluded by
the same registry gate. Authentication uses the server access token inside the
container on loopback; tokens are never command-line arguments or logged.

Only `interview_api` is built or replaced. Shared services and orphan containers
are untouched. Existing `.env*`, context documents, virtualenvs and backup files
are excluded from code synchronization. Manage production context independently
outside `/opt/interview/server`, through a read-only mount. Production images do
not copy background documents. Release preflight checks that the running context
directory has a read-only mount before changing code or replacing the service.

Conversation records and workspace archives use `INTERVIEW_WORKSPACE_HISTORY_DIR`. Production must point
it at a writable private mount outside the deployed source, for example
`/opt/interview/private/workspace-history:/var/lib/interview/workspace-history`.
Keep this mount in the persistent Compose configuration so ordinary recreation
also retains archives. The local `data/` directory is excluded from images and
source synchronization; it is not a production archive backup.

The candidate process starts drained. Both local and public `/health` must report
the exact release ID, `interview-chat-v12` protocol, codex-app-server answer transport,
chat=true and pinned_code=false capabilities, and configured transcription/code/optional mock models. No paid
model or audio probe is performed. The verified image is then started normally,
so a later ordinary container restart does not leave it in deployment mode.
The release also persists `INTERVIEW_RELEASE_ID` and `INTERVIEW_START_DRAINED=0` in the production `.env` loaded by the service's `env_file`, so recreation through the original Compose configuration retains its release identity and accepts interviews normally.

This release replaces the assistant Live connection with two independent realtime
transcription connections plus explicit local Codex requests relayed to Electron. `OPENAI_LIVE_MODEL`
is used only by the optional mock interviewer. Release the server and verify v12
before distributing the matching desktop client; v5/v6/v7/v8/v9/v10/v11 clients are incompatible with v12.

The release retains the old image, source, environment, sanitized health snapshot
and private resolved Compose files under `/opt/interview/server.deploy-backups/`.
Directories are private and never automatically deleted. Resolved Compose files
can contain credentials; do not upload them or paste their contents into logs.

If an error occurs before the normal process is released, the previous service
is restored. If the final process has already been released, rollback must first
acquire the drain gate again. If a user has started an interview or safe drain
cannot be confirmed, automatic rollback stops and preserves that process instead
of interrupting a live interview. Rollback source synchronization also preserves
context documents and unrelated existing backups.

## Installing the gate on an older server

An older deployment without `/api/deployment` cannot provide an atomic safety
guarantee. The workflow deliberately refuses to bypass a missing endpoint. The
first upgrade needs an explicitly arranged maintenance window:

1. End the current interview and close the Electron capture host and all clients.
   Confirm there is no ongoing interview. This is a maintenance operation, not a
   health check that the agent may silently perform during a live interview.
2. On the server, retain a private copy of `/opt/interview/server`, its `.env`,
   and the current `interview_api` image. Do not move or replace the private
   context directory or its existing read-only mount.
3. In `/home/ubuntu/siyi`, stop only `interview_api` with
   `sudo docker compose stop interview_api`. Keep clients closed until completed.
4. Install the staged server code into `/opt/interview/server`, preserving `.env*`,
   `context/`, virtualenvs and backups. Set the five model settings documented in
   `release.py`; do not replace other environment values. Build and start only
   this service with `sudo docker compose build interview_api` followed by
   `sudo docker compose up -d --no-deps --no-build interview_api`.
5. Validate both local and public health with `deploy/probe.py health`. Validate
   the authenticated gate using the probe through `docker exec -i interview_api
   python - status < /opt/interview/server/deploy/probe.py`. The token is read
   from the container environment, not copied into the command.
6. If any check fails, restore the retained source/environment/image while the
   maintenance window remains closed. Otherwise allow clients to reconnect.
   Subsequent workflow runs can use the atomic gate normally.

## Explicit rollback after a deferred automatic rollback

Wait until the interview is ended, close capture clients, and acquire the gate
using `probe.py begin` through `docker exec` as above. Use the exact retained
release directory printed by the failed deployment; check its source, old image
and `old-health.json`. Restore its code and `.env` while preserving current
context and unrelated backups, then start the saved `rollback-compose.json`
with `docker compose -f <exact-backup>/rollback-compose.json up -d --no-deps --no-build
--pull never interview_api`. Verify against `old-health.json` before reconnecting.

These scripts and fixture tests establish deployment logic, not a completed
production deployment, provider availability, or real media validation.
