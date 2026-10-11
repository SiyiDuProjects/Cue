import React, {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Button, Spinner } from "@heroui/react";
import { CodeBlock } from "@heroui-pro/react/code-block";
import {
  CaretLeft,
  CaretRight,
  Check,
  Copy,
  Images,
} from "@phosphor-icons/react";

// Message rendering shared by the Windows overlay and the Mac answer card.
export type Message = {
  id: string;
  chat: string;
  text: string;
  answer: string;
  status: string;
  detail: string;
  context?: string;
  reasoning?: string;
};
export const busy = (m: Message) => ["preparing", "running"].includes(m.status);
export const isMac = /Mac/i.test(navigator.userAgent);
export const shortcut = isMac ? "⌘ ↩" : "Ctrl ↩";
export function imageCount(m: Message) {
  try {
    return JSON.parse(m.context || "{}").images?.length || 0;
  } catch {
    return 0;
  }
}

function plainText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child): string => {
      if (typeof child === "string" || typeof child === "number")
        return String(child);
      return isValidElement<{ children?: ReactNode }>(child)
        ? plainText(child.props.children)
        : "";
    })
    .join("");
}

/** Copies through the native bridge; the file:// WebView has no clipboard API. */
function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      className={className}
      onPress={() =>
        void window.cue.copy(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check /> : <Copy />}
      {copied ? "已复制" : label}
    </Button>
  );
}

function Code({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children)[0];
  const props = isValidElement<{ className?: string; children?: ReactNode }>(
    code,
  )
    ? code.props
    : {};
  const language = /language-([\w+-]+)/.exec(props.className || "")?.[1];
  const text = plainText(props.children).replace(/\n$/, "");
  return (
    <CodeBlock>
      <CodeBlock.Header>
        <span className="code-language">{language || "代码"}</span>
        <CopyButton text={text} label="复制" className="code-copy" />
      </CodeBlock.Header>
      <CodeBlock.Code code={text} language={language || "plaintext"} />
    </CodeBlock>
  );
}

const markdown: Components = {
  pre: ({ children }) => <Code>{children}</Code>,
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }) =>
    href && /^https?:\/\//.test(href) ? (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: () => null,
};

/** Streams while the model thinks; folds away once the answer starts. */
function Reasoning({ m }: { m: Message }) {
  if (!m.reasoning) return null;
  const body = (
    <div className="reasoning-text">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdown}>
        {m.reasoning}
      </ReactMarkdown>
    </div>
  );
  if (busy(m) && !m.answer) return <div className="reasoning">{body}</div>;
  return (
    <details className="reasoning">
      <summary>思路</summary>
      {body}
    </details>
  );
}

export function MessageList({ messages }: { messages: Message[] }) {
  return (
    <>
      {messages.map((m) => (
        <article className="exchange" key={m.id}>
          <div className="user-message">
            <p>{m.text || "回答当前问题"}</p>
            {imageCount(m) > 0 && (
              <span className="attachment-note">
                <Images />
                {imageCount(m)} 张截图
              </span>
            )}
          </div>
          <div className="assistant-message">
            <Reasoning m={m} />
            {m.answer && (
              <div className="markdown">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                  components={markdown}
                >
                  {m.answer}
                </ReactMarkdown>
              </div>
            )}
            {busy(m) && (
              <div className="thinking" role="status">
                <Spinner size="sm" color="current" />
                {m.answer ? "正在回答" : "正在思考…"}
              </div>
            )}
            {m.detail && <p className="detail">{m.detail}</p>}
            {m.answer && !busy(m) && (
              <div className="message-actions">
                <CopyButton text={m.answer} label="复制" className="copy" />
              </div>
            )}
          </div>
        </article>
      ))}
    </>
  );
}

/**
 * The answer card on both platforms: one exchange at a time, the newest
 * unless paged back. A new question returns to the newest. `onTurn` tells
 * the scroller whether the shown exchange is the newest.
 */
export function OneExchange({
  messages,
  onTurn,
}: {
  messages: Message[];
  onTurn?: (newest: boolean) => void;
}) {
  // null follows the newest exchange; a number keeps an earlier one open.
  const [page, setPage] = useState<number | null>(null);
  const count = useRef(messages.length);
  useEffect(() => {
    if (messages.length > count.current) setPage(null);
    count.current = messages.length;
  }, [messages.length]);
  const index =
    page === null || page >= messages.length ? messages.length - 1 : page;
  if (index < 0) return null;
  const turn = (to: number) => {
    const newest = to === messages.length - 1;
    setPage(newest ? null : to);
    onTurn?.(newest);
  };
  return (
    <>
      <MessageList messages={[messages[index]]} />
      {messages.length > 1 && (
        <nav className="pager" aria-label="切换回答">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="上一条"
            isDisabled={index === 0}
            onPress={() => turn(index - 1)}
          >
            <CaretLeft />
          </Button>
          <span>
            {index + 1} / {messages.length}
          </span>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="下一条"
            isDisabled={index === messages.length - 1}
            onPress={() => turn(index + 1)}
          >
            <CaretRight />
          </Button>
        </nav>
      )}
    </>
  );
}
