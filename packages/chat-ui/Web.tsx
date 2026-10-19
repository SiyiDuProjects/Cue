import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Dropdown, Spinner } from "@heroui/react";
import {
  ArrowUp,
  Camera,
  Check,
  DotsThree,
  Stop,
  Waveform,
  X,
} from "@phosphor-icons/react";
import { OneExchange, shortcut, type Message } from "./Messages";
import { CaptionStrip, joinCaptions } from "./Captions";
import "./styles.css";

/**
 * The web page: the overlay's control bar, captions and answer card in a
 * browser. Each button queues one command for the desktop, which runs it as
 * its own button press; answers are read back as the server saves them.
 */
type Desktop = {
  generation: string;
  online: boolean;
  supported: boolean;
  allow: boolean;
  phase: string;
  since: number;
  uploading: number;
  upload_error: string;
  pending: string;
  error: string;
};
type Answer = Message & { created: number; updated: number };
type Receipt = {
  id: string;
  status: string;
  detail: string;
  result: { answer?: string };
};
type View = {
  desktop: Desktop;
  captions: { id: string; text: string; created: number }[];
  attachments: { id: string; created: number }[];
  answers: Answer[];
  commands: (Receipt | null)[];
  now: number;
};

const EFFORTS = [
  ["", "跟随网页设置"],
  ["low", "快速"],
  ["medium", "均衡"],
  ["high", "深入"],
  ["xhigh", "最深入"],
];
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000)),
    pad = (n: number) => String(n).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`
    : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
};
// Answers save every 2 seconds while generating; one that stops saving for
// 20 seconds lost its connection. Polling never writes, so the page decides.
const stalled = (a: Answer, now: number) =>
  ["preparing", "running"].includes(a.status) && a.updated < now - 20000;
const stored = (key: string) => {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
async function api(method: string, body?: object, query = "") {
  const r = await fetch("/api/remote" + query, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(value.detail || "请登录后重试。");
  return value;
}
const Tip = ({ label, children }: { label: string; children: ReactNode }) => (
  <span className="tip" title={label}>
    {children}
  </span>
);

export default function Web() {
  const [view, setView] = useState<View | null>(null),
    [answers, setAnswers] = useState<Record<string, Answer>>({}),
    // command id → type, until its receipt settles
    [pending, setPending] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [text, setText] = useState(stored("cue.draft")),
    [effort, setEffort] = useState(stored("cue.effort")),
    [, tick] = useState(0);
  const after = useRef(0),
    waiting = useRef(pending),
    refreshing = useRef(false),
    drafts = useRef<Record<string, string>>({}),
    textNow = useRef(text);
  textNow.current = text;
  waiting.current = pending;

  function settle(receipts: (Receipt | null)[]) {
    const done = receipts.filter(
      (r): r is Receipt =>
        !!r &&
        !!waiting.current[r.id] &&
        !["queued", "running"].includes(r.status),
    );
    if (!done.length) return;
    setPending((p) => {
      const next = { ...p };
      for (const r of done) delete next[r.id];
      return next;
    });
    for (const r of done) {
      if (
        r.status === "completed" &&
        r.result.answer &&
        drafts.current[r.id] === textNow.current
      )
        setText("");
      delete drafts.current[r.id];
    }
    const failed = done.find((r) => r.status !== "completed");
    if (failed) setError(failed.detail || "电脑未完成操作。");
  }
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      // The server reads at most eight receipts per request; the rest follow.
      const ids = Object.keys(waiting.current).slice(0, 8);
      const v: View = await api(
        "GET",
        undefined,
        "?after=" +
          after.current +
          (ids.length ? "&commands=" + ids.join(",") : ""),
      );
      setView(v);
      if (v.answers.length) {
        after.current = Math.max(
          after.current,
          ...v.answers.map((a) => a.updated),
        );
        setAnswers((old) => {
          const next = { ...old };
          for (const a of v.answers) next[a.id] = a;
          for (const [id, a] of Object.entries(next))
            if (a.created < v.now - 3600000) delete next[id];
          return next;
        });
      }
      settle(v.commands);
    } finally {
      refreshing.current = false;
    }
  }
  async function send(type: string, extra: object = {}) {
    const d = view?.desktop;
    if (!d?.online) {
      setError("电脑未连接。");
      return false;
    }
    const id = crypto.randomUUID();
    if (type === "ask") drafts.current[id] = textNow.current;
    setPending((p) => ({ ...p, [id]: type }));
    waiting.current = { ...waiting.current, [id]: type };
    setError("");
    try {
      settle([
        await api("POST", { id, type, generation: d.generation, ...extra }),
      ]);
      return true;
    } catch (e) {
      setPending((p) => {
        const { [id]: _, ...rest } = p;
        return rest;
      });
      setError(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  // Poll while the page is visible: faster while something is in flight.
  const list = Object.values(answers).sort(
    (a, b) => a.created - b.created || a.id.localeCompare(b.id),
  );
  const now = view?.now ?? Date.now(),
    messages: Message[] = list.map((a) =>
      stalled(a, now)
        ? {
            ...a,
            status: "interrupted",
            detail: a.detail || "连接中断，未自动重发。",
          }
        : a,
    );
  const generating =
      !!view?.desktop.pending ||
      messages.some((m) => ["preparing", "running"].includes(m.status)),
    active = generating || Object.keys(pending).length > 0;
  useEffect(() => {
    let stop = false,
      timer = 0;
    const loop = async () => {
      if (stop || document.hidden) return;
      try {
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
      if (!stop) timer = window.setTimeout(loop, active ? 700 : 1500);
    };
    const visible = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      void loop();
    };
    void loop();
    document.addEventListener("visibilitychange", visible);
    return () => {
      stop = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active]);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("cue.draft", text);
      localStorage.setItem("cue.effort", effort);
    } catch {}
  }, [text, effort]);

  const d = view?.desktop,
    usable = !!d?.online && d.supported && d.allow,
    audio = d?.phase ?? "idle",
    audioBusy = ["starting", "stopping"].includes(audio),
    types = Object.values(pending),
    shooting = types.includes("shot"),
    asking = types.includes("ask");
  const status = !view
    ? "正在连接…"
    : !d!.online
      ? "电脑未连接"
      : !d!.supported
        ? "电脑上的 Cue 需要更新"
        : !d!.allow
          ? "电脑上已关闭遥控"
          : "已连接";
  // The server sends the interviewer's last ten minutes while transcribing.
  const caption = joinCaptions((view?.captions ?? []).map((c) => c.text));
  async function ask() {
    if (asking || generating) return;
    await send("ask", { text: text.trim(), ...(effort ? { effort } : {}) });
  }

  return (
    <div className="overlay web">
      <header className="bar glass">
        <span
          className={"status-dot " + (usable ? "online" : "")}
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
            isDisabled={
              !usable ||
              audioBusy ||
              types.includes("start") ||
              types.includes("stop")
            }
            onPress={() => void send(audio === "active" ? "stop" : "start")}
          >
            {audioBusy ? (
              <>
                <Spinner size="sm" color="current" />
                {audio === "starting" ? "开启中" : "收尾中"}
              </>
            ) : audio === "active" ? (
              <>
                <span className="record-dot" aria-hidden="true" />
                <span className="clock">{clock(Date.now() - d!.since)}</span>
              </>
            ) : (
              <>
                <Waveform />
                转录
              </>
            )}
          </Button>
        </Tip>
        <Tip label="截图并同步；Cue 回答附最近 8 张">
          <Button
            size="sm"
            variant="ghost"
            className="shot-button"
            aria-label="截图"
            isDisabled={!usable}
            onPress={() => void send("shot")}
          >
            {shooting ? <Spinner size="sm" color="current" /> : <Camera />}
            {(view?.attachments.length ?? 0) > 0 && (
              <span className="shot-count">{view!.attachments.length}</span>
            )}
          </Button>
        </Tip>
        {generating ? (
          <Tip label="停止生成">
            <Button
              size="sm"
              variant="secondary"
              className="answer-button"
              onPress={() => void send("cancel")}
            >
              <Stop weight="fill" />
              停止
            </Button>
          </Tip>
        ) : (
          <Tip label={"回答当前问题（" + shortcut + "）"}>
            <Button
              size="sm"
              variant="primary"
              className="answer-button"
              isDisabled={!usable || asking || audioBusy}
              onPress={() => void ask()}
            >
              <ArrowUp weight="bold" />
              回答
            </Button>
          </Tip>
        )}
        <span className="separator" aria-hidden="true" />
        <Dropdown>
          <Button isIconOnly size="sm" variant="ghost" aria-label="更多">
            <DotsThree weight="bold" />
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label="更多"
              onAction={(key) => {
                const k = String(key);
                if (k === "settings") location.href = "/settings";
                else if (k === "materials")
                  location.href = "/settings#materials";
                else setEffort(k.slice(7));
              }}
            >
              <Dropdown.Section aria-label="推理深度">
                {EFFORTS.map(([value, label]) => (
                  <Dropdown.Item
                    key={value}
                    id={"effort:" + value}
                    textValue={label}
                  >
                    <span className="menu-check">
                      {effort === value && <Check />}
                    </span>
                    {label}
                  </Dropdown.Item>
                ))}
              </Dropdown.Section>
              <Dropdown.Section aria-label="设置">
                <Dropdown.Item id="settings" textValue="回答设置">
                  <span className="menu-check" />
                  回答设置
                </Dropdown.Item>
                <Dropdown.Item id="materials" textValue="个人资料">
                  <span className="menu-check" />
                  个人资料
                </Dropdown.Item>
              </Dropdown.Section>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      </header>
      {view && !usable && (
        <div className="banner glass" role="status">
          <span>{status}</span>
        </div>
      )}
      {(error || d?.error) && (
        <div className="notice glass" role="alert">
          <span>{error || d?.error}</span>
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
      {audio === "active" && <CaptionStrip text={caption} />}
      {view?.attachments.length === 8 && !d?.uploading && !d?.upload_error && (
        <div className="notice glass" role="status">
          截图已同步；Cue 回答附最近 8 张
        </div>
      )}
      <section className="card glass" aria-label="回答">
        <div className="conversation exchange-view">
          <div className="column">
            <OneExchange messages={messages} />
          </div>
        </div>
        {!messages.length && (
          <p className="empty-note">点「回答」，用最近的转录和截图生成回答。</p>
        )}
        <div className="composer">
          {((view?.attachments.length ?? 0) > 0 ||
            !!d?.uploading ||
            !!d?.upload_error) && (
            <div className="attachments">
              {view!.attachments.map((a, index) => (
                <div className="attachment" key={a.id}>
                  <img
                    src={"/api/remote/images/" + encodeURIComponent(a.id)}
                    alt={"截图 " + (index + 1)}
                  />
                  <button
                    aria-label="移除附件"
                    onClick={() => void send("unselect", { image: a.id })}
                  >
                    <X weight="bold" />
                  </button>
                </div>
              ))}
              {!!d?.uploading && (
                <div className="attachment uploading">
                  <Spinner size="sm" color="current" />
                  <span>{d.uploading}</span>
                </div>
              )}
              {!!d?.upload_error && (
                <span className="upload-error">{d.upload_error}</span>
              )}
            </div>
          )}
          <div className="composer-row">
            <textarea
              rows={1}
              aria-label="追问或补充"
              placeholder="追问或补充…"
              value={text}
              onChange={(e) => setText(e.target.value)}
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
            {generating ? (
              <Button
                isIconOnly
                size="sm"
                variant="secondary"
                className="send-button"
                aria-label="停止生成"
                onPress={() => void send("cancel")}
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
                isDisabled={!usable || asking || audioBusy}
                onPress={() => void ask()}
              >
                <ArrowUp weight="bold" />
              </Button>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
