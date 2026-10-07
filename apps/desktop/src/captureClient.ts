import {
  requestCaptureStream,
  startLocalAudioCapture,
  type AudioCaptureHandle,
} from "./audioCapture";
const bridge = (window as any).sageCaptureHost;
if (bridge) {
  type Channel = {
    socket: WebSocket;
    handle?: AudioCaptureHandle;
    ping?: number;
    pump?: number;
    ready: boolean;
    stopped: boolean;
    queue: ArrayBuffer[];
    bytes: number;
    lastMessage: number;
  };
  const channels = new Map<string, Channel>();
  let generation = 0;
  let changing = false,
    stopping: Promise<void> | undefined;
  const report = (detail: string) =>
    window.dispatchEvent(new CustomEvent("sage:capture-status", { detail }));
  const wait = async (test: () => boolean, timeout: number) => {
    const end = Date.now() + timeout;
    while (!test()) {
      if (Date.now() > end) throw Error("采集操作未确认，请检查连接。");
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  function drain(c: Channel) {
    try {
      while (
        c.queue.length &&
        c.socket.readyState === WebSocket.OPEN &&
        c.socket.bufferedAmount < 12000
      ) {
        const bytes = c.queue.shift()!;
        c.bytes -= bytes.byteLength;
        c.socket.send(bytes);
      }
    } catch {
      report("音频连接中断，请停止后重新开始。");
      void stop();
    }
  }
  async function drained(c: Channel) {
    drain(c);
    await wait(() => !c.queue.length && c.socket.bufferedAmount === 0, 2000);
  }
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      const values = [...channels.values()];
      try {
        for (const c of values) {
          if (c.handle) await c.handle.finish();
          if (c.socket.readyState === WebSocket.OPEN) {
            await drained(c);
            c.socket.send(JSON.stringify({ type: "stop" }));
          }
        }
        await wait(
          () =>
            values.every(
              (c) => c.stopped || c.socket.readyState === WebSocket.CLOSED,
            ),
          11500,
        );
      } finally {
        for (const c of values) {
          c.handle?.stop();
          clearInterval(c.ping);
          clearInterval(c.pump);
          c.socket.close();
        }
        channels.clear();
      }
    })().finally(() => {
      stopping = undefined;
    });
    return stopping;
  }
  async function boundary(id: string) {
    for (const c of channels.values()) {
      await drained(c);
      if (!c.ready || c.stopped || c.socket.readyState !== WebSocket.OPEN)
        throw Error("音频连接中断，本次没有请求回答。");
      c.socket.send(
        JSON.stringify({ type: "prepare_request", request_id: id }),
      );
    }
  }
  async function audio(start: boolean) {
    if (!start) {
      generation++;
      await stop();
      return;
    }
    if (changing) return;
    changing = true;
    const epoch = ++generation;
    try {
      if (channels.size) throw Error("转录已经开启。");
      const streams = new Map<string, MediaStream>();
      try {
        for (const role of ["interviewer", "candidate"] as const) {
          streams.set(role, await requestCaptureStream(role));
          if (epoch !== generation) throw Error("转录启动已取消。");
        }
        for (const [role, stream] of streams) {
          const url = new URL("/capture/audio/" + role, bridge.origin);
          url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
          const socket = new WebSocket(url),
            c: Channel = {
              socket,
              ready: false,
              stopped: false,
              queue: [],
              bytes: 0,
              lastMessage: Date.now(),
            };
          channels.set(role, c);
          socket.binaryType = "arraybuffer";
          socket.onopen = () =>
            socket.send(JSON.stringify({ type: "authenticate" }));
          socket.onmessage = (e) => {
            c.lastMessage = Date.now();
            const message = JSON.parse(e.data);
            if (message.type === "session_ready") {
              if (message.realtime_protocol !== "sage-capture-v1") {
                report("服务器版本不匹配，转录未开始。");
                c.stopped = true;
                socket.close();
                return;
              }
              socket.send(JSON.stringify({ type: "start" }));
            }
            if (message.type === "started") c.ready = true;
            if (message.type === "stopped" || message.type === "error") {
              c.stopped = true;
              c.handle?.stop();
              socket.close();
              if (message.type === "error" || message.complete === false)
                report(message.detail || "尾句未确认，请检查转录。");
            }
          };
          socket.onclose = () => {
            c.stopped = true;
            c.handle?.stop();
            clearInterval(c.ping);
            clearInterval(c.pump);
          };
          c.ping = window.setInterval(() => {
            if (Date.now() - c.lastMessage > 20000) {
              report("音频连接中断，没有自动重启。");
              socket.close();
              return;
            }
            if (socket.readyState === WebSocket.OPEN)
              socket.send(JSON.stringify({ type: "ping" }));
          }, 5000);
          c.pump = window.setInterval(() => drain(c), 10);
          await wait(() => c.ready || c.stopped, 12000);
          if (c.stopped || epoch !== generation)
            throw Error("转录连接失败或已取消。");
          c.handle = startLocalAudioCapture({
            stream,
            onChunk: (bytes) => {
              if (socket.readyState !== WebSocket.OPEN) return;
              c.queue.push(bytes);
              c.bytes += bytes.byteLength;
              while (c.bytes > 24000 && c.queue.length) {
                c.bytes -= c.queue.shift()!.byteLength;
                report("网络积压，音频出现缺口。");
              }
              drain(c);
            },
            onEnded: () => {
              report("音频源已停止。");
              void stop().catch(() => {});
            },
            onHealthChange: (health) => {
              if (health.phase === "error" || health.phase === "interrupted")
                report(health.detail);
            },
          });
        }
      } catch (error) {
        streams.forEach((stream) =>
          stream.getTracks().forEach((t) => t.stop()),
        );
        await stop().catch(() => {});
        throw error;
      }
    } finally {
      changing = false;
    }
  }
  (window as any).sageCapture = {
    ...bridge,
    audio,
    boundary,
    hasAudio: () => [...channels.values()].some((c) => c.ready && !c.stopped),
  };
}
