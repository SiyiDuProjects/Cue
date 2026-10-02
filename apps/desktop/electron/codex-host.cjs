const { CodexProcess } = require("./codex-process.cjs");
const { runtimeOptions } = require("./codex-runtime.cjs");
const { Materials } = require("./materials.cjs");

class CodexHost {
  constructor({ apiBaseUrl, interviewId, captureToken, packaged, dataRoot, runtimeContext },
    { WebSocketClass = WebSocket, makeProcess = options => new CodexProcess(options.runtime, options),
      getOptions = runtimeOptions } = {}) {
    const url = new URL(`/ws/interviews/${encodeURIComponent(interviewId)}/model`, apiBaseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    this.url = url.href;
    this.interviewId = interviewId;
    this.token = captureToken;
    this.makeProcess = makeProcess;
    // The app passes the same resolved context to every host and the login menu.
    this.getOptions = runtimeContext ? (id = interviewId) => runtimeContext.options(id)
      : (id = interviewId) => getOptions({ packaged, dataRoot, conversationId: id });
    this.getMaterials = () => {
      if (!runtimeContext) throw new Error("面试资料目录尚未初始化。");
      return new Materials(runtimeContext.workspace);
    };
    this.WebSocketClass = WebSocketClass;
    this.seen = new Set();
    this.closed = false;
    this.retry = 0;
    this.connect();
  }

  send(value) {
    if (!this.socket || this.socket.readyState !== 1) throw new Error("电脑回答连接已断开。");
    if (this.socket.bufferedAmount > 4 * 1024 * 1024) {
      this.socket.close(1013); throw new Error("电脑回答连接积压，已停止生成。");
    }
    this.socket.send(JSON.stringify(value));
  }

  connect() {
    if (this.closed) return;
    const socket = new this.WebSocketClass(this.url);
    this.socket = socket;
    const authTimer = setTimeout(() => socket.close(), 10000);
    let heartbeat, awaitingReply = false;
    socket.addEventListener("open", () => {
      this.send({ type: "authenticate", token: this.token });
    });
    socket.addEventListener("message", ({ data }) => {
      if (this.socket !== socket) return;
      awaitingReply = false;
      try {
        if (typeof data !== "string" || data.length > 64 * 1024 * 1024) throw new Error("Invalid host frame");
        const message = JSON.parse(data);
        if (message.type === "codex_ready") {
          if (message.realtime_protocol !== "interview-chat-v12") { socket.close(1008); return; }
          clearTimeout(authTimer); this.retry = 0;
          clearInterval(heartbeat);
          heartbeat = setInterval(() => {
            if (awaitingReply) { socket.close(4000, 'model heartbeat timed out'); return; }
            try { this.send({ type: 'ping' }); awaitingReply = true; }
            catch { socket.close(4000); }
          }, 10000);
          heartbeat.unref?.();
        }
        else void this.message(message).catch(() => socket.close(1011));
      } catch { socket.close(1008); }
    });
    socket.addEventListener("error", () => {});
    socket.addEventListener("close", ({ code }) => {
      clearTimeout(authTimer);
      clearInterval(heartbeat);
      if (this.socket !== socket) return;
      this.socket = null;
      // Never continue spending silently after losing the authoritative server.
      void Promise.resolve(this.process?.cancel()).finally(() => {
        if (!this.closed && code !== 1008) {
          this.timer = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.retry++, 15000));
        }
      });
    });
  }

  async message(message) {
    const id = message.request_id;
    if (message.type === "codex_close") return this.close();
    if (message.type === "materials_request") {
      try {
        const result = await this.getMaterials().call(message.action, message.arguments);
        this.send({ type: "materials_result", request_id: id, result });
      } catch {
        this.send({ type: "materials_result", request_id: id, error: "无法读取该资料。请检查文件路径、版本和 UTF-8 文本格式；资料已更新时请从头读取。" });
      }
      return;
    }
    if (message.type === "codex_cancel") {
      const ok = await this.process?.cancel(id) ?? true;
      this.send({ type: "codex_cancelled", request_id: id, ok });
    } else if (message.type === "codex_request") {
      if (typeof id !== "string" || this.seen.has(id)) {
        // A reconnect must not submit the same input twice.
        this.send({ type: "codex_event", request_id: id, kind: "error", detail: "重复请求未再次执行。" });
        return;
      }
      this.seen.add(id);
      try {
        const conversationId = message.conversation_id || this.interviewId;
        if (this.process && this.processConversation !== conversationId) {
          await this.process.cancel();
          await this.process.dispose();
          this.process = null;
        }
        if (!this.process) {
          const runtime = this.getOptions(conversationId);
          this.process = this.makeProcess({ runtime, emit: event => this.send({ type: "codex_event", ...event }) });
          this.processConversation = conversationId;
        }
        await this.process.run(message);
      } catch (error) {
        this.send({ type: "codex_event", request_id: id, kind: "error", detail: error.message });
      }
    }
  }

  close() {
    if (this.closed) return this.closing;
    this.closed = true;
    clearTimeout(this.timer);
    const process = this.process;
    this.closing = Promise.resolve(process?.cancel()).finally(() => process?.dispose());
    this.socket?.close(1000);
    return this.closing;
  }
}

module.exports = { CodexHost };
