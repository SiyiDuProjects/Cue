// The computer owns audio, commits and unsaved sentence snapshots. A cloud
// acknowledgement only retires the exact saved revision; reading never consumes it.
const terminal = (status) => status === "final" || status === "failed";
const codeOf = (value) =>
  typeof value === "string" && /^[\w.-]{1,80}$/.test(value) ? value : "unknown";
const later = (fn, ms) => {
  const id = setTimeout(fn, ms);
  id.unref?.();
  return id;
};
// Cancelling one reader must not cancel the channel's shared final boundary.
const observe = (promise, signal) => {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? Error("已取消。"));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
};
export class DirectTranscription {
  constructor({
    send,
    makeVAD,
    fail,
    caption,
    emit = () => {},
    log = () => {},
    WebSocket: Socket = globalThis.WebSocket,
    now = Date.now,
    commitMs = 5000,
    tailMs = 10000,
    rotationMs = 55 * 60000,
  }) {
    Object.assign(this, {
      send,
      makeVAD,
      fail,
      caption,
      emit,
      log,
      Socket,
      now,
      commitMs,
      tailMs,
      rotationMs,
    });
    this.channels = new Map();
    this.active = new Map();
    this.tokens = new Map();
    this.outbox = new Map();
    this.epoch = 0;
    this.phase = "idle";
    this.connected = false;
    this.watchers = new Set();
    this.saveProblem = "";
    this.asking = null;
  }
  record(stage, code = "unknown", extra = {}) {
    this.log({
      event: "transcription_failed",
      stage,
      code: codeOf(code),
      ...extra,
    });
  }
  notify() {
    for (const fn of [...this.watchers]) fn();
  }
  wait(test, detail, ms = this.tailMs, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        this.watchers.delete(check);
        signal?.removeEventListener("abort", cancel);
        error ? reject(error) : resolve();
      };
      const cancel = () =>
        finish(
          signal?.reason instanceof Error && signal.reason.name !== "AbortError"
            ? signal.reason
            : Error("已取消。"),
        );
      const check = () => {
        try {
          if (signal?.aborted) cancel();
          else if (test()) finish();
        } catch (e) {
          finish(e);
        }
      };
      this.watchers.add(check);
      signal?.addEventListener("abort", cancel, { once: true });
      timer = later(() => finish(Error(detail)), ms);
      check();
    });
  }
  handle(event) {
    if (event.type === "session_ready") {
      this.connected = true;
      for (const p of this.outbox.values()) p.next = 0;
      this.tick();
      return false;
    }
    if (["disconnected", "replaced"].includes(event.type)) {
      this.connected = false;
      this.reset();
      return false;
    }
    if (
      event.type === "asr_token" ||
      (event.type === "error" && this.tokens.has(event.id))
    ) {
      const pending = this.tokens.get(event.id);
      if (pending) {
        this.tokens.delete(event.id);
        clearTimeout(pending.timer);
        event.type === "error"
          ? pending.reject(Error(event.detail))
          : pending.resolve(event);
      }
      return true;
    }
    if (event.type === "utterance_saved") {
      const p = this.outbox.get(event.id);
      if (p && p.value.revision === event.revision) {
        this.outbox.delete(event.id);
        p.turn.saved = event.revision;
        if (terminal(p.turn.status)) p.channel.turns.delete(p.turn.item);
      }
      if (!this.outbox.size && this.saveProblem) {
        this.saveProblem = "";
        this.emit({ type: "transcription_save", detail: "" });
      }
      this.notify();
      return true;
    }
    if (event.type === "utterance_failed") {
      const p = this.outbox.get(event.id);
      if (!p || p.value.revision !== event.revision) return true;
      this.record("persistence", event.code);
      if (event.code === "not_owner" || event.code === "invalid") {
        p.error = event.detail || "转录保存被拒绝。";
        this.failed(p.error, event.code);
      } else {
        this.saveProblem = "转录暂未保存，正在重试。";
        this.emit({ type: "transcription_save", detail: this.saveProblem });
      }
      this.notify();
      return true;
    }
    return false;
  }
  ensureTimer() {
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 500);
      this.timer.unref?.();
    }
  }
  tick() {
    const now = this.now();
    for (const c of this.channels.values()) {
      for (const t of c.turns.values())
        if (t.dirty && now - t.published >= 1000) this.publish(c, t);
      if (c.ws.bufferedAmount > 64000) {
        c.backlog ??= now;
        if (now - c.backlog >= 10000) {
          this.failed("音频连接持续积压超过 10 秒，转录已停止。", "backlog");
          break;
        }
      } else c.backlog = null;
      if (
        this.phase === "active" &&
        !this.asking &&
        this.active.get(c.role) === c &&
        now - c.opened >= this.rotationMs &&
        !c.rotating
      ) {
        c.rotating = true;
        void this.rotate(c).catch((e) => this.failed(e.message, "rotation"));
      }
    }
    if (this.connected)
      for (const p of this.outbox.values())
        if (!p.error && p.next <= now) {
          p.next = now + Math.min(30000, 3000 * 2 ** Math.min(p.attempt++, 4));
          this.transmit(p.value).catch(() => {
            /* The snapshot remains until acknowledged. */
          });
          if (p.attempt > 1 && !this.saveProblem) {
            this.saveProblem = "转录暂未保存，正在重试。";
            this.emit({ type: "transcription_save", detail: this.saveProblem });
          }
        }
    if (!this.channels.size && !this.outbox.size) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  transmit(value) {
    try {
      if (!this.connected) throw Error("与云端连接已断开。");
      return Promise.resolve(this.send(value));
    } catch (e) {
      return Promise.reject(e);
    }
  }
  async token(role, epoch) {
    const id = crypto.randomUUID();
    const pending = new Promise((resolve, reject) => {
      const timer = later(() => {
        this.tokens.delete(id);
        reject(Error("签发语音凭证超时。"));
      }, 15000);
      this.tokens.set(id, { resolve, reject, timer });
      this.transmit({ type: "asr_token", id, role }).catch((e) => {
        clearTimeout(timer);
        this.tokens.delete(id);
        reject(e);
      });
    });
    const config = await pending;
    if (epoch !== this.epoch) throw Error("启动已取消。");
    return { ...config, stream: crypto.randomUUID() };
  }
  async start() {
    if (this.phase !== "idle" || !this.connected)
      throw Error("连接未就绪或转录已开启。");
    this.phase = "starting";
    const epoch = ++this.epoch;
    try {
      await Promise.all(
        ["interviewer", "candidate"].map(async (role) => {
          const config = await this.token(role, epoch);
          const channel = await this.open(config, epoch);
          if (epoch !== this.epoch) throw Error("启动已取消。");
          this.active.set(role, channel);
        }),
      );
      if (epoch !== this.epoch) throw Error("启动已取消。");
      this.phase = "active";
      this.emit({ type: "started" });
      this.ensureTimer();
    } catch (e) {
      if (epoch === this.epoch) this.reset();
      throw e;
    }
  }
  async open(config, epoch = this.epoch) {
    if (
      !["interviewer", "candidate"].includes(config.role) ||
      typeof config.token !== "string" ||
      !config.token.startsWith("ek_")
    )
      throw Error("语音凭证无效。");
    const vad = await this.makeVAD();
    if (epoch !== this.epoch) {
      vad.destroy();
      throw Error("启动已取消。");
    }
    const ws = new this.Socket(
      "wss://api.openai.com/v1/realtime?intent=transcription",
      ["realtime", "openai-insecure-api-key." + config.token],
    );
    const c = {
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
      ordinal: 0,
      pending: null,
      requested: false,
      turns: new Map(),
      finished: new Set(),
      failures: [],
      held: [],
      holding: false,
      opened: this.now(),
    };
    this.channels.set(c.id, c);
    this.ensureTimer();
    ws.addEventListener("open", () => {
      if (!c.closed)
        ws.send(
          JSON.stringify({ type: "session.update", session: config.session }),
        );
    });
    ws.addEventListener("message", ({ data }) => {
      if (c.closed) return;
      let e;
      try {
        e = JSON.parse(data);
      } catch {
        this.record("event_parse", "invalid_json");
        return;
      }
      try {
        this.event(c, e);
      } catch (error) {
        this.record("event", "invalid_state");
        this.failed(error.message, "invalid_state");
      }
    });
    ws.addEventListener("close", (e) => {
      if (!c.closed)
        this.failed(`语音连接已断开（${e.code ?? 0}）。`, "openai_closed", {
          close_code: e.code ?? 0,
        });
    });
    ws.addEventListener("error", () => {
      if (!c.closed) this.failed("语音连接发生网络错误。", "openai_network");
    });
    await this.wait(
      () => {
        if (c.closed) throw Error("语音连接已关闭。");
        return c.ready;
      },
      "语音连接超时。",
      10000,
    );
    return c;
  }
  event(c, e) {
    if (e.type === "session.updated") {
      c.ready = true;
      this.notify();
      return;
    }
    if (e.type === "error") {
      const code = codeOf(e.error?.code || e.error?.type),
        id = e.error?.event_id;
      this.record("openai", code, {
        error_type: codeOf(e.error?.type),
        event_id: typeof id === "string" ? id.slice(0, 100) : undefined,
      });
      if (c.pending && id === c.pending.id) {
        clearTimeout(c.pending.timer);
        const pending = c.pending;
        c.pending = null;
        // A rejected nonempty commit is not a successful boundary. Keep the
        // failure in the boundary snapshot even though no item_id was issued.
        const error = /commit_empty|buffer_empty/.test(code)
          ? null
          : Error(`音频提交失败（${code}）。`);
        if (error) {
          c.failures.push(error);
          this.emit({ type: "error", detail: error.message });
        }
        pending.error = error;
        pending.done = true;
        this.notify();
        if (c.requested && !c.holding) this.commit(c);
      } else if (!c.ready) this.failed(`语音配置被拒绝（${code}）。`, code);
      else
        this.emit({ type: "error", detail: `语音服务报告错误（${code}）。` });
      return;
    }
    if (e.type === "input_audio_buffer.committed") {
      if (!c.pending || typeof e.item_id !== "string")
        throw Error("语音提交确认无法对应，转录已停止。");
      const p = c.pending;
      clearTimeout(p.timer);
      c.pending = null;
      const t = this.turn(c, e.item_id);
      t.ordinal = ++c.ordinal;
      p.done = true;
      p.turn = t;
      // Persist the empty partial too: it fixes one server-owned time for all revisions.
      this.publish(c, t);
      this.notify();
      if (c.requested && !c.holding) this.commit(c);
      return;
    }
    if (
      !/^conversation\.item\.input_audio_transcription\.(delta|full|completed|failed)$/.test(
        e.type,
      )
    )
      return;
    if (typeof e.item_id !== "string") throw Error("转录缺少句子标识。");
    if (c.finished.has(e.item_id)) return;
    const t = this.turn(c, e.item_id);
    if (e.type.endsWith(".failed")) {
      t.status = "failed";
      t.reason = codeOf(e.error?.code || e.error?.type);
    } else {
      t.text =
        typeof e.transcript === "string"
          ? e.transcript
          : e.type.endsWith(".delta")
            ? t.text + (e.delta ?? "")
            : (e.text ?? t.text);
      if (e.type.endsWith(".completed")) t.status = "final";
    }
    if (t.text.length > 40000) throw Error("单句转录过长。");
    try {
      this.caption?.({ role: c.role, item: t.id, text: t.text });
    } catch {
      this.record("caption", "display_failed");
    }
    if (terminal(t.status)) c.finished.add(t.item);
    t.dirty = true;
    if (t.ordinal && (terminal(t.status) || this.now() - t.published >= 1000))
      this.publish(c, t);
    this.notify();
  }
  turn(c, item) {
    if (!c.turns.has(item))
      c.turns.set(item, {
        id: c.id + "_" + item,
        item,
        revision: 0,
        ordinal: null,
        text: "",
        status: "partial",
        saved: 0,
        published: 0,
        dirty: false,
      });
    return c.turns.get(item);
  }
  publish(c, t) {
    if (!t.ordinal) return;
    t.revision++;
    t.published = this.now();
    t.dirty = false;
    const value = {
      type: "utterance",
      id: t.id,
      role: c.role,
      revision: t.revision,
      ordinal: t.ordinal,
      text: t.text,
      status: t.status,
    };
    const previous = this.outbox.get(t.id);
    this.outbox.set(t.id, {
      value,
      turn: t,
      channel: c,
      attempt: previous?.attempt ?? 0,
      next: previous?.attempt > 1 ? previous.next : 0,
    });
    this.ensureTimer();
    this.tick();
  }
  pcm(role, buffer) {
    const c = this.active.get(role);
    if (!c?.ready || c.closed) throw Error("语音连接未就绪。");
    if (c.holding) {
      c.held.push(buffer.slice(0));
      return;
    }
    this.append(c, buffer);
  }
  append(c, buffer) {
    const bytes = new Uint8Array(buffer);
    if (!bytes.length || bytes.length > 24000 || bytes.length % 2)
      throw Error("音频帧无效。");
    c.ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: encodePCM(bytes),
        event_id: crypto.randomUUID(),
      }),
    );
    c.bytes += bytes.length;
    const samples = c.remainder.concat(Array.from(new Int16Array(buffer)));
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
      c.elapsed += 20;
      if (c.vad.voice(frame)) {
        c.spoken = true;
        c.silence = 0;
      } else c.silence += 20;
    }
    c.remainder = samples.slice(offset);
    if ((c.spoken && c.silence >= 800) || c.elapsed >= 30000) this.commit(c);
  }
  commit(c) {
    if (c.closed || !c.bytes) return null;
    if (c.pending) {
      c.requested = true;
      return c.pending;
    }
    if (c.bytes < 4800)
      c.ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: encodePCM(new Uint8Array(4800 - c.bytes)),
        }),
      );
    const p = { id: crypto.randomUUID(), done: false, error: null };
    c.pending = p;
    p.timer = later(() => {
      if (c.pending === p) {
        p.error = Error("语音提交在 5 秒内未获确认，转录已停止。");
        c.failures.push(p.error);
        this.failed(p.error.message, "commit_timeout");
      }
    }, this.commitMs);
    c.ws.send(
      JSON.stringify({ type: "input_audio_buffer.commit", event_id: p.id }),
    );
    Object.assign(c, {
      bytes: 0,
      elapsed: 0,
      silence: 0,
      spoken: false,
      remainder: [],
      requested: false,
    });
    return p;
  }
  // Freeze PCM before the first await. Later frames wait only until the cutoff
  // commit is sent, not until transcription/database acknowledgements arrive.
  async boundary(channels, signal) {
    for (const c of channels) if (!c.retirement) c.holding = true;
    const cuts = {};
    const snapshots = await Promise.all(
      channels.map(async (c) => {
        if (c.retirement) {
          const result = await observe(c.retirement, signal);
          Object.assign(cuts, result.cut);
          return result.records;
        }
        const records = [...c.turns.values()],
          previous = c.pending;
        try {
          if (previous)
            await this.wait(
              () => {
                if (c.closed) throw Error("语音连接已断开。");
                return previous.done;
              },
              "最后一次音频提交未确认。",
              this.commitMs + 100,
              signal,
            );
          const p = this.commit(c),
            frozenOrdinal = c.ordinal;
          // commit is now ordered before any post-boundary append.
          c.holding = false;
          const held = c.held.splice(0);
          for (const frame of held) this.append(c, frame);
          if (p)
            await this.wait(
              () => {
                if (c.closed) throw Error("语音连接已断开。");
                return p.done;
              },
              "最后一次音频提交未确认。",
              this.commitMs + 100,
              signal,
            );
          cuts[c.id] =
            p?.turn?.ordinal ?? previous?.turn?.ordinal ?? frozenOrdinal;
          const error = previous?.error || p?.error || c.failures[0];
          if (error) throw error;
          for (const t of [previous?.turn, p?.turn])
            if (t && !records.includes(t)) records.push(t);
          return records;
        } finally {
          c.holding = false;
          if (!c.closed) {
            const held = c.held.splice(0);
            for (const frame of held) this.append(c, frame);
          }
        }
      }),
    );
    return { cut: cuts, records: snapshots.flat() };
  }
  async saved(records, signal) {
    await this.wait(
      () => {
        if (!this.connected) throw Error("与云端连接已断开。");
        const failed = records.find((t) => t.status === "failed");
        if (failed)
          throw Error(`该段转写失败（${failed.reason || "unknown"}）。`);
        return records.every((t) => terminal(t.status));
      },
      "最后一句尚未定稿。",
      this.tailMs,
      signal,
    );
    await this.wait(
      () => {
        if (!this.connected) throw Error("与云端连接已断开。");
        const rejected = records
          .map((t) => this.outbox.get(t.id))
          .find((p) => p?.error);
        if (rejected) throw Error(rejected.error);
        return records.every((t) => t.saved === t.revision);
      },
      "最后一句尚未保存，正在重试。",
      this.tailMs,
      signal,
    );
  }
  async control(value) {
    if (value.type === "start") return this.start();
    if (value.type === "stop") return this.stop();
    if (value.type === "cancel") {
      this.asking?.abort();
      return this.transmit(value);
    }
    if (value.type !== "ask") return this.transmit(value);
    if (this.asking) throw Error("正在准备上一轮回答。");
    const abort = new AbortController();
    this.asking = abort;
    try {
      const channels = [...this.channels.values()].filter((c) => !c.closed);
      const retained = [...this.outbox.values()].map((p) => p.turn);
      const { cut, records } = await this.boundary(channels, abort.signal);
      for (const t of retained) if (!records.includes(t)) records.push(t);
      await this.saved(records, abort.signal);
      abort.signal.throwIfAborted();
      await this.transmit({ ...value, cut });
    } catch (error) {
      abort.abort();
      throw error;
    } finally {
      if (this.asking === abort) this.asking = null;
      this.notify();
    }
  }
  retire(channel, signal) {
    // An upstream has exactly one final boundary. Stop, handover and an
    // overlapping answer must all observe the same submitted tail.
    channel.retirement ??= this.boundary([channel], signal);
    return channel.retirement;
  }
  stop() {
    if (this.phase === "idle" && !this.channels.size) return;
    this.asking?.abort();
    ++this.epoch;
    this.phase = "idle";
    this.active.clear();
    for (const p of this.tokens.values()) {
      clearTimeout(p.timer);
      p.reject(Error("启动已取消。"));
    }
    this.tokens.clear();
    const channels = [...this.channels.values()].filter((c) => !c.closed);
    // Media has already stopped in the host. Finishing upstream text is a
    // separate bounded operation; pending saves survive channel closure.
    // The media host already published stopped; a delayed second stop could
    // cancel a new recording while this old tail is still being completed.
    const abort = new AbortController(),
      timer = later(
        () => abort.abort(Error("尾句收尾超时，未保存内容仍会重试。")),
        this.tailMs,
      );
    const boundaries = channels.map((c) => this.retire(c, abort.signal));
    void (async () => {
      try {
        const records = (await Promise.all(boundaries)).flatMap(
          (value) => value.records,
        );
        await this.saved(records, abort.signal);
        this.emit({ type: "transcription_tail", detail: "" });
      } catch (e) {
        this.record("tail", "incomplete");
        this.emit({ type: "transcription_tail", detail: e.message });
      } finally {
        clearTimeout(timer);
        for (const c of channels) this.close(c);
      }
    })();
  }
  async rotate(old) {
    const epoch = this.epoch,
      config = await this.token(old.role, epoch),
      next = await this.open(config, epoch);
    if (this.phase !== "active" || epoch !== this.epoch) {
      this.close(next);
      return;
    }
    if (this.asking) {
      this.close(next);
      old.rotating = false;
      return;
    }
    this.retire(old);
    this.active.set(old.role, next);
    try {
      const { records } = await old.retirement;
      await this.saved(records);
    } catch (e) {
      this.record("rotation_tail", "incomplete");
      this.emit({ type: "transcription_tail", detail: e.message });
    } finally {
      this.close(old);
    }
  }
  failed(detail, code, extra = {}) {
    this.asking?.abort(Error(detail));
    this.record("connection", code, extra);
    this.reset();
    this.fail(detail);
  }
  close(c) {
    if (!c || c.closed) return;
    c.closed = true;
    clearTimeout(c.pending?.timer);
    this.channels.delete(c.id);
    if (this.active.get(c.role) === c) this.active.delete(c.role);
    for (const t of c.turns.values())
      if (!terminal(t.status)) {
        t.status = "failed";
        t.reason = "connection_closed";
        this.publish(c, t);
      }
    c.vad.destroy();
    if (this.active.get(c.role) === c) this.active.delete(c.role);
    this.channels.delete(c.id);
    c.ws.close();
    this.notify();
  }
  reset() {
    ++this.epoch;
    this.phase = "idle";
    this.asking?.abort();
    for (const pending of this.tokens.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error("启动已取消。"));
    }
    this.tokens.clear();
    for (const c of [...this.channels.values()]) this.close(c);
    this.active.clear();
    this.notify();
  }
}
function encodePCM(bytes) {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 8192)
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(raw);
}
export function decodePCM(base64) {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)).buffer;
}
