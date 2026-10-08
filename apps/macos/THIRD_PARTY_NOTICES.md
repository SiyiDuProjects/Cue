# Node.js

The local app bundle includes the Node.js executable used by the native App Shot window capture bridge. Its distribution license and bundled third-party notices are copied verbatim
to `Contents/Resources/Node-LICENSE.txt` during packaging.

# Installed ChatGPT runtime

`Support/native-appshot.cjs` is a Cue-written MCP client for the user's separately installed
ChatGPT Computer Use runtime. Cue discovers its existing bundled `cua_repl` configuration and
requests one manual `get_app_state` capture. No ChatGPT runtime, source, native helper, credentials,
or session is copied into this distribution. This integration is not the complete Appshot UI or
a public Appshot SDK; availability and compatibility depend on the installed application.

# WebRTC VAD

The shared desktop transcription client bundles @ozymandiasthegreat/vad 2.0.7.
Its WebRTC VAD license is copied verbatim to `Contents/Resources/VAD-LICENSE.txt`.
