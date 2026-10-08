import React, {
  Children,
  isValidElement,
  useState,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Button, Spinner } from "@heroui/react";
import { CodeBlock } from "@heroui-pro/react/code-block";
import { Check, Copy, Images } from "@phosphor-icons/react";

// Message rendering shared by the Windows window and the Mac answer view.
export type Message = {
  id: string;
  chat: string;
  text: string;
  answer: string;
  status: string;
  detail: string;
  context?: string;
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

export function MessageList({ messages }: { messages: Message[] }) {
  if (!messages.length)
    return (
      <div className="welcome">
        <span className="wordmark">Cue</span>
        <p>
          截图或开始转录后，按 <kbd>{shortcut}</kbd> 回答当前问题
        </p>
      </div>
    );
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
