import { MockAudio } from "./mockAudio";
import {
  getCaptureLabel,
  startLocalAudioCapture,
  type AudioCaptureHandle,
  type CaptureHealth,
} from "./audioCapture";
import { buildInterviewSocketUrl, safeSocketSend, monitorSocket, REALTIME_PROTOCOL, INCOMPATIBLE_SERVER } from "./sessionClient";
import type { ChannelState, InterviewSession, ServerEvent, Speaker } from "./types";

interface CaptureAdapterCallbacks {
  onChannelChange: (speaker: Speaker, state: ChannelState) => void;
  onError: (message: string) => void;
  onMediaEnded: (speaker: Speaker) => void;
  onSessionEnded: () => void;
  onPrepareCapture?: (mode: "assist" | "mock") => void;
  onBrowserConnectionRequest?: (request: { request_id: string; name: string; read_only?: boolean } | null) => void;
}

const SPEAKERS: Speaker[] = ["interviewer", "candidate"];
const READY_TIMEOUT_MS = 10_000;
const SCREEN_UPLOAD_TIMEOUT_MS = 10_000;
const SCREEN_REQUEST_TIMEOUT_MS = 14_000;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000];
// PCM16 mono at 24 kHz: permit at most half a second of queued audio.
const MAX_BUFFERED_AUDIO_BYTES = 24_000;

export class CaptureAdapter {
  private readonly handles: Partial<Record<Speaker, AudioCaptureHandle>> = {};
  private readonly sockets: Partial<Record<Speaker, WebSocket>> = {};
  private readonly ready: Record<Speaker, boolean> = { interviewer: false, candidate: false };
  private readonly sending: Record<Speaker, boolean> = { interviewer: false, candidate: false };
  private readonly mediaVersions: Record<Speaker, number> = { interviewer: 0, candidate: 0 };
  private readonly mediaHealth: Record<Speaker, CaptureHealth> = {
    interviewer: { phase: "interrupted", detail: "系统音频尚未初始化。" },
    candidate: { phase: "interrupted", detail: "麦克风尚未初始化。" },
  };
  private readonly transportHealth: Partial<Record<Speaker, CaptureHealth>> = {};
  private readonly reportedHealth: Partial<Record<Speaker, string>> = {};
  private readonly reconnectTimers: Partial<Record<Speaker, number>> = {};
  private readonly reconnectAttempts: Record<Speaker, number> = { interviewer: 0, candidate: 0 };
  private readonly uploads = new Map<string, AbortController>();
  private session: InterviewSession | null = null;
  private disposed = false;
  private mockAudio: MockAudio | null = null;
  private supportsMock = false;
  private browserRequestId = "";
  private browserRequestTimer: number | undefined;

  decideBrowserConnection(requestId: string, approved: boolean): boolean {
    const socket = this.sockets.interviewer;
    return this.browserRequestId === requestId && !!socket && safeSocketSend(socket, {
      type: "browser_connection_decision", request_id: requestId, approved,
    });
  }

  private clearBrowserRequest() {
    window.clearTimeout(this.browserRequestTimer);
    this.browserRequestId = "";
    this.callbacks.onBrowserConnectionRequest?.(null);
  }
  private modeWaiter: { mode: string; resolve: () => void; reject: (error: Error) => void } | null = null;

  get mode(): "assist" | "mock" { return this.mockAudio ? "mock" : "assist"; }

  async prepareMode(mode: "assist" | "mock", systemStream?: MediaStream) {
    if (mode === "mock" && !this.supportsMock) throw new Error("服务器尚未支持模拟面试，请先更新后端。");
    const session = this.session;
    if (!session || this.disposed) throw new Error("采集连接已关闭。");
    if (mode === "mock") {
      const audio = this.mockAudio ?? new MockAudio();
      try {
        await audio.resume();
        if (this.session !== session || this.disposed) throw new Error("采集连接已关闭。");
        if (!this.mockAudio || !["ready", "muted"].includes(this.mediaHealth.interviewer.phase)) {
          const previous = this.mockAudio;
          this.mockAudio = audio;
          try { this.replaceChannel("interviewer", audio.stream.clone()); }
          catch (error) { this.mockAudio = previous; throw error; }
        }
      } catch (error) {
        if (this.mockAudio !== audio) audio.close();
        throw error;
      }
    } else if (this.mockAudio) {
      if (!systemStream) throw new Error("请重新连接系统音频。");
      const previous = this.mockAudio;
      this.mockAudio = null;
      try { this.replaceChannel("interviewer", systemStream); }
      catch (error) { this.mockAudio = previous; throw error; }
      previous.close();
    }
    if (!this.session || this.disposed) throw new Error("采集连接已关闭。");
    if (!this.supportsMock && mode === "assist") return;
    this.modeWaiter?.reject(new Error("音频准备已被新的操作替代。"));
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.modeWaiter = null;
        reject(new Error("音频模式确认超时，请恢复音频后重试。"));
      }, READY_TIMEOUT_MS);
      this.modeWaiter = { mode, resolve: () => { window.clearTimeout(timeout); resolve(); },
        reject: (error) => { window.clearTimeout(timeout); reject(error); } };
      this.reportCaptureHealth("interviewer", true);
    });
  }


  constructor(
    private readonly apiBaseUrl: string,
    streams: Partial<Record<Speaker, MediaStream>>,
    private readonly callbacks: CaptureAdapterCallbacks,
  ) {
    try {
      SPEAKERS.forEach(speaker => { if (streams[speaker]) this.replaceChannel(speaker, streams[speaker]); });
    } catch (error) {
      this.dispose();
      SPEAKERS.forEach((speaker) => streams[speaker]?.getTracks().forEach((track) => track.stop()));
      throw error;
    }
  }

  replaceChannel(speaker: Speaker, stream: MediaStream) {
    if (this.disposed) {
      stream.getTracks().forEach((track) => track.stop());
      throw new Error("采集设备已经关闭，请重新初始化。");
    }
    const previous = this.handles[speaker];
    const previousVersion = this.mediaVersions[speaker];
    const previousHealth = this.mediaHealth[speaker];
    const version = previousVersion + 1;
    this.mediaVersions[speaker] = version;
    try {
      const handle = startLocalAudioCapture({
        stream,
        onChunk: (chunk) => {
          if (this.mediaVersions[speaker] === version) this.sendAudio(speaker, chunk);
        },
        onHealthChange: (health) => {
          if (this.mediaVersions[speaker] !== version || this.disposed) return;
          this.mediaHealth[speaker] = health;
          this.reportCaptureHealth(speaker);
        },
        onEnded: () => {
          if (this.mediaVersions[speaker] !== version || this.disposed) return;
          this.mediaHealth[speaker] = { phase: "error", detail: "媒体轨道已结束，请恢复这一路采集。" };
          this.handles[speaker]?.stop();
          this.reportCaptureHealth(speaker);
          this.callbacks.onMediaEnded(speaker);
        },
      });
      this.handles[speaker] = handle;
      previous?.stop();
      this.mediaHealth[speaker] = handle.getHealth();
      this.reportCaptureHealth(speaker, true);
    } catch (error) {
      this.mediaVersions[speaker] = previousVersion;
      this.mediaHealth[speaker] = previousHealth;
      stream.getTracks().forEach((track) => track.stop());
      this.reportCaptureHealth(speaker, true);
      throw error;
    }
  }

  stopAudio() {
    SPEAKERS.forEach(speaker => this.stopSpeaker(speaker));
    this.mockAudio?.close();
    this.mockAudio = null;
  }

  private stopSpeaker(speaker: Speaker) {
      this.sending[speaker] = false;
      this.mediaVersions[speaker] += 1;
      this.handles[speaker]?.stop();
      delete this.handles[speaker];
      this.mediaHealth[speaker] = { phase: "interrupted", detail: "转录未开启。" };
      delete this.transportHealth[speaker];
    this.reportCaptureHealth(speaker, true);
  }

  private async finishSpeaker(speaker: Speaker, socket: WebSocket, requestId: string) {
    const handle = this.handles[speaker];
    let complete = !handle;
    try { if (handle) complete = await handle.finish(); }
    catch { complete = false; }
    if (this.handles[speaker] === handle) this.stopSpeaker(speaker);
    if (!this.handles.interviewer && !this.handles.candidate) {
      this.mockAudio?.close(); this.mockAudio = null;
    }
    // The acknowledgement follows all PCM on this same ordered WebSocket.
    if (this.sockets[speaker] === socket) safeSocketSend(socket, { type: 'capture_stopped', request_id: requestId, complete });
  }

  async connect(session: InterviewSession) {
    if (this.disposed) throw new Error("采集设备已经关闭，请重新初始化。");
    if (!session.capture_token) throw new Error("采集会话缺少 capture_token。");
    this.disconnectSession();
    this.session = session;
    try {
      await Promise.all(SPEAKERS.map((speaker) => this.openChannel(speaker, false)));
    } catch (error) {
      this.disconnectSession();
      throw error;
    }
  }

  disconnectSession() {
    this.clearBrowserRequest();
    if (this.session) this.stopAudio();
    this.session = null;
    this.mockAudio?.clear();
    this.modeWaiter?.reject(new Error("采集连接已关闭。"));
    this.modeWaiter = null;
    this.uploads.forEach((controller) => controller.abort());
    this.uploads.clear();
    SPEAKERS.forEach((speaker) => {
      this.sending[speaker] = false;
      this.ready[speaker] = false;
      delete this.reportedHealth[speaker];
      delete this.transportHealth[speaker];
      const timer = this.reconnectTimers[speaker];
      if (timer !== undefined) {
        window.clearTimeout(timer);
        delete this.reconnectTimers[speaker];
      }
      const socket = this.sockets[speaker];
      delete this.sockets[speaker];
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "capture session changed");
    });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.disconnectSession();
    SPEAKERS.forEach((speaker) => this.handles[speaker]?.stop());
    this.mockAudio?.close();
    this.mockAudio = null;
  }

  private currentHealth(speaker: Speaker): CaptureHealth {
    const media = this.mediaHealth[speaker];
    return media.phase === "error" || media.phase === "interrupted"
      ? media
      : this.transportHealth[speaker] ?? media;
  }

  private reportCaptureHealth(speaker: Speaker, force = false) {
    if (this.disposed) return;
    const health = this.currentHealth(speaker);
    if (this.ready[speaker]) {
      this.callbacks.onChannelChange(speaker, {
        phase: health.phase === "ready"
          ? (this.sending[speaker] ? "listening" : "ready")
          : health.phase,
        message: health.phase === "ready"
          ? (this.sending[speaker] ? "采集中" : "已就绪")
          : health.detail,
      });
    }
    const socket = this.sockets[speaker];
    if (!this.ready[speaker] || socket?.readyState !== WebSocket.OPEN) return;
    const key = JSON.stringify({ ...health, mode: this.mode });
    if (!force && this.reportedHealth[speaker] === key) return;
    if (!safeSocketSend(socket, { type: "capture_status", ...health, mode: this.mode })) return;
    this.reportedHealth[speaker] = key;
  }

  private openChannel(speaker: Speaker, reconnecting: boolean): Promise<void> {
    const session = this.session;
    if (!session?.capture_token || this.disposed) return Promise.reject(new Error("采集会话已经结束。"));
    this.callbacks.onChannelChange(speaker, {
      phase: reconnecting ? "reconnecting" : "connecting",
      message: reconnecting ? "重连中" : "连接采集通道",
    });

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(buildInterviewSocketUrl(this.apiBaseUrl, session.interview_id, speaker));
      this.sockets[speaker] = socket;
      this.ready[speaker] = false;
      this.sending[speaker] = false;
      delete this.reportedHealth[speaker];
      delete this.transportHealth[speaker];
      let settled = false;
      let authenticated = false;
      const isCurrent = () => this.sockets[speaker] === socket && this.session === session && !this.disposed;
      const failBeforeReady = (message: string) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        reject(new Error(message));
      };
      const timeoutId = window.setTimeout(() => {
        failBeforeReady(`${getCaptureLabel(speaker)}通道连接超时。`);
        socket.close();
      }, READY_TIMEOUT_MS);

      socket.addEventListener("open", () => {
        if (!isCurrent() || !safeSocketSend(socket, { type: "authenticate", token: session.capture_token, browser_connections: true })) {
          socket.close(4008, "authentication failed");
        }
      });
      socket.addEventListener("message", (message) => {
        if (!isCurrent() || typeof message.data !== "string") return;
        const event = parseServerEvent(message.data);
        if (!event) return;
        if (event.type === "session_ready") {
          if (event.realtime_protocol !== REALTIME_PROTOCOL) {
            failBeforeReady(INCOMPATIBLE_SERVER);
            this.callbacks.onError(INCOMPATIBLE_SERVER);
            this.disconnectSession();
            return;
          }
          if (speaker === "interviewer") this.supportsMock = event.mock_interview === true;
          if (!authenticated) monitorSocket(socket);
          authenticated = true;
          this.ready[speaker] = true;
          this.reconnectAttempts[speaker] = 0;
          if (speaker === "interviewer" && event.mode === "mock" && this.mode !== "mock") {
            void this.prepareMode("mock").catch((error) => this.callbacks.onError(errorMessage(error, "请恢复模拟音频。")));
          } else this.reportCaptureHealth(speaker, true);
          if (!settled) {
            settled = true;
            window.clearTimeout(timeoutId);
            resolve();
          }
          return;
        }
        if (event.type === "capture_mode_ready" && speaker === "interviewer") {
          if (this.modeWaiter && this.modeWaiter.mode === event.mode) {
            const waiter = this.modeWaiter;
            this.modeWaiter = null;
            waiter.resolve();
          }
          return;
        }
        if (event.type === "browser_connection_request" && speaker === "interviewer" && event.request_id) {
          this.clearBrowserRequest();
          this.browserRequestId = event.request_id;
          this.callbacks.onBrowserConnectionRequest?.({ request_id: event.request_id, name: event.text || "新浏览器", read_only: event.read_only });
          this.browserRequestTimer = window.setTimeout(() => this.clearBrowserRequest(), 120_000);
          return;
        }
        if (event.type === "browser_connection_result" && event.request_id === this.browserRequestId) {
          this.clearBrowserRequest();
          return;
        }
        if (event.type === "mock_audio" && speaker === "interviewer") {
          if (!this.sending.interviewer || !this.mockAudio) return;
          try { this.mockAudio.append(event.delta || ""); }
          catch (error) {
            this.mockAudio.clear();
            this.callbacks.onError(errorMessage(error, "模拟面试官语音播放失败。"));
            safeSocketSend(socket, { type: "mock_playback_error" });
          }
          return;
        }
        if (event.type === "mock_audio_reset" && speaker === "interviewer") {
          this.mockAudio?.clear();
          return;
        }
        if (event.type === "prepare_capture" && speaker === "interviewer") {
          this.callbacks.onPrepareCapture?.(event.mode === "mock" ? "mock" : "assist");
          return;
        }
        if (event.type === "capture_stop") {
          if (event.request_id) void this.finishSpeaker(speaker, socket, event.request_id);
          else this.stopAudio();
          return;
        }
        if (event.type === "capture_start") {
          this.sending[speaker] = true;
          this.reportCaptureHealth(speaker);
          return;
        }
        if (event.type === "screen_capture_request" && speaker === "interviewer") {
          void this.respondToScreenCapture(event, socket);
          return;
        }
        if (event.type === "session_ended") {
          this.callbacks.onSessionEnded();
          return;
        }
        if (event.type === "error") {
          const detail = event.detail ?? event.error ?? event.message;
          if (detail) this.callbacks.onError(detail);
        }
      });
      socket.addEventListener("error", () => {
        failBeforeReady(`${getCaptureLabel(speaker)}通道连接失败。`);
      });
      socket.addEventListener("close", (event) => {
        window.clearTimeout(timeoutId);
        const wasCurrent = this.sockets[speaker] === socket;
        if (wasCurrent) {
          if (speaker === "interviewer") this.clearBrowserRequest();
          if (speaker === "interviewer") this.mockAudio?.clear();
          delete this.sockets[speaker];
          this.ready[speaker] = false;
          this.sending[speaker] = false;
        }
        failBeforeReady(`${getCaptureLabel(speaker)}通道在就绪前关闭。`);
        const sessionIsCurrent = wasCurrent && this.session === session && !this.disposed;
        if (sessionIsCurrent && event.code === 1008) this.callbacks.onSessionEnded();
        else if (sessionIsCurrent && authenticated) this.scheduleReconnect(speaker);
      });
    });
  }

  private scheduleReconnect(speaker: Speaker) {
    if (!this.session || this.disposed || this.reconnectTimers[speaker] !== undefined) return;
    const attempt = this.reconnectAttempts[speaker];
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempts[speaker] = attempt + 1;
    this.callbacks.onChannelChange(speaker, { phase: "reconnecting", message: "重连中" });
    this.reconnectTimers[speaker] = window.setTimeout(() => {
      delete this.reconnectTimers[speaker];
      void this.openChannel(speaker, true).catch((error) => {
        if (!this.session || this.disposed) return;
        this.callbacks.onError(errorMessage(error, `${getCaptureLabel(speaker)}重连失败。`));
        this.scheduleReconnect(speaker);
      });
    }, delay);
  }

  private sendAudio(speaker: Speaker, chunk: ArrayBuffer) {
    const socket = this.sockets[speaker];
    if (this.transportHealth[speaker] && socket?.readyState === WebSocket.OPEN &&
        socket.bufferedAmount <= MAX_BUFFERED_AUDIO_BYTES) {
      delete this.transportHealth[speaker];
      this.reportCaptureHealth(speaker);
    }
    if (!this.sending[speaker] || !this.ready[speaker] ||
        this.mediaHealth[speaker].phase !== "ready" || socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_AUDIO_BYTES) {
      if (!this.transportHealth[speaker]) {
        const detail = `${getCaptureLabel(speaker)}网络拥塞，部分音频未发送；请补充缺失内容。`;
        this.transportHealth[speaker] = { phase: "interrupted", detail };
        this.callbacks.onError(detail);
        this.reportCaptureHealth(speaker);
      }
      return;
    }
    try {
      socket.send(chunk);
    } catch {
      const detail = `${getCaptureLabel(speaker)}音频发送失败，正在重新连接；请补充缺失内容。`;
      this.transportHealth[speaker] = { phase: "interrupted", detail };
      this.callbacks.onError(detail);
      this.reportCaptureHealth(speaker);
      socket.close(4011, "audio send failed");
    }
  }

  private async respondToScreenCapture(event: ServerEvent, socket: WebSocket) {
    const session = this.session;
    const requestId = event.request_id;
    if (!requestId || !session?.capture_token || this.sockets.interviewer !== socket ||
        !this.ready.interviewer || this.uploads.has(requestId)) return;
    const controller = new AbortController();
    this.uploads.set(requestId, controller);
    const requestTimeout = window.setTimeout(() => controller.abort(), SCREEN_REQUEST_TIMEOUT_MS);
    let timeout: number | undefined;
    const isCurrent = () => this.session === session && this.sockets.interviewer === socket &&
      this.ready.interviewer && !this.disposed && !controller.signal.aborted;
    try {
      const capture = window.interviewDesktop?.captureScreenSnapshot;
      if (!capture) throw new Error("截图接口不可用，请重新打开桌面端。");
      const snapshot = await withAbort(capture(), controller.signal);
      if (!isCurrent()) return;
      timeout = window.setTimeout(() => controller.abort(), SCREEN_UPLOAD_TIMEOUT_MS);
      const endpoint = new URL(
        `/api/interviews/${encodeURIComponent(session.interview_id)}/screenshots`, this.apiBaseUrl,
      );
      const response = await fetch(endpoint.toString(), {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.capture_token}`,
        },
        body: JSON.stringify({ request_id: requestId, ...snapshot }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`截图上传失败（${response.status}），请重新看题。`);
      }
    } catch (error) {
      if (this.session !== session || this.sockets.interviewer !== socket || this.disposed) return;
      const detail = controller.signal.aborted ? "截图请求超时，请重新看题。" : errorMessage(error, "截图失败。");
      // Only a small error control travels on this socket; image bytes never do.
      safeSocketSend(socket, { type: "screen_snapshot", request_id: requestId, error: detail });
      this.callbacks.onError(detail);
    } finally {
      window.clearTimeout(requestTimeout);
      if (timeout !== undefined) window.clearTimeout(timeout);
      if (this.uploads.get(requestId) === controller) this.uploads.delete(requestId);
    }
  }
}

function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("截图已取消。")); return; }
    const onAbort = () => reject(new Error("截图已取消。"));
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", onAbort);
      reject(error);
    });
  });
}

function parseServerEvent(value: string): ServerEvent | null {
  try {
    const parsed = JSON.parse(value) as ServerEvent;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
