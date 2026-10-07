import {
  requestCaptureStream,
  startLocalAudioCapture,
  type AudioCaptureHandle,
} from "./audioCapture";
import { receive, type Event } from "../../../packages/chat-ui/bridge";
const host = (window as any).sageCaptureHost;
if (host) {
  let socket: WebSocket | undefined,
    ready = false,
    stopped = false,
    phase = "idle",
    generation = 0;
  let heartbeat: number | undefined,
    retry: number | undefined,
    lastMessage = 0;
  let stopping: Promise<void> | undefined,
    marking = false;
  const handles = new Map<string, AudioCaptureHandle>(),
    held = new Map<string, ArrayBuffer[]>(),
    holding = new Set<string>();
  const queue: (string | ArrayBuffer)[] = [];
  let bytes = 0;
  const report = (detail: string) => receive({ type: "error", detail });
  const wait = async (test: () => boolean, ms: number) => {
    const until = Date.now() + ms;
    while (!test()) {
      if (Date.now() > until) throw Error("操作超时，请检查连接。");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  function drain() {
    if (!ready || socket?.readyState !== WebSocket.OPEN) return;
    while (queue.length && socket.bufferedAmount < 24000) {
      const value = queue.shift()!;
      if (typeof value !== "string") bytes -= value.byteLength;
      socket.send(value);
    }
  }
  function send(value: Event) {
    if (!ready) throw Error("连接尚未就绪。");
    if (queue.length > 100) throw Error("连接积压。");
    queue.push(JSON.stringify(value));
    drain();
  }
  function pcm(role: string, data: ArrayBuffer) {
    if (holding.has(role)) {
      const frames = held.get(role) || [];
      frames.push(data);
      held.set(role, frames);
      if (frames.reduce((n, f) => n + f.byteLength, 0) > 24000) {
        frames.shift();
        report("音频出现缺口，请检查转录。");
      }
      return;
    }
    const tagged = new Uint8Array(data.byteLength + 1);
    tagged[0] = role === "interviewer" ? 0 : 1;
    tagged.set(new Uint8Array(data), 1);
    // Never evict audio before an already queued ask/stop marker.
    while (bytes + tagged.length > 48000) {
      let index = -1;
      for (let i = queue.length - 1; i >= 0; i--) {
        if (typeof queue[i] === "string") break;
        index = i;
      }
      if (index < 0) {
        report("连接积压，音频出现缺口。");
        return;
      }
      bytes -= (queue.splice(index, 1)[0] as ArrayBuffer).byteLength;
      report("连接积压，音频出现缺口。");
    }
    queue.push(tagged.buffer);
    bytes += tagged.length;
    drain();
  }
  function endLocal() {
    generation++;
    handles.forEach((h) => h.stop());
    handles.clear();
    held.clear();
    holding.clear();
    phase = "idle";
  }
  async function open() {
    await host.connect();
    if (
      socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING)
    )
      return;
    stopped = false;
    const url = new URL("/capture/socket", host.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const current = new WebSocket(url);
    socket = current;
    current.binaryType = "arraybuffer";
    current.onopen = () =>
      current.send(
        JSON.stringify({ type: "authenticate", protocol: "cue-chat-v1" }),
      );
    current.onmessage = (e) => {
      lastMessage = Date.now();
      const value = JSON.parse(e.data);
      if (value.type === "session_ready") {
        if (value.protocol !== "cue-chat-v1") {
          stopped = true;
          current.close();
          return;
        }
        ready = true;
      }
      if (value.type === "started") phase = "active";
      if (value.type === "stopped") {
        endLocal();
        phase = "idle";
      }
      if (value.type === "replaced") {
        stopped = true;
        endLocal();
        current.close();
      }
      receive(value);
    };
    current.onclose = () => {
      if (socket !== current) return;
      ready = false;
      endLocal();
      queue.length = 0;
      bytes = 0;
      clearInterval(heartbeat);
      receive({
        type: "disconnected",
        detail: stopped ? "此连接已被替换" : "连接中断，正在恢复…",
      });
      if (!stopped)
        retry = window.setTimeout(
          () => void open().catch((e) => report(String(e))),
          2500,
        );
    };
    lastMessage = Date.now();
    clearInterval(heartbeat);
    heartbeat = window.setInterval(() => {
      if (Date.now() - lastMessage > 25000) {
        current.close();
        return;
      }
      if (ready) send({ type: "ping" });
    }, 5000);
  }
  async function stop() {
    if (stopping) return stopping;
    generation++;
    phase = "stopping";
    stopping = (async () => {
      let complete = true;
      for (const h of handles.values())
        if (!(await h.finish())) complete = false;
      handles.clear();
      if (ready) {
        send({ type: "stop" });
        await wait(() => phase === "idle", 12000);
      }
      if (!complete) report("本地音频尾帧未全部确认。");
    })().finally(() => {
      endLocal();
      stopping = undefined;
    });
    return stopping;
  }
  async function audio(start: boolean) {
    if (!start) return stop();
    if (phase !== "idle" || !ready) throw Error("连接未就绪或转录已开启。");
    phase = "starting";
    const epoch = ++generation;
    const streams = new Map<string, MediaStream>();
    try {
      for (const role of ["interviewer", "candidate"] as const) {
        streams.set(role, await requestCaptureStream(role));
        if (epoch !== generation) throw Error("启动已取消。");
      }
      send({ type: "start" });
      await wait(() => phase === "active" || !ready, 15000);
      if (!ready || epoch !== generation) throw Error("转录启动已取消。");
      for (const [role, stream] of streams)
        handles.set(
          role,
          startLocalAudioCapture({
            stream,
            onChunk: (data) => pcm(role, data),
            onEnded: () => void stop().catch((e) => report(String(e))),
            onHealthChange: (h) => {
              if (h.phase === "error" || h.phase === "interrupted")
                report(h.detail);
            },
          }),
        );
    } catch (e) {
      streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
      await stop().catch(() => {});
      throw e;
    }
  }
  async function command(value: Event) {
    if (value.type === "ask" && handles.size) {
      if (marking) throw Error("正在准备上一轮问题。");
      marking = true;
      try {
        await Promise.all(
          [...handles].map(async ([role, h]) => {
            await h.flush();
            holding.add(role);
          }),
        );
        send(value);
      } finally {
        holding.clear();
        for (const [role, frames] of held)
          for (const frame of frames) pcm(role, frame);
        held.clear();
        marking = false;
      }
    } else send(value);
  }
  window.cue = {
    connect: open,
    command,
    audio,
    request: host.request,
    sources: host.sources,
    selectSource: host.selectSource,
    openSettings: host.openSettings,
    copy: async (text: string) => navigator.clipboard.writeText(text),
    uploadMaterials: host.uploadMaterials,
    importConnection: async () => {
      await host.importConnection();
      await open();
    },
    pin: host.pin,
    screenshot: async (recording: string) => {
      const shot = await host.screenshot();
      const result = await host.request("/capture/images", "POST", {
        ...shot,
        request_id: crypto.randomUUID(),
        recording,
      });
      return { ...result, image_url: shot.image_data };
    },
  };
  (window as any).sageCapture = { audio };
  window.addEventListener("sage:answer-requested", () =>
    receive({ type: "answer_requested" }),
  );
  window.addEventListener("beforeunload", () => {
    stopped = true;
    clearTimeout(retry);
    clearInterval(heartbeat);
    endLocal();
    socket?.close();
  });
  window.setInterval(drain, 10);
}
