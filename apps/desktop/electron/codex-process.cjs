const { spawn } = require("node:child_process");
const { configArguments, CONFIG } = require("./codex-runtime.cjs");
const { activityFor } = require("./codex-activity.cjs");

class CodexProcess {
  constructor(options, { spawnProcess = spawn, emit } = {}) {
    this.options = options;
    this.spawnProcess = spawnProcess;
    this.emit = emit;
    this.pending = new Map();
    this.nextId = 0;
    this.threadId = null;
    this.current = null;
    this.poisoned = false;
  }

  async rpc(method, params, timeout = 20000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} 超时；未自动重发。`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  write(message) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) throw new Error("Codex 进程已断开。");
    if (this.child.stdin.writableLength > 24 * 1024 * 1024) throw new Error("Codex 输入队列已满。");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  async start() {
    if (this.child) return;
    const { binary, workspace, env } = this.options;
    this.child = this.spawnProcess(binary, [...configArguments(), "app-server", "--listen", "stdio://"],
      { cwd: workspace, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, shell: false });
    // stderr can contain personal/provider details; drain it without logging.
    this.child.stderr.on("data", () => {});
    this.child.on("error", () => this.fail(new Error("无法启动 Codex CLI，请检查可执行文件和权限。")));
    this.child.on("exit", () => this.fail(new Error("Codex 进程退出，未自动重发请求。请开启新对话。")));
    this.child.stdin.on("error", () => this.fail(new Error("Codex 输入连接断开。")));
    this.child.stdout.setEncoding("utf8");
    let buffer = "";
    this.child.stdout.on("data", data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 12 * 1024 * 1024) return this.fail(new Error("Codex 输出超过单条上限。"));
      let split;
      while ((split = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        if (!line.trim()) continue;
        try { this.message(JSON.parse(line)); }
        catch { this.fail(new Error("Codex 返回了无效协议消息。")); return; }
      }
    });
    await this.rpc("initialize", { clientInfo: { name: "sage_interview", version: require("../package.json").version },
      capabilities: { experimentalApi: true } });
    this.write({ method: "initialized" });
    const auth = await this.rpc("account/read", { refreshToken: false });
    if (auth.requiresOpenaiAuth && !auth.account) {
      throw new Error("面试专用 Codex 尚未登录。请从桌面托盘选择「Codex 登录」，或在项目中执行 node scripts/interview-codex.cjs login。登录后重新发送；现有对话不会丢失。");
    }
  }

  event(kind, fields = {}) {
    if (!this.current) return;
    try { this.emit({ request_id: this.current.id, kind, ...fields }); }
    catch { void this.cancel(); }
  }

  started(turnId) {
    if (!this.current || this.current.turnId) return;
    this.current.turnId = turnId;
    this.event("started", { thread_id: this.threadId, turn_id: turnId });
  }

  message(message) {
    if (!message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "Codex 请求失败。"));
      else pending.resolve(message.result);
      return;
    }
    const p = message.params || {};
    const current = this.current;
    if (message.id !== undefined) {
      // Read-only native tools support the answer. No application
      // publication tool or interactive approval loop is registered.
      this.write({ id: message.id, error: { code: -32601,
        message: "Application tools and interactive approvals are unavailable." } });
      return;
    }
    if (!current || p.threadId !== this.threadId) return;
    if (message.method === "turn/started") this.started(p.turn.id);
    if (!current.turnId || (p.turnId && p.turnId !== current.turnId) ||
        (p.turn?.id && p.turn.id !== current.turnId)) return;
    if (message.method === "turn/completed") {
      if (!current.finishing) { current.finishing = true; void this.completeTurn(current, p.turn); }
    } else if (!current.cancelled && message.method === "item/agentMessage/delta") {
      this.event("delta", { item_id: p.itemId, text: p.delta });
    } else if (!current.cancelled && message.method === "item/completed" && p.item?.type === "agentMessage") {
      this.event("text_done", { item_id: p.item.id, text: p.item.text });
    } else if (!current.cancelled && ["item/started", "item/completed"].includes(message.method)) {
      const activity = activityFor(p.item, message.method === "item/completed");
      if (activity) this.event("activity", { activity });
    }
  }

  async completeTurn(current, turn) {
    try {
      if (!current.cancelled) {
        if (turn.status === "completed") this.event("completed");
        else if (turn.status === "interrupted") this.event("cancelled");
        else this.event("error", { detail: turn.error?.message || "Codex 回答失败。" });
      }
    } finally {
      current.finish(); if (this.current === current) this.current = null;
    }
  }

  async run(request) {
    if (this.poisoned) throw new Error("Codex 上次执行结果不确定，请开启新对话。不会自动重发。");
    if (this.current) throw new Error("Codex 仍在处理上一条请求，请先停止。");
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const current = { id: request.request_id, turnId: null, cancelled: false, done, finish };
    this.current = current;
    let submitted = false;
    try {
      await this.start();
      if (current.cancelled) return;
      if (request.expected_thread_id && !this.threadId) {
        // Resume native history; removed legacy application tools are rejected.
        // Never fall back to creating a blank thread when that history is missing.
        const result = await this.rpc("thread/resume", {
          threadId: request.expected_thread_id, cwd: this.options.workspace, model: request.model,
          sandbox: "read-only", approvalPolicy: "never", config: CONFIG, excludeTurns: true,
          baseInstructions: this.options.instructions, developerInstructions: "",
        });
        if (result.thread.id !== request.expected_thread_id || result.thread.status?.type === "active") {
          throw new Error("原 Codex 线程仍忙碌或身份不匹配，未提交新消息。");
        }
        this.threadId = result.thread.id;
      }
      if (request.expected_thread_id && request.expected_thread_id !== this.threadId) {
        throw new Error("Codex 线程与当前会话不匹配，未提交新消息。");
      }
      if (!this.threadId) {
        const result = await this.rpc("thread/start", { cwd: this.options.workspace,
          model: request.model, allowProviderModelFallback: false,
          baseInstructions: this.options.instructions, developerInstructions: "", config: CONFIG,
          sandbox: "read-only", approvalPolicy: "never", selectedCapabilityRoots: [], dynamicTools: [] });
        this.threadId = result.thread.id;
      }
      if (current.cancelled) return;
      const input = request.input.flatMap(m => m.content.map(c => c.type === "input_image"
        ? { type: "image", url: c.image_url } : { type: "text", text: m.role === "assistant" ? "Earlier assistant response (reference only):\n" + c.text : c.text }));
      submitted = true;
      const result = await this.rpc("turn/start", { threadId: this.threadId, input, model: request.model,
        sandboxPolicy: { type: "readOnly" },
        effort: request.effort, clientUserMessageId: current.id });
      if (this.current === current) this.started(result.turn.id);
    } catch (error) {
      if (submitted) this.poisoned = true;
      if (!current.cancelled) this.event("error", { detail: error.message });
      current.finish();
      if (this.current === current) this.current = null;
      // Auth/initialization errors may be corrected outside this process.
      if (!this.threadId) this.dispose();
    } finally {
      if (current.cancelled && !current.turnId) { current.finish(); if (this.current === current) this.current = null; }
    }
  }

  async cancel(id) {
    const current = this.current;
    if (!current) return !this.poisoned;
    if (id && current.id !== id) return true;
    current.cancelled = true;
    try {
      if (!current.turnId) {
        // A still-unacknowledged turn/start must never later become a live turn.
        this.poisoned = true; this.dispose(); return false;
      }
      await this.rpc("turn/interrupt", { threadId: this.threadId, turnId: current.turnId }, 5000);
      await Promise.race([current.done, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Stop unconfirmed")), 5000);
        current.done.finally(() => clearTimeout(timer));
      })]);
      return true;
    } catch { this.poisoned = true; this.dispose(); return false; }
  }

  fail(error) {
    this.poisoned = true;
    if (this.current && !this.current.cancelled) this.event("error", { detail: error.message });
    this.dispose();
  }

  dispose() {
    const child = this.child; this.child = null;
    if (this.current) { this.current.cancelled = true; this.current.finish(); this.current = null; }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); pending.reject(new Error("Codex 连接已关闭。"));
    }
    this.pending.clear();
    if (child && !child.killed) { child.removeAllListeners("exit"); child.kill(); }
  }
}

module.exports = { CodexProcess };
