import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Spinner } from "@heroui/react";
import {
  ArrowClockwise,
  ArrowUp,
  Camera,
  CaretDown,
  CaretUp,
  DeviceMobile,
  DotsThree,
  Stop,
  Subtitles,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { type Event } from "./bridge";
import { OneExchange, busy, shortcut, type Message } from "./Messages";
import { CAPTION_WINDOW, CaptionStrip, joinCaptions } from "./Captions";
import "./styles.css";
import { UploadQueue } from "./upload-queue.mjs";

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000)),
    pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};
/** The answers the next question sees; one still running always stays. */
const lastHour = (ms: Message[]) =>
  ms.filter(
    (m: Message & { created?: number }) =>
      busy(m) || (m.created ?? Date.now()) >= Date.now() - 3600000,
  );
/** Native tooltip: an in-page one would be clipped by the window edge. */
const Tip = ({ label, children }: { label: string; children: ReactNode }) => (
  <span className="tip" title={label}>
    {children}
  </span>
);

/**
 * Windows overlay: a control bar, then notices, interviewer captions and the
 * answer card. The host sizes the frameless window to this element, keeps
 * it out of focus until the text box is used, and shows the menu natively
 * so nothing is clipped by the window edge.
 */
export default function App() {
  const [connected, setConnected] = useState(false),
    [status, setStatus] = useState("正在连接…"),
    [error, setError] = useState("");
  const [messages, setMessages] = useState<Message[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [previews, setPreviews] = useState<Record<string, string>>({});
  const [text, setText] = useState(localStorage.getItem("cue.draft") || ""),
    [audio, setAudio] = useState("idle"),
    [since, setSince] = useState(0),
    [working, setWorking] = useState(false),
    [uploading, setUploading] = useState(0),
    [uploadError, setUploadError] = useState(""),
    [pending, setPending] = useState(""),
    [effort, setEffort] = useState(localStorage.getItem("cue.effort") || "");
  const [expanded, setExpanded] = useState(false),
    [captionsOn, setCaptionsOn] = useState(
      localStorage.getItem("cue.captions") !== "off",
    ),
    [captions, setCaptions] = useState<
      { item: string; text: string; at: number }[]
    >([]),
    [, tick] = useState(0);
  // The Cue web page: whether it may control this computer, whether
  // it is open now, and whether the current recording was started from it.
  const [allowRemote, setAllowRemote] = useState(
      localStorage.getItem("cue.remote") !== "off",
    ),
    [remoteOpen, setRemoteOpen] = useState(false),
    [audioSource, setAudioSource] = useState("");
  const root = useRef<HTMLDivElement>(null),
    list = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    follow = useRef(true),
    // Answers are one timeline, the last hour, like transcripts. This is the
    // server row new answers are stored under: the newest chat, never shown.
    chat = useRef(""),
    remoteGeneration = useRef(""),
    remoteBusy = useRef(false),
    shooting = useRef(false),
    reported = useRef(""),
    // The latest handlers, for web commands arriving in the event listener.
    actions = useRef<{
      toggleAudio: (source?: string) => Promise<void>;
      shot: (receipt?: Event) => Promise<void>;
    }>({ toggleAudio: async () => {}, shot: async () => {} }),
    current = useRef({
      text,
      selected,
      connected,
      audio,
      pending,
      messages,
      effort,
      allowRemote,
    });
  current.current = {
    text,
    selected,
    connected,
    audio,
    pending,
    messages,
    effort,
    allowRemote,
  };
  const attempt = async (fn: () => Promise<any>) => {
    try {
      setError("");
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const command = (value: Event) => window.cue.command(value);
  async function reconnect() {
    setStatus("正在连接…");
    setError("");
    try {
      await window.cue.connect();
    } catch (e) {
      setStatus("连接未就绪");
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  function use(id: string) {
    chat.current = id;
    setMessages([]);
    follow.current = true;
    void attempt(() => command({ type: "history", chat: id, scope: "recent" }));
  }
  const uploadQueue = useRef<UploadQueue | null>(null);
  const uploadReceipts = useRef(new Map<string, Event>());
  function finishShot(id: string, failure?: string) {
    const receipt = uploadReceipts.current.get(id);
    uploadReceipts.current.delete(id);
    if (!receipt || !current.current.connected || receipt.generation !== remoteGeneration.current) return;
    void command({ ...receipt, ok: !failure, ...(failure ? { detail: failure.slice(0, 300) } : { image: id }) }).catch(() => {});
  }
  uploadQueue.current ??= new UploadQueue(
    (shot: Event) => window.cue.uploadScreenshot!(shot),
    (image: Event) => {
      if (!current.current.selected.includes(image.id))
        current.current.selected = [
          ...current.current.selected,
          image.id,
        ].slice(-8);
      setSelected(current.current.selected);
      finishShot(image.id);
      const preview = image.image_url;
      if (typeof preview === "string")
        setPreviews((p) => {
          const next: Record<string, string> = { ...p, [image.id]: preview };
          for (const id of Object.keys(next))
            if (!current.current.selected.includes(id)) delete next[id];
          return next;
        });
    },
    (count: number, error: string) => {
      setUploading(count);
      setUploadError(error);
      if (error) for (const id of uploadReceipts.current.keys()) finishShot(id, error);
    },
  );
  function beginAnswer(value?: { text: string; effort?: string }) {
    const s = current.current;
    if (
      !s.connected ||
      !chat.current ||
      s.pending ||
      s.messages.some(busy) ||
      ["starting", "stopping"].includes(s.audio)
    )
      throw Error("请等待连接或上一轮回答完成。");
    if (uploadQueue.current!.error) throw Error(uploadQueue.current!.error);
    const id = crypto.randomUUID(),
      generation = remoteGeneration.current;
    current.current.pending = id;
    setPending(id);
    setError("");
    setExpanded(true);
    void (async () => {
      try {
        while (shooting.current) {
          if (current.current.pending !== id) return;
          await new Promise((r) => setTimeout(r, 20));
        }
        await uploadQueue.current!.wait();
        if (
          current.current.pending !== id ||
          !current.current.connected ||
          generation !== remoteGeneration.current
        )
          return;
        await command({
          type: "ask",
          id,
          chat: chat.current,
          text: value?.text ?? s.text,
          images: current.current.selected,
          effort: (value ? value.effort : s.effort) || undefined,
        });
      } catch (e) {
        if (current.current.pending === id) {
          current.current.pending = "";
          setPending("");
          setError(String(e));
        }
      }
    })();
    return id;
  }
  async function ask() {
    await attempt(async () => beginAnswer());
  }
  async function cancelAnswer() {
    const s = current.current;
    const id = s.messages.find(busy)?.id || s.pending;
    current.current.pending = "";
    setPending("");
    if (id) await command({ type: "cancel", id });
  }
  async function captureShot(receipt?: Event) {
    if (shooting.current) throw Error("截图尚未完成。");
    // Saved references never block capture; only unsaved originals fill this queue.
    if (uploadQueue.current!.items.length >= 8)
      throw Error("8 张截图仍未上传，请等待或重试上传。");
    shooting.current = true;
    setWorking(true);
    try {
      const shot = await window.cue.screenshot();
      if (receipt) {
        shot.request_id = receipt.id;
        uploadReceipts.current.set(receipt.id, receipt);
      }
      uploadQueue.current!.add(shot);
    } finally {
      shooting.current = false;
      setWorking(false);
    }
  }
  async function shot() {
    await attempt(captureShot);
  }
  async function runRemote(value: Event) {
    const { id, type, generation, expires } = value;
    if (!id || !generation || generation !== remoteGeneration.current) return;
    let locked = false;
    try {
      if (!current.current.connected || !current.current.allowRemote)
        throw Error("电脑上已关闭遥控或连接已断开。");
      if (!(expires > Date.now())) throw Error("指令已过期，没有执行。");
      let answer: string | undefined;
      if (type === "cancel") await cancelAnswer();
      else if (type === "unselect") {
        current.current.selected = current.current.selected.filter(
          (i) => i !== value.image,
        );
        setSelected(current.current.selected);
      } else if (type === "ask")
        answer = beginAnswer({ text: value.text ?? "", effort: value.effort });
      else {
        if (remoteBusy.current || shooting.current)
          throw Error("电脑正在完成上一个操作。");
        remoteBusy.current = locked = true;
        const phase = current.current.audio;
        if (["starting", "stopping"].includes(phase))
          throw Error("请等待音频就绪。");
        if (type === "shot") {
          await actions.current.shot({ type: "remote_result", id, generation });
          return; // Upload completion sends success without blocking another capture.
        }
        else if (
          (type === "start" && phase === "idle") ||
          (type === "stop" && phase === "active")
        )
          await actions.current.toggleAudio(type === "start" ? "remote" : "");
        else if (!["start", "stop"].includes(type))
          throw Error("遥控指令无效。");
      }
      if (remoteGeneration.current === generation && current.current.connected)
        await command({
          type: "remote_result",
          id,
          generation,
          ok: true,
          answer,
        });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setError(detail);
      if (remoteGeneration.current === generation && current.current.connected)
        await command({
          type: "remote_result",
          id,
          generation,
          ok: false,
          detail,
        }).catch(() => {});
    } finally {
      if (locked) remoteBusy.current = false;
    }
  }
  useEffect(() => {
    const listener = (event: globalThis.Event) => {
      const e = (event as CustomEvent).detail as Event;
      if (e.type === "session_ready" || e.type === "state") {
        setConnected(true);
        setStatus("已连接");
        if (e.type === "session_ready") {
          setAudio("idle");
          setSince(0);
          setPending("");
          setAudioSource("");
          remoteGeneration.current = e.generation ?? "";
          reported.current = "";
          // The server lists chats newest first.
          if (e.chats?.[0]?.id) use(e.chats[0].id);
          else void attempt(() => command({ type: "new_chat" }));
        }
      }
      if (e.type === "chat_created") use(e.chat.id);
      if (e.type === "history") {
        setMessages(lastHour(e.messages));
        setPending("");
      }
      if (e.type === "answer") {
        if (e.message.id === current.current.pending) {
          if (current.current.text === e.message.text) {
            setText("");
            localStorage.removeItem("cue.draft");
          }
          const used = JSON.parse(e.message.context || "{}").images || [];
          setSelected((s) => s.filter((id) => !used.includes(id)));
        }
        setPending("");
        setMessages((ms) =>
          ms.some((m) => m.id === e.message.id)
            ? ms.map((m) => (m.id === e.message.id ? e.message : m))
            : lastHour([...ms, e.message]),
        );
      }
      if (e.type === "answer_delta")
        setMessages((ms) =>
          ms.map((m) =>
            m.id === e.id ? { ...m, answer: m.answer + e.delta } : m,
          ),
        );
      if (e.type === "answer_reasoning")
        setMessages((ms) =>
          ms.map((m) =>
            m.id === e.id
              ? { ...m, reasoning: (m.reasoning ?? "") + e.delta }
              : m,
          ),
        );
      // Display only: from the local transcription stream, never the server.
      // The strip keeps the last ten minutes for scrolling back.
      if (e.type === "caption" && current.current.audio !== "idle")
        setCaptions((cs) => {
          const now = Date.now();
          return (
            cs.some((c) => c.item === e.item)
              ? cs.map((c) => (c.item === e.item ? { ...c, text: e.text } : c))
              : [...cs, { item: e.item, text: e.text, at: now }]
          ).filter((c) => c.at >= now - CAPTION_WINDOW);
        });
      if (e.type === "started") {
        setAudio("active");
        setSince(Date.now());
        setCaptions([]);
      }
      if (e.type === "stopped") {
        setAudio("idle");
        setSince(0);
        setAudioSource("");
        if (!e.complete) setError("音频尾句未全部确认，请检查转录。");
      }
      if (e.type === "disconnected" || e.type === "replaced") {
        setConnected(false);
        setAudio("idle");
        setSince(0);
        setStatus(e.detail || "连接中断");
        setPending("");
        setMessages((ms) =>
          ms.map((m) =>
            busy(m)
              ? {
                  ...m,
                  status: "interrupted",
                  detail: "连接中断，未自动重发。",
                }
              : m,
          ),
        );
      }
      if (e.type === "error") {
        setError(e.detail);
        if (!e.id || e.id === current.current.pending) setPending("");
      }
      if (e.type === "answer_requested") void ask();
      if (e.type === "shot_requested") void shot();
      if (e.type === "remote") setRemoteOpen(e.connected === true);
      // A web button runs exactly what this window's button runs.
      if (e.type === "remote_command") void runRemote(e.command ?? {});
      if (["disconnected", "replaced"].includes(e.type))
        remoteGeneration.current = "";
    };
    window.addEventListener("cue:event", listener);
    void reconnect();
    return () => window.removeEventListener("cue:event", listener);
  }, []);
  useEffect(() => {
    if (follow.current && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [messages]);
  useEffect(() => {
    localStorage.setItem("cue.effort", effort);
  }, [effort]);
  useEffect(() => {
    localStorage.setItem("cue.remote", allowRemote ? "on" : "off");
  }, [allowRemote]);
  useEffect(() => {
    // What the web page shows about this computer; sent on change.
    if (!connected || !remoteGeneration.current) return;
    const report = {
      type: "remote_state",
      version: 3,
      allow: allowRemote,
      phase: audio,
      since,
      selected,
      pending,
      uploading,
      uploads: uploadQueue.current!.items.map((shot) => shot.request_id),
      upload_error: uploadError.slice(0, 300),
      error: error.slice(0, 300),
      source: audio === "active" ? audioSource : "",
    };
    const key = JSON.stringify(report);
    if (key === reported.current) return;
    reported.current = key;
    void command(report).catch(() => (reported.current = ""));
  }, [
    connected,
    allowRemote,
    audio,
    since,
    selected,
    error,
    audioSource,
    uploading,
    uploadError,
    pending,
  ]);
  useEffect(() => {
    localStorage.setItem("cue.captions", captionsOn ? "on" : "off");
  }, [captionsOn]);
  useEffect(() => {
    if (audio !== "active") return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [audio]);
  useEffect(() => {
    // The host sizes the window to this element.
    const el = root.current!;
    const observer = new ResizeObserver(() => {
      const box = el.getBoundingClientRect();
      void window.cue.resize?.({
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // Grow with the draft up to a few lines, then scroll.
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, [text, expanded]);
  const active = messages.find(busy),
    sending = !!active || !!pending,
    audioBusy = ["starting", "stopping"].includes(audio),
    captionText = joinCaptions(captions.map((c) => c.text)),
    // Beyond half the screen the answer scrolls inside the card.
    limit = Math.round(screen.availHeight * 0.5);
  async function changeAudio(source = "") {
    if (audioBusy) throw Error("请等待音频就绪。");
    const start = audio === "idle";
    if (start) setAudioSource(source);
    setAudio(start ? "starting" : "stopping");
    try {
      await window.cue.audio(start);
    } catch (e) {
      setAudio("idle");
      throw e;
    }
  }
  async function toggleAudio() {
    await attempt(() => changeAudio());
  }
  actions.current = { toggleAudio: changeAudio, shot: captureShot };
  /** The native menu returns a choice; hiding, quitting and links stay native. */
  async function more() {
    const choice = await attempt(() =>
      window.cue.menu!({ effort, remote: allowRemote }),
    );
    if (!choice) return;
    if (typeof choice.effort === "string") setEffort(choice.effort);
    else if (typeof choice.remote === "boolean") setAllowRemote(choice.remote);
    else if (choice.source)
      void attempt(() => window.cue.selectSource(choice.source));
    else if (choice.action === "connection")
      void attempt(() => window.cue.importConnection());
    else if (choice.action === "privacy")
      void attempt(() => window.cue.openPrivacy!());
  }

  return (
    <div className="overlay" ref={root}>
      <header className="bar glass">
        <span
          className={"status-dot " + (connected ? "online" : "")}
          title={status}
          aria-hidden="true"
        />
        <span className="connection sr-only" role="status">
          {status}
        </span>
        {remoteOpen && allowRemote && (
          <span className="remote-mark" title="网页已打开，可遥控此电脑">
            <DeviceMobile />
          </span>
        )}
        <Tip label={audio === "active" ? "停止转录" : "开始转录"}>
          <Button
            size="sm"
            variant="ghost"
            className="record-button"
            isDisabled={!connected || audioBusy}
            onPress={() => void toggleAudio()}
          >
            {audioBusy ? (
              <>
                <Spinner size="sm" color="current" />
                {audio === "starting" ? "开启中" : "收尾中"}
              </>
            ) : audio === "active" ? (
              <>
                <span className="record-dot" aria-hidden="true" />
                <span className="clock">{clock(Date.now() - since)}</span>
                {audioSource === "remote" && (
                  <span className="source">网页</span>
                )}
              </>
            ) : (
              <>
                <Waveform />
                转录
              </>
            )}
          </Button>
        </Tip>
        <Tip label={captionsOn ? "关闭面试官字幕" : "显示面试官字幕"}>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={captionsOn ? "关闭面试官字幕" : "显示面试官字幕"}
            aria-pressed={captionsOn}
            onPress={() => setCaptionsOn(!captionsOn)}
          >
            <Subtitles weight={captionsOn ? "fill" : "regular"} />
          </Button>
        </Tip>
        <Tip label={"截图并同步（Ctrl+Alt+S）；Cue 回答附最近 8 张"}>
          <Button
            size="sm"
            variant="ghost"
            className="shot-button"
            aria-label="截图"
            isDisabled={!connected || working}
            onPress={() => void shot()}
          >
            {working ? <Spinner size="sm" color="current" /> : <Camera />}
            {selected.length > 0 && (
              <span className="shot-count">{selected.length}</span>
            )}
          </Button>
        </Tip>
        {sending ? (
          <Tip label={"停止生成"}>
            <Button
              size="sm"
              variant="secondary"
              className="answer-button"
              onPress={() => void attempt(() => cancelAnswer())}
            >
              <Stop weight="fill" />
              停止
            </Button>
          </Tip>
        ) : (
          <Tip label={"回答当前问题（Ctrl+Alt+Enter）"}>
            <Button
              size="sm"
              variant="primary"
              className="answer-button"
              isDisabled={!connected || working || audioBusy}
              onPress={() => void ask()}
            >
              <ArrowUp weight="bold" />
              回答
            </Button>
          </Tip>
        )}
        <span className="separator" aria-hidden="true" />
        <Tip label={"更多"}>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="更多"
            onPress={() => void more()}
          >
            <DotsThree weight="bold" />
          </Button>
        </Tip>
        <Tip label={expanded ? "收起" : "展开"}>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label={expanded ? "收起" : "展开"}
            onPress={() => setExpanded(!expanded)}
          >
            {expanded ? <CaretUp /> : <CaretDown />}
          </Button>
        </Tip>
      </header>
      {!connected && status !== "正在连接…" && (
        <div className="banner glass" role="status">
          <span>{status}</span>
          <Button
            size="sm"
            variant="secondary"
            className="reconnect"
            onPress={() => void reconnect()}
          >
            <ArrowClockwise />
            重新连接
          </Button>
        </div>
      )}
      {uploadError ? (
        <div className="notice error" role="alert">
          {uploadError}
          <Button
            size="sm"
            variant="ghost"
            onPress={() => uploadQueue.current!.retry()}
          >
            重试上传
          </Button>
        </div>
      ) : (
        uploading > 0 && (
          <div className="notice" role="status">
            {uploading} 张截图上传中
          </div>
        )
      )}
      {!uploadError && uploading === 0 && selected.length === 8 && (
        <div className="notice glass" role="status">
          截图已同步；Cue 回答附最近 8 张
        </div>
      )}
      {error && (
        <div className="notice glass" role="alert">
          <span>{error}</span>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="关闭提示"
            onPress={() => setError("")}
          >
            <X />
          </Button>
        </div>
      )}
      {captionsOn && audio === "active" && <CaptionStrip text={captionText} />}
      {expanded && (
        <section className="card glass" aria-label="回答">
          <>
            <div
              className="conversation exchange-view"
              ref={list}
              style={{ maxHeight: limit }}
              onScroll={() => {
                const el = list.current!;
                follow.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 70;
              }}
            >
              <div className="column">
                <OneExchange
                  messages={messages}
                  onTurn={(newest) => {
                    follow.current = newest;
                    if (list.current) list.current.scrollTop = 0;
                  }}
                />
              </div>
            </div>
            <div className="composer">
              {selected.length > 0 && (
                <div className="attachments">
                  {selected.map((id, index) => (
                    <div className="attachment" key={id}>
                      {previews[id] ? (
                        <img src={previews[id]} alt={"截图 " + (index + 1)} />
                      ) : (
                        <span>截图 {index + 1}</span>
                      )}
                      <button
                        aria-label="移除附件"
                        onClick={() =>
                          setSelected((s) => s.filter((x) => x !== id))
                        }
                      >
                        <X weight="bold" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="composer-row">
                <textarea
                  ref={input}
                  rows={1}
                  aria-label="追问或补充"
                  placeholder="追问或补充…"
                  value={text}
                  // The window takes keyboard focus only for typing here.
                  onPointerDown={() => void window.cue.focus?.(true)}
                  onBlur={() => void window.cue.focus?.(false)}
                  onChange={(e) => {
                    setText(e.target.value);
                    localStorage.setItem("cue.draft", e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setExpanded(false);
                      e.currentTarget.blur();
                    }
                    if (
                      e.key === "Enter" &&
                      (e.metaKey || e.ctrlKey) &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void ask();
                    }
                  }}
                />
                <kbd className="shortcut-hint">{shortcut}</kbd>
                {sending ? (
                  <Button
                    isIconOnly
                    size="sm"
                    variant="secondary"
                    className="send-button"
                    aria-label="停止生成"
                    onPress={() => void attempt(() => cancelAnswer())}
                  >
                    <Stop weight="fill" />
                  </Button>
                ) : (
                  <Button
                    isIconOnly
                    size="sm"
                    variant="primary"
                    className="send-button"
                    aria-label="回答"
                    isDisabled={!connected || working || audioBusy}
                    onPress={() => void ask()}
                  >
                    <ArrowUp weight="bold" />
                  </Button>
                )}
              </div>
            </div>
          </>
        </section>
      )}
    </div>
  );
}
