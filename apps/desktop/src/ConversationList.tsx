import { useEffect, useState } from "react";
import { Button, Modal, TextArea } from "@heroui/react";
import { ChatListView } from "@heroui-pro/react/chat-list-view";
import { Plus } from "@phosphor-icons/react";
import type { InterviewSession } from "./types";

export interface ConversationSummary { interview_id: string; title: string; updated_at: string }

export async function conversationRequest(base: string, session: InterviewSession, action: "list" | "switch" | "rename",
  values: { target_id?: string | null; stop_active?: boolean; title?: string } = {}) {
  const payload = { action, current_id: (session.conversation_id || session.interview_id), session_token: session.session_token, ...values };
  if (window.interviewDesktop?.conversationRequest) return window.interviewDesktop.conversationRequest(base, payload);
  const path = action === "list" ? "/api/conversations" : action === "switch" ? "/api/conversations/switch"
    : `/api/conversations/${encodeURIComponent((session.conversation_id || session.interview_id))}`;
  const response = await fetch(base + path, { method: action === "list" ? "GET" : action === "switch" ? "POST" : "PATCH",
    credentials: "include", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${session.session_token}`, "Content-Type": "application/json" },
    ...(action !== "list" ? { body: JSON.stringify({ current_id: (session.conversation_id || session.interview_id), ...values }) } : {}) });
  const result = await response.json();
  if (!response.ok) throw Error(result.detail || "会话操作失败");
  return result;
}

export function ConversationList({ open, onOpenChange, base, session, title, onSelect, onRename }: {
  open: boolean; onOpenChange: (open: boolean) => void; base: string; session: InterviewSession | null;
  title: string; onSelect: (id: string | null) => void; onRename: (title: string) => void;
}) {
  const [items, setItems] = useState<ConversationSummary[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(title);
  useEffect(() => {
    if (!open || !session) return;
    let cancelled = false;
    setError(""); setLoading(true); setEditing(false); setName(title);
    void conversationRequest(base, session, "list").then(data => {
      if (!cancelled) setItems(data.conversations);
    }).catch(e => { if (!cancelled) setError(e.message); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, base, (session?.conversation_id || session?.interview_id), title]);
  async function rename() {
    if (!session || !name.trim()) return;
    setLoading(true);
    try {
      await conversationRequest(base, session, "rename", { title: name.trim() });
      onRename(name.trim()); setEditing(false);
    } catch (e) { setError(e instanceof Error ? e.message : "改名失败"); }
    finally { setLoading(false); }
  }
  return <Modal isOpen={open} onOpenChange={onOpenChange}><Modal.Backdrop>
    <Modal.Container className="sage-conversations-container"><Modal.Dialog className="sage-conversations-dialog" aria-label="会话列表">
      <Modal.CloseTrigger aria-label="关闭会话列表" />
      <Modal.Header><Modal.Heading>会话</Modal.Heading></Modal.Header>
      <Modal.Body>
        <Button variant="secondary" fullWidth isDisabled={!session} onPress={() => onSelect(null)}><Plus size={18} />新对话</Button>
        {error && <p role="alert" className="error-banner">{error}</p>}
        {loading && <p role="status" className="preview-muted">读取中…</p>}
        <ChatListView aria-label="历史会话" density="compact" selectionMode="none" onAction={key => onSelect(String(key))}>
          {items.map(item => <ChatListView.Item key={item.interview_id} id={item.interview_id} textValue={item.title}
            className={item.interview_id === (session?.conversation_id || session?.interview_id) ? "sage-current-conversation" : undefined}
            aria-current={item.interview_id === (session?.conversation_id || session?.interview_id) ? "page" : undefined}>
            <ChatListView.ItemContent><ChatListView.Text>
              <ChatListView.Title>{item.title}</ChatListView.Title>
              <ChatListView.Preview>{new Date(item.updated_at).toLocaleDateString()}</ChatListView.Preview>
            </ChatListView.Text></ChatListView.ItemContent>
          </ChatListView.Item>)}
        </ChatListView>
      </Modal.Body>
      <Modal.Footer className="sage-conversation-footer">
        {editing ? <><TextArea aria-label="会话名称" value={name} onChange={e => setName(e.target.value)} maxLength={120} />
          <Button isDisabled={loading || !name.trim()} onPress={() => void rename()}>保存名称</Button></>
          : <Button variant="ghost" isDisabled={!session || loading} onPress={() => setEditing(true)}>重命名当前会话</Button>}
      </Modal.Footer>
    </Modal.Dialog></Modal.Container>
  </Modal.Backdrop></Modal>;
}
