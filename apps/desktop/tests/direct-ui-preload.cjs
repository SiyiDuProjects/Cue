window.cue = {
  command: async () => {},
  connect: async () =>
    setTimeout(
      () =>
        window.cueReceive({
          type: "session_ready",
          chats: [],
          turns: [],
          images: [],
        }),
      50,
    ),
  audio: async () => {},
  caption: async (value) => window.captions.push(value),
};
window.captions = [];
window.webkit = { messageHandlers: { cue: {} } };
window.directControls = [];
window.directSockets = [];
window.directStates = [];
window.cue.command = async (value) => {
  if (value.type === "asr_forward") {
    const v = value.message;
    window.directControls.push(v);
    if (v.type === "asr_token")
      queueMicrotask(() =>
        window.cueReceive({
          ...v,
          token: "ek_synthetic",
          session: { type: "transcription", tag: v.role },
        }),
      );
    if (v.type === "utterance")
      queueMicrotask(() =>
        window.cueReceive({
          type: "utterance_saved",
          id: v.id,
          revision: v.revision,
        }),
      );
  } else if (value.type === "transcription_state")
    window.directStates.push(value.event);
};
window.WebSocket = class extends EventTarget {
  constructor(url, protocols) {
    super();
    Object.assign(this, { url, protocols, sent: [], bufferedAmount: 0, n: 0 });
    window.directSockets.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  receive(v) {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(v) }),
    );
  }
  send(raw) {
    const v = JSON.parse(raw);
    this.sent.push(v);
    if (v.type === "session.update")
      queueMicrotask(() => this.receive({ type: "session.updated" }));
    if (v.type === "input_audio_buffer.commit")
      queueMicrotask(() => {
        const id = "item" + ++this.n;
        this.receive({ type: "input_audio_buffer.committed", item_id: id });
        this.receive({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: id,
          transcript: "synthetic",
        });
      });
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
};
