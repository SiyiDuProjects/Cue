import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dropdown, Label, Spinner, Tooltip } from "@heroui/react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  ArrowUp,
  CaretDown,
  Check,
  GearSix,
  Images,
  Plus,
  PushPin,
  PushPinSlash,
  Stop,
  Subtitles,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { type Event } from "./bridge";
import { MessageList, busy, shortcut, type Message } from "./Messages";
import "./styles.css";

const time = (value: number) =>
  new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Icon-only actions always carry a tooltip and an accessible name. */
function IconAction({
  label,
  onPress,
  isDisabled,
  pressed,
  className,
  children,
}: {
  label: string;
  onPress: () => void;
  isDisabled?: boolean;
  pressed?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Tooltip delay={400}>
      <Button
        isIconOnly
        size="sm"
        variant={pressed ? "secondary" : "ghost"}
        aria-label={label}
        aria-pressed={pressed}
        isDisabled={isDisabled}
        className={className}
        onPress={onPress}
      >
        {children}
      </Button>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip>
  );
}

type Chat = { id: string; title: string };
export default function App() {
  const [connected, setConnected] = useState(false),
    [status, setStatus] = useState("正在连接…"),
    [error, setError] = useState("");
  const [recording, setRecording] = useState(""),
    [chats, setChats] = useState<Chat[]>([]),
    [chat, setChat] = useState(localStorage.getItem("cue.chat") || ""),
    [messages, setMessages] = useState<Message[]>([]);
  const [turns, setTurns] = useState<Event[]>([]),
    [images, setImages] = useState<Event[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [previews, setPreviews] = useState<Record<string, string>>({});
  const [text, setText] = useState(""),
    [audio, setAudio] = useState("idle"),
    [working, setWorking] = useState(false),
    [pending, setPending] = useState("");
  const [panel, setPanel] = useState(""),
    [sources, setSources] = useState<Event[]>([]),
    [source, setSource] = useState(""),
    [sourceBusy, setSourceBusy] = useState(false),
    [effort, setEffort] = useState(localStorage.getItem("cue.effort") || ""),
    [pinned, setPinned] = useState(true),
    [imagePreview, setImagePreview] = useState("");
  const list = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    current = useRef({
      chat,
      text,
      selected,
      recording,
      connected,
      audio,
      pending,
      messages,
      effort,
    });
  current.current = {
    chat,
    text,
    selected,
    recording,
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
  function choose(id: string) {
    current.current.chat = id;
    setChat(id);
    localStorage.setItem("cue.chat", id);
    setText(localStorage.getItem("cue.draft." + id) || "");
    setMessages([]);
    follow.current = true;
    void attempt(() => command({ type: "history", chat: id }));
  }
  async function ask() {
    const s = current.current;
    if (
      !s.connected ||
      s.pending ||
      s.messages.some(busy) ||
      ["starting", "stopping"].includes(s.audio)
    )
      return;
    const id = crypto.randomUUID();
    current.current.pending = id;
    setPending(id);
    setError("");
    try {
      await command({
        type: "ask",
        id,
        chat: s.chat,
        text: s.text,
        images: s.selected,
        effort: s.effort || undefined,
      });
    } catch (e) {
      setPending("");
      setError(String(e));
    }
  }
  useEffect(() => {
    const listener = (event: globalThis.Event) => {
      const e = (event as CustomEvent).detail as Event;
      if (e.type === "session_ready" || e.type === "state") {
        setConnected(true);
        setStatus("已连接");
        setRecording(e.recording);
        setTurns(e.turns || []);
        setImages(e.images || []);
        setChats(e.chats || []);
        if (e.type === "session_ready") {
          setAudio("idle");
          setPending("");
          const id =
            e.chats?.find((c: Chat) => c.id === current.current.chat)?.id ??
            e.chats?.[0]?.id;
          if (id) choose(id);
          else void attempt(() => command({ type: "new_chat" }));
        }
      }
      if (e.type === "chat_created") {
        setChats((c) => [e.chat, ...c]);
        choose(e.chat.id);
      }
      if (e.type === "history" && e.chat === current.current.chat) {
        setMessages(e.messages);
        setPending("");
      }
      if (e.type === "answer" && e.message.chat === current.current.chat) {
        if (e.message.id === current.current.pending) {
          if (current.current.text === e.message.text) {
            setText("");
            localStorage.removeItem("cue.draft." + e.message.chat);
          }
          const used = JSON.parse(e.message.context || "{}").images || [];
          setSelected((s) => s.filter((id) => !used.includes(id)));
        }
        setPending("");
        setMessages((ms) =>
          ms.some((m) => m.id === e.message.id)
            ? ms.map((m) => (m.id === e.message.id ? e.message : m))
            : [...ms, e.message],
        );
      }
      if (e.type === "answer_delta")
        setMessages((ms) =>
          ms.map((m) =>
            m.id === e.id ? { ...m, answer: m.answer + e.delta } : m,
          ),
        );
      if (e.type === "transcript")
        setTurns((ts) =>
          [...ts.filter((t) => t.id !== e.turn.id), e.turn].sort(
            (a, b) => a.created - b.created || a.id.localeCompare(b.id),
          ),
        );
      if (e.type === "started") setAudio("active");
      if (e.type === "stopped") {
        setAudio("idle");
        if (!e.complete) setError("音频尾句未全部确认，请检查转录。");
      }
      if (e.type === "disconnected" || e.type === "replaced") {
        setConnected(false);
        setAudio("idle");
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
  const active = messages.find(busy),
    sending = !!active || !!pending;
  async function shot() {
    setWorking(true);
    await attempt(async () => {
      const image = await window.cue.screenshot(recording);
      if (!image) return;
      setImages((v) => [...v.filter((i) => i.id !== image.id), image]);
      setSelected((s) => [...s, image.id].slice(-8));
      if (image.image_url)
        setPreviews((p) => ({ ...p, [image.id]: image.image_url }));
    });
    setWorking(false);
  }
  async function toggleAudio() {
    if (audio === "starting" || audio === "stopping") return;
    const start = audio === "idle";
    setAudio(start ? "starting" : "stopping");
    try {
      await window.cue.audio(start);
    } catch (e) {
      setAudio("idle");
      setError(String(e));
    }
  }
  async function showPanel(name: string) {
    setPanel(panel === name ? "" : name);
    if (name === "settings" && panel !== name) {
      setSourceBusy(true);
      await attempt(async () => {
        const choices = await window.cue.sources();
        setSources(choices);
        setSource(choices.find((choice) => choice.selected)?.id || "");
      });
      setSourceBusy(false);
    }
  }
  async function selectSource(id: string) {
    setSourceBusy(true);
    await attempt(async () => {
      await window.cue.selectSource(id);
      setSource(id);
    });
    setSourceBusy(false);
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
  }  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    // Grow with the draft up to a few lines; the message list keeps the rest.
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 168) + "px";
  }, [text]);
  useEffect(() => {
    if (!panel) return;
    const close = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel("");
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [panel]);
  const chatTitle = chats.find((c) => c.id === chat)?.title || "聊天";
  const audioBusy = ["starting", "stopping"].includes(audio);

  return (
    <div className="cue-app">
      {imagePreview && (
        <div
          className="image-preview"
          role="dialog"
          aria-modal="true"
          aria-label="截图预览"
          onClick={() => setImagePreview("")}
          onKeyDown={(e) => {
            if (e.key === "Escape") setImagePreview("");
          }}
        >
          <Button
            isIconOnly
            variant="secondary"
            aria-label="关闭预览"
            className="image-preview-close"
            autoFocus
            onPress={() => setImagePreview("")}
          >
            <X />
          </Button>
          {previews[imagePreview] ? (
            <img src={previews[imagePreview]} alt="截图原图" />
          ) : (
            <Spinner size="sm" color="current" />
          )}
        </div>
      )}
      <header className="topbar">
        <span
          className={"status-dot " + (connected ? "online" : "")}
          aria-hidden="true"
        />
        <span className="connection sr-only" role="status">
          {status}
        </span>
        <Dropdown>
          <Button
            variant="ghost"
            size="sm"
            className="chat-trigger"
            aria-label="切换聊天"
            isDisabled={sending || !chats.length}
          >
            <span className="truncate">{chatTitle}</span>
            <CaretDown className="text-muted" />
          </Button>
          <Dropdown.Popover placement="bottom start" className="chat-menu">
            <Dropdown.Menu aria-label="聊天">
              {chats.map((c) => (
                <Dropdown.Item
                  key={c.id}
                  id={c.id}
                  textValue={c.title}
                  onAction={() => choose(c.id)}
                >
                  <Label className="truncate">{c.title}</Label>
                  {c.id === chat && <Check className="ml-auto text-accent" />}
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        <IconAction
          label="新聊天"
          isDisabled={!connected || sending}
          onPress={() => void attempt(() => command({ type: "new_chat" }))}
        >
          <Plus />
        </IconAction>
        <span className="flex-1" />
        <Button
          size="sm"
          variant={audio === "active" ? "danger-soft" : "ghost"}
          className={"record-button " + (audio === "active" ? "recording" : "")}
          isDisabled={!connected || audioBusy}
          onPress={() => void toggleAudio()}
        >
          {audioBusy ? (
            <Spinner size="sm" color="current" />
          ) : audio === "active" ? (
            <span className="record-dot" aria-hidden="true" />
          ) : (
            <Waveform />
          )}
          {audio === "active"
            ? "停止转录"
            : audio === "starting"
              ? "开启中"
              : audio === "stopping"
                ? "收尾中"
                : "开始转录"}
        </Button>
        <IconAction
          label="转录"
          pressed={panel === "transcript"}
          className="transcript-toggle"
          onPress={() => void showPanel("transcript")}
        >
          <Subtitles />
          {visibleTurns.length > 0 && (
            <span className="count-badge">{visibleTurns.length}</span>
          )}
        </IconAction>
        <IconAction
          label={pinned ? "取消置顶" : "置顶"}
          className={pinned ? "pin-on" : ""}
          onPress={() =>
            void attempt(async () => {
              await window.cue.pin(!pinned);
              setPinned(!pinned);
            })
          }
        >
          {pinned ? <PushPin weight="fill" /> : <PushPinSlash />}
        </IconAction>
        <IconAction
          label="设置"
          pressed={panel === "settings"}
          onPress={() => void showPanel("settings")}
        >
          <GearSix />
        </IconAction>
      </header>
      {!connected && status !== "正在连接…" && (
        <div className="banner" role="status">
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
        <div className="notice" role="alert">
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
      {panel === "settings" && (
        <>
          <div
            className="sheet-backdrop"
            aria-hidden="true"
            onClick={() => setPanel("")}
          />
          <section className="settings-sheet" aria-label="设置">
            <div className="field">
              <label htmlFor="effort">回答深度</label>
              <select
                id="effort"
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
              >
                <option value="">跟随网页设置</option>
                <option value="low">快速</option>
                <option value="medium">均衡</option>
                <option value="high">深入</option>
                <option value="xhigh">最深入</option>
              </select>
              <p className="hint">越深入，通常越慢。</p>
            </div>
            <div className="field">
              <label htmlFor="source">截图来源</label>
              <select
                id="source"
                value={source}
                disabled={sourceBusy}
                onChange={(e) => void selectSource(e.target.value)}
              >
                {!source && (
                  <option value="" disabled>
                    请选择截图来源
                  </option>
                )}
                {sources.map((s) => (
                  <option key={s.id} value={s.id} disabled={s.disabled}>
                    {s.name || s.title}
                  </option>
                ))}
              </select>
              {sources.some((s) => s.permission === "screen") && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="self-start"
                  onPress={() => void attempt(() => window.cue.openPrivacy!())}
                >
                  打开录屏权限设置
                  <ArrowSquareOut />
                </Button>
              )}
            </div>
            <div className="field">
              <label htmlFor="chat-title">聊天名称</label>
              <input
                id="chat-title"
                key={chat}
                defaultValue={chatTitle}
                maxLength={100}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && e.currentTarget.value.trim())
                    void attempt(() =>
                      command({
                        type: "rename_chat",
                        chat,
                        title: e.currentTarget.value,
                      }),
                    );
                }}
              />
              <p className="hint">按 Enter 保存。</p>
            </div>
            <div className="sheet-actions">
              <Button
                size="sm"
                variant="secondary"
                isDisabled={audio !== "idle" || sending || !connected}
                onPress={() =>
                  void attempt(() => command({ type: "new_recording" }))
                }
              >
                新一场转录
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => void attempt(() => window.cue.uploadMaterials())}
              >
                更新资料
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onPress={() => void attempt(() => window.cue.openSettings())}
              >
                网页设置
                <ArrowSquareOut />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onPress={() =>
                  void attempt(() => window.cue.importConnection())
                }
              >
                连接设置
              </Button>
            </div>
          </section>
        </>
      )}
      {panel === "transcript" ? (
        <section className="transcript" aria-label="转录">
          <div className="column">
            <div className="section-title">
              <h2>转录</h2>
              <span className="hint">最近一小时 · 电脑音频与麦克风分开记录</span>
            </div>
            {!visibleTurns.length && <p className="empty-note">还没有转录。</p>}
            {visibleTurns.map((t) => (
              <div className="turn" key={t.id}>
                <div className="turn-meta">
                  <span
                    className={
                      "speaker " + (t.speaker === "candidate" ? "me" : "them")
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
                            setImagePreview(i.id);
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
                              setImages((v) => v.filter((x) => x.id !== i.id));
                              setSelected((v) => v.filter((x) => x !== i.id));
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
        </section>
      ) : (
        <div
          className="conversation"
          ref={list}
          onScroll={() => {
            const el = list.current!;
            follow.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 70;
          }}
          aria-label="聊天记录"
        >
          <div className="column">
            <MessageList messages={messages} />
          </div>
        </div>
      )}
      <footer className="composer-dock">
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
          <textarea
            ref={input}
            rows={1}
            aria-label="补充问题"
            placeholder="补充问题，或直接回答当前问题…"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              localStorage.setItem("cue.draft." + chat, e.target.value);
            }}
            onKeyDown={(e) => {
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
          <div className="composer-actions">
            <Button
              size="sm"
              variant="ghost"
              className="shot-button"
              isDisabled={!connected || working}
              onPress={() => void shot()}
            >
              {working ? <Spinner size="sm" color="current" /> : <Images />}
              截图
            </Button>
            <span className="flex-1" />
            <kbd className="shortcut-hint">{shortcut}</kbd>
            {sending ? (
              <Button
                size="sm"
                variant="secondary"
                className="send-button"
                onPress={() =>
                  void attempt(() =>
                    command({ type: "cancel", id: active?.id || pending }),
                  )
                }
              >
                <Stop weight="fill" />
                停止
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                className="send-button"
                isDisabled={!connected || !chat || working || audioBusy}
                onPress={() => void ask()}
              >
                <ArrowUp weight="bold" />
                回答
              </Button>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
