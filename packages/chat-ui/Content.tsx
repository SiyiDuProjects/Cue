import { useEffect, useRef, useState } from "react";
import { type Event } from "./bridge";
import { MessageList, type Message } from "./Messages";
import "./styles.css";

/**
 * Mac answer view. The native window owns every control and the chat state;
 * this page renders the current chat's messages. Native sends the full list
 * on structural changes and forwards answer deltas, which are applied here.
 */
export default function Content() {
  const [messages, setMessages] = useState<Message[]>([]);
  const list = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    chat = useRef("");
  useEffect(() => {
    const listener = (event: globalThis.Event) => {
      const e = (event as CustomEvent).detail as Event;
      if (e.type === "render") {
        if (e.chat !== chat.current) follow.current = true;
        chat.current = e.chat;
        setMessages(e.messages);
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
    };
    window.addEventListener("cue:event", listener);
    // Events sent before this listener existed were dropped; ask for the chat.
    void window.cue.ready?.();
    return () => window.removeEventListener("cue:event", listener);
  }, []);
  useEffect(() => {
    if (follow.current && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [messages]);
  return (
    <div
      className="conversation content-view"
      ref={list}
      onScroll={() => {
        const el = list.current!;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
      }}
      aria-label="聊天记录"
    >
      <div className="column">
        <MessageList messages={messages} />
      </div>
    </div>
  );
}
