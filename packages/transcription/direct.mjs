// Shared by WKWebView, Electron and the explicit synthetic acceptance runner.
// Device credentials never enter this module. Short-lived tokens authenticate
// OpenAI transcription sessions; audio is never sent to the Cue server.
export class DirectTranscription {
  constructor({
    send,
    makeVAD,
    fail,
    WebSocket: Socket = globalThis.WebSocket,
  }) {
    Object.assign(this, { send, makeVAD, fail, Socket });
    this.channels = new Map();
    this.active = new Map();
    this.epoch = 0;
  }
  handle(event) {
    if (event.type === "asr_config") {
      const epoch = this.epoch;
      void this.open(event).catch(() => {
        if (epoch === this.epoch) this.failed("无法连接语音服务。", "client_setup");
      });
      return true;
    }
    if (event.type === "asr_close") {
      this.close(this.channels.get(event.stream));
      return true;
    }
    if (
      ["session_ready", "disconnected", "replaced", "stopped"].includes(
        event.type,
      )
    )
      this.reset();
    return false;
  }
  async open(config) {
    const epoch = this.epoch;
    if (
      !["interviewer", "candidate"].includes(config.role) ||
      typeof config.token !== "string" ||
      !config.token.startsWith("ek_") ||
      this.channels.has(config.stream)
    )
      throw Error("Invalid transcription configuration");
    const vad = await this.makeVAD();
    if (epoch !== this.epoch) {
      vad.destroy();
      return;
    }
    const ws = new this.Socket(
      "wss://api.openai.com/v1/realtime?intent=transcription",
      ["realtime", "openai-insecure-api-key." + config.token],
    );
    const channel = {
      id: config.stream,
      role: config.role,
      ws,
      vad,
      ready: false,
      closed: false,
      bytes: 0,
      elapsed: 0,
      silence: 0,
      spoken: false,
      remainder: [],
      text: new Map(),
      published: new Map(),
    };
    this.channels.set(channel.id, channel);
    const timeout = setTimeout(
      () => this.failed("语音连接超时。", "openai_timeout"),
      10000,
    );
    channel.timeout = timeout;
    ws.addEventListener("open", () => {
      if (channel.closed) return;
      ws.send(
        JSON.stringify({ type: "session.update", session: config.session }),
      );
    });
    ws.addEventListener("message", ({ data }) => {
      if (channel.closed || epoch !== this.epoch) return;
      try {
        const event = JSON.parse(data);
        if (event.type === "session.updated") {
          if (channel.ready) return;
          clearTimeout(timeout);
          const previous = this.active.get(channel.role);
          // The old commit marker precedes readiness on the ordered Cue socket.
          // Later PCM enters the new upstream without waiting for the old tail.
          if (previous) this.commit(previous);
          channel.ready = true;
          this.active.set(channel.role, channel);
          this.send({ type: "asr_ready", stream: channel.id });
        } else if (event.type === "error") {
          const code = event.error?.code || event.error?.type || "openai_error";
          this.failed(`语音服务拒绝了请求（${code}）。`, code);
        } else if (
          event.type === "input_audio_buffer.committed" ||
          /^conversation\.item\.input_audio_transcription\.(delta|full|completed|failed)$/.test(
            event.type,
          )
        ) {
          const safe = { type: event.type, item_id: event.item_id };
          for (const key of ["delta", "text", "transcript"]) {
            if (typeof event[key] === "string") safe[key] = event[key];
          }
          if (
            [".delta", ".full"].some((suffix) => event.type.endsWith(suffix))
          ) {
            const text =
              event.transcript ??
              (event.type.endsWith(".full")
                ? event.text
                : (channel.text.get(event.item_id) || "") +
                  (event.delta || "")) ??
              "";
            if (text.length > 30000) throw Error("Transcript too large");
            channel.text.set(event.item_id, text);
            // Coalesce partial text to one update/second/channel item. Final
            // events and ordered commit markers are always sent immediately.
            if (Date.now() - (channel.published.get(event.item_id) || 0) < 1000)
              return;
            channel.published.set(event.item_id, Date.now());
            safe.type = "conversation.item.input_audio_transcription.full";
            safe.transcript = text;
            delete safe.delta;
          }
          this.send({ type: "asr_event", stream: channel.id, event: safe });
          if (
            event.type.endsWith(".completed") ||
            event.type.endsWith(".failed")
          ) {
            channel.text.delete(event.item_id);
            channel.published.delete(event.item_id);
          }
        }
      } catch {
        this.failed("转录数据无效，采集已停止。", "invalid_event");
      }
    });
    const closed = (event) => {
      if (!channel.closed && epoch === this.epoch)
        this.failed(
          channel.ready ? "语音连接中断，请重新开始。" : "无法连接语音服务。",
          // A close code tells a rejected handshake from a dropped connection.
          "closed_" + (event?.code ?? "error"),
        );
    };
    ws.addEventListener("error", () => closed({ code: "error" }));
    ws.addEventListener("close", closed);
  }
  pcm(role, buffer) {
    const channel = this.active.get(role);
    if (!channel?.ready || channel.closed) throw Error("语音连接未就绪。");
    const bytes = new Uint8Array(buffer);
    if (!bytes.length || bytes.length > 24000 || bytes.length % 2)
      throw Error("Invalid PCM frame");
    if (channel.ws.bufferedAmount > 64000) {
      this.failed("音频连接积压，采集已停止。", "backlog");
      return;
    }
    channel.ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: encodePCM(bytes),
      }),
    );
    channel.bytes += bytes.length;
    const samples = channel.remainder.concat(
      Array.from(new Int16Array(buffer)),
    );
    let offset = 0;
    for (; offset + 480 <= samples.length; offset += 480) {
      const frame = new Int16Array(160);
      for (let i = 0; i < 160; i++)
        frame[i] = Math.round(
          (samples[offset + i * 3] +
            samples[offset + i * 3 + 1] +
            samples[offset + i * 3 + 2]) /
            3,
        );
      channel.elapsed += 20;
      if (channel.vad.voice(frame)) {
        channel.spoken = true;
        channel.silence = 0;
      } else channel.silence += 20;
    }
    channel.remainder = samples.slice(offset);
    if ((channel.spoken && channel.silence >= 800) || channel.elapsed >= 30000)
      this.commit(channel);
  }
  commit(channel) {
    if (!channel.bytes || channel.closed) return;
    if (channel.bytes < 4800)
      channel.ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: encodePCM(new Uint8Array(4800 - channel.bytes)),
        }),
      );
    this.send({ type: "asr_commit", stream: channel.id });
    channel.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    Object.assign(channel, {
      bytes: 0,
      elapsed: 0,
      silence: 0,
      spoken: false,
      remainder: [],
    });
  }
  control(value) {
    if (["ask", "stop"].includes(value.type)) {
      for (const channel of this.active.values()) this.commit(channel);
    }
    this.send(value);
  }
  failed(detail, reason = "client_error") {
    const channel = [...this.channels.values()].find((c) => !c.closed);
    this.reset();
    if (channel) {
      try {
        this.send({ type: "asr_failed", stream: channel.id, reason });
      } catch {}
    }
    this.fail(detail);
  }
  close(channel) {
    if (!channel || channel.closed) return;
    channel.closed = true;
    clearTimeout(channel.timeout);
    channel.vad.destroy();
    if (this.active.get(channel.role) === channel)
      this.active.delete(channel.role);
    this.channels.delete(channel.id);
    channel.ws.close();
  }
  reset() {
    this.epoch++;
    for (const channel of [...this.channels.values()]) this.close(channel);
  }
}

function encodePCM(bytes) {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192)
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}
export function decodePCM(base64) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer;
}
