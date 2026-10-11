import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Spinner } from "@heroui/react";
import {
  ArrowClockwise,
  ArrowLeft,
  ArrowUp,
  Camera,
  CaretDown,
  CaretUp,
  Check,
  DotsThree,
  Stop,
  Subtitles,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { type Event } from "./bridge";
import { OneExchange, busy, shortcut, type Message } from "./Messages";
import "./styles.css";

const time = (value: number) =>
  new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
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
/** Chinese and Japanese run sentences together; other scripts use a space. */
const joinCaptions = (parts: string[]) =>
  parts
    .map((t) => t.trim())
    .filter(Boolean)
    .reduce(
      (line, next) =>
        !line
          ? next
          : line +
            (line.charCodeAt(line.length - 1) >= 0x2e80 ? "" : " ") +
            next,
      "",
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
    [turns, setTurns] = useState<Event[]>([]),
    [images, setImages] = useState<Event[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [previews, setPreviews] = useState<Record<string, string>>({});
  const [text, setText] = useState(localStorage.getItem("cue.draft") || ""),
    [audio, setAudio] = useState("idle"),
    [since, setSince] = useState(0),
    [working, setWorking] = useState(false),
    [pending, setPending] = useState(""),
    [effort, setEffort] = useState(localStorage.getItem("cue.effort") || "");
  const [expanded, setExpanded] = useState(false),
    // "answer", "transcript" or "image:<id>" inside the card.
    [view, setView] = useState("answer"),
    [captionsOn, setCaptionsOn] = useState(
      localStorage.getItem("cue.captions") !== "off",
    ),
    [captions, setCaptions] = useState<{ item: string; text: string }[]>([]),
    [, tick] = useState(0);
  const root = useRef<HTMLDivElement>(null),
    list = useRef<HTMLDivElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    follow = useRef(true),
    // Answers are one timeline, the last hour, like transcripts. This is the
    // server row new answers are stored under: the newest chat, never shown.
    chat = useRef(""),
    current = useRef({
      text,
      selected,
      connected,
      audio,
      pending,
      messages,
      effort,
    });
  current.current = {
    text,
    selected,
    connected,
    audio,
    pending,
    messages,
    effort,
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
  const visibleTurns = turns.filter(
    (turn) => turn.text?.trim() || turn.status === "interrupted",
  );
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
  async function ask() {
    const s = current.current;
    if (
      !s.connected ||
      !chat.current ||
      s.pending ||
      s.messages.some(busy) ||
      ["starting", "stopping"].includes(s.audio)
    )
      return;
    const id = crypto.randomUUID();
    current.current.pending = id;
    setPending(id);
    setError("");
    setExpanded(true);
    setView("answer");
    try {
      await command({
        type: "ask",
        id,
        chat: chat.current,
        text: s.text,
        images: s.selected,
        effort: s.effort || undefined,
      });
    } catch (e) {
      setPending("");
      setError(String(e));
    }
  }
  async function shot() {
    setWorking(true);
    await attempt(async () => {
      const image = await window.cue.screenshot();
      if (!image) return;
      setImages((v) => [...v.filter((i) => i.id !== image.id), image]);
      setSelected((s) => [...s, image.id].slice(-8));
      if (image.image_url)
        setPreviews((p) => ({ ...p, [image.id]: image.image_url }));
    });
    setWorking(false);
  }
  useEffect(() => {
    const listener = (event: globalThis.Event) => {
      const e = (event as CustomEvent).detail as Event;
      if (e.type === "session_ready" || e.type === "state") {
        setConnected(true);
        setStatus("已连接");
        setTurns(e.turns || []);
        setImages(e.images || []);
        if (e.type === "session_ready") {
          setAudio("idle");
          setSince(0);
          setPending("");
          // The server lists chats newest first.
          if (e.chats?.[0]?.id) use(e.chats[0].id);
          else void attempt(() => command({ type: "new_chat" }));
        }
      }
      if (e.type === "chat_created") use(e.chat.id);
      // A server without the timeline answers for the chat instead.
      if (
        e.type === "history" &&
        (e.scope === "recent" || e.chat === chat.current)
      ) {
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
      if (e.type === "transcript")
        setTurns((ts) =>
          [...ts.filter((t) => t.id !== e.turn.id), e.turn].sort(
            (a, b) => a.created - b.created || a.id.localeCompare(b.id),
          ),
        );
      // Display only: from the local transcription stream, never the server.
      if (e.type === "caption" && current.current.audio !== "idle")
        setCaptions((cs) =>
          cs.some((c) => c.item === e.item)
            ? cs.map((c) => (c.item === e.item ? { ...c, text: e.text } : c))
            : [...cs, { item: e.item, text: e.text }].slice(-3),
        );
      if (e.type === "started") {
        setAudio("active");
        setSince(Date.now());
        setCaptions([]);
      }
      if (e.type === "stopped") {
        setAudio("idle");
        setSince(0);
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
  }, [text, expanded, view]);
  const active = messages.find(busy),
    sending = !!active || !!pending,
    audioBusy = ["starting", "stopping"].includes(audio),
    captionText = joinCaptions(captions.map((c) => c.text)),
    // Beyond half the screen the answer scrolls inside the card.
    limit = Math.round(screen.availHeight * 0.5);
  async function toggleAudio() {
    if (audioBusy) return;
    const start = audio === "idle";
    setAudio(start ? "starting" : "stopping");
    try {
      await window.cue.audio(start);
    } catch (e) {
      setAudio("idle");
      setError(String(e));
    }
  }
  async function preview(id: string) {
    if (previews[id]) return;
    await attempt(async () => {
      const v = await window.cue.request("/capture/images/" + id);
      setPreviews((p) => ({
        ...p,
        [id]: "data:" + v.mimeType + ";base64," + v.data,
      }));
    });
  }
  /** The native menu returns a choice; hiding, quitting and links stay native. */
  async function more() {
    const choice = await attempt(() => window.cue.menu!({ effort }));
    if (!choice) return;
    if (typeof choice.effort === "string") setEffort(choice.effort);
    else if (choice.source)
      void attempt(() => window.cue.selectSource(choice.source));
    else if (choice.action === "transcript") {
      setExpanded(true);
      setView("transcript");
    } else if (choice.action === "materials")
      void attempt(() => window.cue.uploadMaterials());
    else if (choice.action === "connection")
      void attempt(() => window.cue.importConnection());
    else if (choice.action === "privacy")
      void attempt(() => window.cue.openPrivacy!());
  }
  const image = view.startsWith("image:") ? view.slice(6) : "";

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
        <Tip label={"截图（Ctrl+Alt+S），随下一次提问发送"}>
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
              onPress={() =>
                void attempt(() =>
                  command({ type: "cancel", id: active?.id || pending }),
                )
              }
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
      {captionsOn && audio === "active" && (
        <div
          className={"captions glass" + (captionText ? "" : " waiting")}
          aria-label="面试官字幕"
        >
          <p>{captionText || "等待面试官说话…"}</p>
        </div>
      )}
      {expanded && (
        <section className="card glass" aria-label="回答">
          {view === "transcript" ? (
            <div className="transcript" style={{ maxHeight: limit }}>
              <div className="column">
                <div className="card-head">
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() => setView("answer")}
                  >
                    <ArrowLeft />
                    回答
                  </Button>
                  <span className="hint">最近一小时 · 两路分开记录</span>
                </div>
                {!visibleTurns.length && (
                  <p className="empty-note">还没有转录。</p>
                )}
                {visibleTurns.map((t) => (
                  <div className="turn" key={t.id}>
                    <div className="turn-meta">
                      <span
                        className={
                          "speaker " +
                          (t.speaker === "candidate" ? "me" : "them")
                        }
                      >
                        {t.speaker === "candidate" ? "我" : "对方"}
                      </span>
                      <span>{time(t.created)}</span>
                      {t.status === "partial" && <span>转录中</span>}
                      {t.status === "interrupted" && <span>未完整确认</span>}
                    </div>
                    <p>{t.text || "…"}</p>
                  </div>
                ))}
                {images.length > 0 && (
                  <>
                    <div className="section-title">
                      <h2>截图</h2>
                      <span className="hint">点选后随下一次提问发送</span>
                    </div>
                    <div className="image-library">
                      {images.map((i) => (
                        <div className="saved-image" key={i.id}>
                          <button
                            className="thumb"
                            aria-pressed={selected.includes(i.id)}
                            onClick={() => {
                              setSelected((s) =>
                                s.includes(i.id)
                                  ? s.filter((id) => id !== i.id)
                                  : [...s, i.id].slice(-8),
                              );
                              void preview(i.id);
                            }}
                          >
                            {previews[i.id] ? (
                              <img src={previews[i.id]} alt="手动截图" />
                            ) : (
                              <span>{time(i.created)}</span>
                            )}
                            {selected.includes(i.id) && (
                              <span className="thumb-check">
                                <Check weight="bold" />
                              </span>
                            )}
                          </button>
                          <div className="image-actions">
                            <Button
                              size="sm"
                              variant="ghost"
                              onPress={() => {
                                void preview(i.id);
                                setView("image:" + i.id);
                              }}
                            >
                              查看
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={sending}
                              onPress={() =>
                                void attempt(async () => {
                                  await window.cue.request(
                                    "/capture/images/" + i.id,
                                    "DELETE",
                                  );
                                  setImages((v) =>
                                    v.filter((x) => x.id !== i.id),
                                  );
                                  setSelected((v) =>
                                    v.filter((x) => x !== i.id),
                                  );
                                })
                              }
                            >
                              移除
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : image ? (
            <div className="image-full" style={{ maxHeight: limit }}>
              <div className="card-head">
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() => setView("transcript")}
                >
                  <ArrowLeft />
                  返回
                </Button>
              </div>
              {previews[image] ? (
                <img src={previews[image]} alt="截图原图" />
              ) : (
                <Spinner size="sm" color="current" />
              )}
            </div>
          ) : (
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
                      onPress={() =>
                        void attempt(() =>
                          command({
                            type: "cancel",
                            id: active?.id || pending,
                          }),
                        )
                      }
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
          )}
        </section>
      )}
    </div>
  );
}
