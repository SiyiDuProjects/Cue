const emit = (value) =>
  window.dispatchEvent(new CustomEvent("cue:event", { detail: value }));
const messages = [];
let source = "frontmost";
window.sourceReads = 0;
window.cue = {
  connect: async () =>
    setTimeout(
      () =>
        emit({
          type: "session_ready",
          recording: "test",
          chats: [{ id: "chat", title: "离线检查" }],
          turns: [],
          images: [],
        }),
      50,
    ),
  command: async (v) => {
    if (v.type === "history")
      setTimeout(() => emit({ type: "history", chat: v.chat, messages }), 0);
    if (v.type === "ask") {
      window.lastAsk = v;
      const message = {
        id: v.id,
        chat: v.chat,
        text: v.text,
        answer: "",
        status: "running",
        detail: "",
        context: JSON.stringify({ images: v.images }),
      };
      messages.push(message);
      setTimeout(() => {
        emit({ type: "answer", message: { ...message } });
        setTimeout(() => {
          emit({
            type: "answer_delta",
            id: v.id,
            delta:
              "## 解法\n\n使用 **哈希表**。\n\n|输入|输出|\n|---|---|\n|2|4|\n\n\`\`\`python\nprint(2+2)\n\`\`\`\n\n$O(n)$",
          });
        }, 30);
        setTimeout(() => {
          message.answer = "使用哈希表。";
          message.status = "completed";
          emit({ type: "answer", message: { ...message } });
        }, 500);
      }, 10);
    }
    if (v.type === "new_chat")
      emit({ type: "chat_created", chat: { id: "new", title: "新聊天" } });
  },
  audio: async (start) =>
    emit({ type: start ? "started" : "stopped", complete: true }),
  screenshot: async () => ({
    id: "shot",
    created: Date.now(),
    image_url:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv3cAAAAASUVORK5CYII=",
  }),
  request: async () => ({}),
  sources: async () => {
    window.sourceReads++;
    return [
      { id: "screen:0", name: "主显示器" },
      { id: "frontmost", name: "App Shot · 最近应用" },
      {
        id: "unavailable",
        name: "录屏权限未开启",
        disabled: true,
        permission: "screen",
      },
    ].map((v) => ({ ...v, selected: v.id === source }));
  },
  openPrivacy: async () => {
    window.privacyOpened = (window.privacyOpened || 0) + 1;
  },
  selectSource: async (id) => {
    if (window.rejectSource) throw Error("来源已关闭");
    source = id;
  },
  uploadMaterials: async () => {},
  importConnection: async () => {},
  pin: async () => {},
  copy: async (text) => {
    window.copied = text;
  },
};
