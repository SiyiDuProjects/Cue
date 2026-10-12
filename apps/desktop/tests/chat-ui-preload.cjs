const emit = (value) =>
  window.dispatchEvent(new CustomEvent("cue:event", { detail: value }));
const messages = [];
let source = "screen:1";
window.sourceReads = 0;
window.cue = {
  connect: async () =>
    setTimeout(
      () =>
        emit({
          type: "session_ready",
          generation: "test-desktop",
          chats: [{ id: "chat", title: "离线检查" }],
        }),
      50,
    ),
  command: async (v) => {
    if (v.type === "history") window.lastHistory = v;
    if (v.type === "remote_result")
      window.remoteResults = [...(window.remoteResults || []), v];
    if (v.type === "remote_state")
      window.remoteStates = [...(window.remoteStates || []), v];
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
        emit({
          type: "answer_reasoning",
          id: v.id,
          delta: "**读题**：确认重复元素",
        });
        setTimeout(
          () =>
            emit({
              type: "answer_reasoning",
              id: v.id,
              delta: "\n\n**选择**：哈希表",
            }),
          10,
        );
        setTimeout(() => {
          emit({
            type: "answer_delta",
            id: v.id,
            delta:
              "## 解法\n\n使用 **哈希表**。\n\n|输入|输出|\n|---|---|\n|2|4|\n\n\`\`\`python\nprint(2+2)\n\`\`\`\n\n$O(n)$",
          });
        }, 250);
        setTimeout(() => {
          message.answer = "使用哈希表。";
          message.reasoning = "**读题**：确认重复元素\n\n**选择**：哈希表";
          message.status = "completed";
          emit({ type: "answer", message: { ...message } });
        }, 700);
      }, 10);
    }
    if (v.type === "new_chat")
      emit({ type: "chat_created", chat: { id: "new", title: "新聊天" } });
  },
  audio: async (start) =>
    emit({ type: start ? "started" : "stopped", complete: true }),
  screenshot: async () => {
    window.shotCalls = (window.shotCalls || 0) + 1;
    if (window.holdShot) await new Promise((r) => (window.finishShot = r));
    if (window.failShot) throw Error("录屏权限未开启");
    return {
      id: "shot",
      created: Date.now(),
      image_url:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv3cAAAAASUVORK5CYII=",
    };
  },
  uploadScreenshot: async (shot) => {
    if (window.holdUpload)
      await new Promise((r) => {
        window.finishUpload = r;
      });
    if (window.failUpload) throw Error("upload offline");
    return shot;
  },
  request: async () => ({}),
  sources: async () => {
    window.sourceReads++;
    return [
      { id: "screen:0", name: "主显示器" },
      { id: "screen:1", name: "第二显示器" },
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
    window.selectedSource = id;
  },
  importConnection: async () => {},
  resize: async (size) => {
    window.lastSize = size;
  },
  focus: async (on) => {
    window.focusCalls = [...(window.focusCalls || []), on];
  },
  // The native menu: tests set the choice the user would pick.
  menu: async (state) => {
    window.menuState = state;
    const choice = window.nextMenu || null;
    window.nextMenu = null;
    return choice;
  },
  copy: async (text) => {
    window.copied = text;
  },
};
