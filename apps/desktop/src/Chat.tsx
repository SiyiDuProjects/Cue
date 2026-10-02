import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Disclosure, Modal, Typography } from "@heroui/react";
import { ChatAttachment, ChatAttachmentGroup } from "@heroui-pro/react/chat-attachment";
import { ChatMessage } from "@heroui-pro/react/chat-message";
import { PromptInput } from "@heroui-pro/react/prompt-input";
import { NativeSelect } from "@heroui-pro/react/native-select";
import { ArrowUp, Monitor, Square } from "@phosphor-icons/react";
import { AnswerMarkdown, CopyTextButton } from "./AnswerMarkdown";
import type { AgentActivity, AnswerStore, CapturedScreen, ChatRequest, OperationRecord } from "./types";

const answerProfiles = { default: "通用", brief: "临场短答", ood: "对象设计 / OOD" };
// Older messages and clients may still use the equivalent LC profile.
const currentProfile = (profile: ChatRequest["profile"]): keyof typeof answerProfiles => profile === "lc" ? "default" : profile || "default";

function Activity({ entries }: { entries: AgentActivity[] }) {
  const running = [...entries].reverse().find(entry => entry.status === "running");
  const labels = { running: "进行中", completed: "已完成", failed: "未成功", interrupted: "已中断" };
  return <Disclosure className="sage-chat-activity">
    <Disclosure.Heading><Button slot="trigger" size="sm" variant="ghost">
      <span>{running ? running.label : `查看过程 · ${entries.length} 项`}</span><Disclosure.Indicator />
    </Button></Disclosure.Heading>
    <Disclosure.Content><Disclosure.Body><ul>
      {entries.map(entry => <li key={entry.id}><span>{entry.label}</span><span>{labels[entry.status]}</span></li>)}
    </ul></Disclosure.Body></Disclosure.Content>
  </Disclosure>;
}

function Attachments({ screens, remove }: { screens: CapturedScreen[]; remove?: (id: string) => void }) {
  const [preview, setPreview] = useState<CapturedScreen | null>(null);
  return <>
    <ChatAttachmentGroup className="sage-chat-attachments">
      {screens.map((screen, i) => <ChatAttachment key={screen.request_id} mediaType="image" name={`截图 ${i + 1}`} src={screen.image_url}>
        <button className="sage-screenshot-preview" type="button" aria-label={`查看截图 ${i + 1}`} onClick={() => setPreview(screen)}>
          <ChatAttachment.Preview />
        </button>
        {remove && <ChatAttachment.Remove aria-label={`移除截图 ${i + 1}`} onPress={() => remove(screen.request_id)} />}
      </ChatAttachment>)}
    </ChatAttachmentGroup>
    <Modal isOpen={!!preview} onOpenChange={open => { if (!open) setPreview(null); }}><Modal.Backdrop>
      <Modal.Container size="full"><Modal.Dialog className="sage-image-dialog" aria-label="截图预览"><Modal.CloseTrigger aria-label="关闭截图" />
        <Modal.Body>{preview && <img src={preview.image_url} alt="消息附带的截图" />}</Modal.Body>
      </Modal.Dialog></Modal.Container>
    </Modal.Backdrop></Modal>
  </>;
}

export function ChatMessages({ messages, answers, operations, busy }: {
  messages: ChatRequest[]; answers: AnswerStore; operations: OperationRecord[]; busy: boolean;
}) {
  const shown = new Set(messages.map(message => message.response_id));
  function assistant(id: string, operation?: OperationRecord) {
    const answer = answers.byId[id];
    const pending = operation && ["sent", "accepted", "running"].includes(operation.status);
    if (!answer?.text && !answer?.activities?.length && !pending && !["failed", "cancelled"].includes(operation?.status || "")) return null;
    return <ChatMessage.Assistant data-answer-id={id} className="sage-assistant-message" key={id}>
      <ChatMessage.Body><ChatMessage.Content>
        {!!answer?.activities?.length && <Activity entries={answer.activities} />}
        {answer?.text ? <Typography.Prose><AnswerMarkdown text={answer.text} streaming={answer.status === "streaming"} /></Typography.Prose>
          : pending ? <p className="sage-chat-pending" role="status">思考中<span aria-hidden="true">…</span></p> : null}
        {(answer?.status === "interrupted" || answer?.status === "error" || ["failed", "cancelled"].includes(operation?.status || "")) &&
          <p className="preview-muted" role="status">{answer?.detail || operation?.detail || "回答未完成"}</p>}
      </ChatMessage.Content>
      {answer?.text && answer.status !== "streaming" && <ChatMessage.Actions><CopyTextButton text={answer.text} label="复制回答" /></ChatMessage.Actions>}
      </ChatMessage.Body>
    </ChatMessage.Assistant>;
  }
  return <>
    {messages.map(message => <div className="sage-chat-turn" key={message.message_id}>
      <ChatMessage.User><ChatMessage.Bubble>
        {message.provider === "responses" && <p className="sage-answer-origin">Responses API · {answerProfiles[currentProfile(message.profile)]}</p>}
        {message.screens.length > 0 && <Attachments screens={message.screens} />}
        <ChatMessage.Content><p className="sage-user-text">{message.text}</p></ChatMessage.Content>
      </ChatMessage.Bubble></ChatMessage.User>
      {assistant(message.response_id, operations.find(op => op.operation_id === message.message_id))}
    </div>)}
    {answers.order.filter(id => !shown.has(id)).map(id => assistant(id))}
    {!messages.length && !answers.order.length && !busy && <div className="sage-chat-empty">
      <h1>需要时，再问我。</h1><p>面试对话会自动带入。截图、提问，或直接点「回答」。</p>
    </div>}
  </>;
}

export function ChatComposer({ enabled, busy, screenshotBusy, screens, messages, operations, dispatch, onCapture, onSent, more, draftKey }: {
  draftKey?: string;
  enabled: boolean; busy: boolean; screenshotBusy: boolean; screens: CapturedScreen[];
  messages: ChatRequest[]; operations: OperationRecord[];
  dispatch: (payload: Record<string, unknown>) => string | null;
  onCapture: () => void; onSent: () => void; more: ReactNode;
}) {
  const latest = messages.at(-1);
  const [provider, setProvider] = useState<"codex" | "responses">(latest ? latest.provider || "codex" : "responses");
  const [profile, setProfile] = useState(() => currentProfile(latest?.profile));
  useEffect(() => {
    if (latest) { setProvider(latest.provider || "codex"); setProfile(currentProfile(latest.profile)); }
  }, [latest?.message_id]);
  const [draft, setDraft] = useState(() => {
    try { return draftKey ? localStorage.getItem(`sage-draft:${draftKey}`) || "" : ""; } catch { return ""; }
  });
  useEffect(() => {
    if (!draftKey) return;
    try {
      if (draft) localStorage.setItem(`sage-draft:${draftKey}`, draft);
      else localStorage.removeItem(`sage-draft:${draftKey}`);
    } catch { /* The composer remains usable if local storage is unavailable. */ }
  }, [draft, draftKey]);
  const pending = useRef<{ id: string; text: string } | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    const sent = pending.current;
    if (!sent) return;
    if (messages.some(message => message.message_id === sent.id)) {
      setDraft(current => current === sent.text ? "" : current);
      pending.current = null; setSending(false);
    } else if (operations.some(op => op.operation_id === sent.id && ["failed", "cancelled"].includes(op.status))) {
      pending.current = null; setSending(false); // Unaccepted drafts and attachments survive failure.
    }
  }, [messages, operations]);
  function send() {
    if (!enabled || busy || sending || screenshotBusy) return;
    const action = draft.trim() ? "send" : "answer";
    const id = dispatch({ type: "chat_send", action, text: draft, provider, profile, request_ids: screens.map(s => s.request_id) });
    if (id) { pending.current = { id, text: draft }; setSending(true); onSent(); }
  }
  const active = [...operations].reverse().find(op => op.kind === "chat_send" && ["sent", "accepted", "running"].includes(op.status));
  return <div className="sage-composer" onKeyDownCapture={event => {
    // Enter confirms an IME composition; it must not also submit the message.
    if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) event.stopPropagation();
    // The explicit Answer button can use context alone; an empty Enter is accidental.
    else if (event.key === "Enter" && !draft.trim() && !screens.length) {
      event.preventDefault(); event.stopPropagation();
    }
  }}>
    <div className="sage-answer-options">
      <NativeSelect variant="secondary"><label htmlFor="sage-provider">回答方式</label>
        <NativeSelect.Trigger id="sage-provider" name="answer-provider" value={provider} disabled={!enabled || busy || sending}
          onChange={event => setProvider(event.target.value as typeof provider)}>
          <NativeSelect.Option value="responses">Responses API</NativeSelect.Option>
          <NativeSelect.Option value="codex">Codex</NativeSelect.Option><NativeSelect.Indicator />
        </NativeSelect.Trigger></NativeSelect>
      <NativeSelect variant="secondary"><label htmlFor="sage-profile">回答提示词</label>
        <NativeSelect.Trigger id="sage-profile" name="answer-profile" value={profile} disabled={!enabled || busy || sending}
          onChange={event => setProfile(event.target.value as typeof profile)}>
          <NativeSelect.Option value="default">通用</NativeSelect.Option><NativeSelect.Option value="brief">临场短答</NativeSelect.Option>
          <NativeSelect.Option value="ood">对象设计 / OOD</NativeSelect.Option><NativeSelect.Indicator />
        </NativeSelect.Trigger></NativeSelect>
    </div>
    <PromptInput value={draft} onValueChange={setDraft} onSubmit={send} isDisabled={!enabled}
      status={busy ? "streaming" : "ready"} lockInputOnRun={false}
      onStop={() => active && dispatch({ type: "chat_stop", target_operation_id: active.operation_id })}>
      <PromptInput.Shell>
        <PromptInput.Content>
          {screens.length > 0 && <PromptInput.Attachments><Attachments screens={screens}
            remove={id => dispatch({ type: "clear_screens", request_ids: [id] })} /></PromptInput.Attachments>}
          <PromptInput.TextArea aria-label="消息" placeholder="问点什么…" maxLength={12000} />
        </PromptInput.Content>
        <PromptInput.Toolbar>
          <PromptInput.ToolbarStart>
            <Button size="sm" variant="ghost" aria-label="截图" onPress={onCapture} isDisabled={!enabled || screenshotBusy}>
              <Monitor size={18} /><span className="sage-capture-label">{screenshotBusy ? "截图中" : "截图"}</span>
            </Button>
            {more}
          </PromptInput.ToolbarStart>
          <PromptInput.ToolbarEnd><PromptInput.Send aria-label={busy ? "停止生成" : draft.trim() ? "发送消息" : "回答"}
            isDisabled={!enabled || (!busy && (sending || screenshotBusy))}>
            {busy ? <Square size={16} weight="fill" /> : <ArrowUp size={18} />}
            {!busy && !draft.trim() && <span>回答</span>}
          </PromptInput.Send></PromptInput.ToolbarEnd>
        </PromptInput.Toolbar>
      </PromptInput.Shell>
    </PromptInput>
  </div>;
}
