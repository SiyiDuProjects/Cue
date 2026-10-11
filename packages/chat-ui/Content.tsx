import { useEffect, useRef, useState } from "react";
import { type Event } from "./bridge";
import { OneExchange, type Message } from "./Messages";
import "./styles.css";

/**
 * Mac answer card. The native overlay owns every control and the answer
 * list; this page shows one exchange at a time and reports its height so
 * the overlay hugs the answer. Native sends the full list on structural
 * changes and forwards answer deltas, which are applied here.
 */
export default function Content() {
  const [messages, setMessages] = useState<Message[]>([]);
  const list = useRef<HTMLDivElement>(null),
    column = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    count = useRef(0);
  useEffect(() => {
    const listener = (event: globalThis.Event) => {
      const e = (event as CustomEvent).detail as Event;
      if (e.type === "render") {
        if (e.messages.length > count.current) follow.current = true;
        count.current = e.messages.length;
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
    // Events sent before this listener existed were dropped; ask for them.
    void window.cue.ready?.();
    return () => window.removeEventListener("cue:event", listener);
  }, []);
  useEffect(() => {
    const el = column.current!;
    const observer = new ResizeObserver(() => {
      void window.cue.height?.(
        el.childElementCount ? Math.ceil(el.getBoundingClientRect().height) : 0,
      );
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (follow.current && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [messages]);
  return (
    <div
      className="conversation content-view exchange-view"
      ref={list}
      onScroll={() => {
        const el = list.current!;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 70;
      }}
      aria-label="回答"
    >
      <div className="column" ref={column}>
        <OneExchange
          messages={messages}
          onTurn={(newest) => {
            follow.current = newest;
            if (list.current) list.current.scrollTop = 0;
          }}
        />
      </div>
    </div>
  );
}
