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
};
window.webkit = { messageHandlers: { cue: {} } };
window.directControls = [];
window.directSockets = [];
const originalCommand = window.cue.command;
window.cue.command = async (value) => {
  if (value.type === "asr_forward") window.directControls.push(value.message);
  else await originalCommand(value);
};
window.WebSocket = class extends EventTarget {
  constructor(url, protocols) {
    super();
    this.url = url;
    this.protocols = protocols;
    this.sent = [];
    this.bufferedAmount = 0;
    window.directSockets.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(raw) {
    const value = JSON.parse(raw);
    this.sent.push(value);
    if (value.type === "session.update")
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({ type: "session.updated" }),
          }),
        ),
      );
  }
  close() {
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
};
