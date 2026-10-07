import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { type Event } from "./bridge";
import "./styles.css";
import "katex/dist/katex.min.css";
type Chat = { id: string; title: string };
type Message = {
  id: string;
  chat: string;
  text: string;
  answer: string;
  status: string;
  detail: string;
  context?: string;
};
const busy = (m: Message) => ["preparing", "running"].includes(m.status);
export default function App() {
  const [connected, setConnected] = useState(false),
    [status, setStatus] = useState("正在连接…"),
    [error, setError] = useState("");
  const [recording, setRecording] = useState(""),
    [chats, setChats] = useState<Chat[]>([]),
    [chat, setChat] = useState(""),
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
  function choose(id: string) {
    current.current.chat = id;
    setChat(id);
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
    void attempt(() => window.cue.connect());
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
    if (name === "settings")
      await attempt(async () => setSources(await window.cue.sources()));
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
  return (
    <main className="shell">
      {imagePreview && (
        <div
          className="image-preview"
          role="dialog"
          aria-modal="true"
          aria-label="截图预览"
          onKeyDown={(e) => {
            if (e.key === "Escape") setImagePreview("");
          }}
        >
          <button autoFocus onClick={() => setImagePreview("")}>
            关闭
          </button>
          {previews[imagePreview] ? (
            <img src={previews[imagePreview]} alt="截图原图" />
          ) : (
            <span>正在读取…</span>
          )}
        </div>
      )}
      <header className="topbar">
        <span className="brand">
          Cue
          <span className={"dot " + (connected ? "online" : "")} />
        </span>
        <select
          aria-label="聊天"
          value={chat}
          disabled={sending}
          onChange={(e) => choose(e.target.value)}
        >
          <option value="" disabled>
            聊天
          </option>
          {chats.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <button
          className="icon"
          title="新聊天"
          aria-label="新聊天"
          disabled={!connected || sending}
          onClick={() => void attempt(() => command({ type: "new_chat" }))}
        >
          ＋
        </button>
        <span className="spacer" />
        <button
          className={"icon " + (pinned ? "chosen" : "")}
          title="置顶"
          aria-label="置顶"
          aria-pressed={pinned}
          onClick={() =>
            void attempt(async () => {
              await window.cue.pin(!pinned);
              setPinned(!pinned);
            })
          }
        >
          ⌁
        </button>
        <button
          className="icon"
          title="设置"
          aria-label="设置"
          onClick={() => void showPanel("settings")}
        >
          ⚙
        </button>
      </header>
      <div className="capturebar">
        <button
          className={"record " + (audio === "active" ? "recording" : "")}
          disabled={!connected || ["starting", "stopping"].includes(audio)}
          onClick={() => void toggleAudio()}
        >
          <span />
          {audio === "active"
            ? "停止转录"
            : audio === "starting"
              ? "正在开启…"
              : audio === "stopping"
                ? "正在收尾…"
                : "开始转录"}
        </button>
        <button
          className={panel === "transcript" ? "chosen" : ""}
          onClick={() => void showPanel("transcript")}
        >
          转录 <small>{turns.length || ""}</small>
        </button>
        <span className="spacer" />
        <span className="connection">{status}</span>
      </div>
      {error && (
        <div className="notice" role="alert">
          <span>{error}</span>
          <button aria-label="关闭提示" onClick={() => setError("")}>
            ×
          </button>
        </div>
      )}
      {panel === "settings" && (
        <section className="panel settings" aria-label="设置">
          <div>
            <label htmlFor="effort">回答深度</label>
            <select
              id="effort"
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
            >
              <option value="">跟随网页设置</option>
              <option value="low">快速 · low</option>
              <option value="medium">均衡 · medium</option>
              <option value="high">深入 · high</option>
              <option value="xhigh">最深入 · xhigh</option>
            </select>
          </div>
          <p className="hint">更深入，通常更慢。</p>
          <div>
            <label htmlFor="source">截图来源</label>
            <select
              id="source"
              onChange={(e) =>
                void attempt(() => window.cue.selectSource(e.target.value))
              }
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.title}
                </option>
              ))}
            </select>
          </div>
          <div className="actions">
            <button
              onClick={() => void attempt(() => window.cue.openSettings())}
            >
              网页设置 ↗
            </button>
            <button
              onClick={() => void attempt(() => window.cue.uploadMaterials())}
            >
              更新个人资料…
            </button>
            <button
              onClick={() => void attempt(() => window.cue.importConnection())}
            >
              连接设置…
            </button>
            <button
              disabled={audio !== "idle" || sending || !connected}
              onClick={() =>
                void attempt(() => command({ type: "new_recording" }))
              }
            >
              新一场转录
            </button>
          </div>
          <div>
            <input
              aria-label="聊天名称"
              placeholder="重命名当前聊天"
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
            <span className="hint">Enter 保存</span>
          </div>
        </section>
      )}
      {panel === "transcript" ? (
        <section className="transcript" aria-label="转录">
          <h2>本场转录</h2>
          <p className="hint">最近一小时 · 系统音频和麦克风分别记录</p>
          {!turns.length && <p className="empty-note">暂无转录</p>}
          {turns.map((t) => (
            <div className="turn" key={t.id}>
              <span>
                {t.speaker === "candidate" ? "我" : "对方"} ·{" "}
                {new Date(t.created).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              <p>
                {t.text || "…"}
                {t.status === "partial" && <small> · 转录中</small>}
                {t.status === "interrupted" && <small> · 未完整确认</small>}
              </p>
            </div>
          ))}
          {images.length > 0 && (
            <>
              <h2>截图</h2>
              <div className="image-library">
                {images.map((i) => (
                  <div className="saved-image" key={i.id}>
                    <button
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
                        <span>
                          截图 · {new Date(i.created).toLocaleTimeString()}
                        </span>
                      )}
                    </button>
                    <div className="image-actions">
                      <button
                        onClick={() => {
                          void preview(i.id);
                          setImagePreview(i.id);
                        }}
                      >
                        查看
                      </button>
                      <button
                        disabled={sending}
                        onClick={() =>
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
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
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
          {!messages.length && (
            <div className="welcome">
              <div className="cue-symbol">
                c<span>ue</span>
              </div>
              <span className="shortcut">⌘ / Ctrl + Enter</span>
            </div>
          )}
          {messages.map((m) => (
            <article className="exchange" key={m.id}>
              <div className="user-message">
                {m.text || "回答当前问题"}
                {m.context && JSON.parse(m.context).images?.length > 0 && (
                  <small> · {JSON.parse(m.context).images.length} 张截图</small>
                )}
              </div>
              <div className="assistant-message">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                >
                  {m.answer}
                </ReactMarkdown>
                {busy(m) && (
                  <div className="thinking" role="status">
                    <span />
                    {m.answer ? "正在回答" : "正在思考…"}
                  </div>
                )}
                {m.detail && <p className="hint">{m.detail}</p>}
                {m.answer && (
                  <button
                    className="copy"
                    onClick={() =>
                      void attempt(() => window.cue.copy(m.answer))
                    }
                  >
                    复制
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <footer className="composer">
        <div className="attachments">
          {selected.map((id, index) => (
            <div key={id}>
              {previews[id] ? (
                <img src={previews[id]} alt={"截图 " + (index + 1)} />
              ) : (
                <span>截图 {index + 1}</span>
              )}
              <button
                aria-label="移除附件"
                onClick={() => setSelected((s) => s.filter((x) => x !== id))}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <textarea
          aria-label="补充问题"
          placeholder="输入问题…"
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
          <button disabled={!connected || working} onClick={() => void shot()}>
            {working ? "截图中…" : "＋ 截图"}
          </button>
          <span className="hint">
            {selected.length ? selected.length + " 张截图" : ""}
          </span>
          <span className="spacer" />
          {sending ? (
            <button
              className="primary stop"
              onClick={() =>
                void attempt(() =>
                  command({ type: "cancel", id: active?.id || pending }),
                )
              }
            >
              停止
            </button>
          ) : (
            <button
              className="primary"
              disabled={
                !connected ||
                !chat ||
                working ||
                audio === "starting" ||
                audio === "stopping"
              }
              onClick={() => void ask()}
            >
              回答 <span>↵</span>
            </button>
          )}
        </div>
      </footer>
    </main>
  );
}
