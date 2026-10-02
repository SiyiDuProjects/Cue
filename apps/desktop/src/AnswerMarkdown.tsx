import React, { Children, isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@heroui/react";
import { Check, Copy } from "@phosphor-icons/react";
import { CodeBlock as HeroCodeBlock } from "@heroui-pro/react/code-block";
import type { Components } from "react-markdown";
import { safeAnswerLink } from "./interviewUiState";
import { AnswerMathMarkdown } from "./AnswerMathMarkdown";

function plainText(children: ReactNode): string {
  return Children.toArray(children).map((child): string => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    return isValidElement<{ children?: ReactNode }>(child) ? plainText(child.props.children) : "";
  }).join("");
}

export function CopyTextButton({ text, label = "复制", className = "" }: { text: string; label?: string; className?: string }) {
  const [result, setResult] = useState<{ text: string; state: "copied" | "failed" } | null>(null);
  const attemptRef = useRef(0);
  const state = result?.text === text ? result.state : "idle";
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(null), 2_000);
    return () => window.clearTimeout(timer);
  }, [result]);
  useEffect(() => () => { attemptRef.current += 1; }, []);
  async function copy() {
    const attempt = ++attemptRef.current;
    try {
      await navigator.clipboard.writeText(text);
      if (attempt === attemptRef.current) setResult({ text, state: "copied" });
    } catch {
      if (attempt === attemptRef.current) setResult({ text, state: "failed" });
    }
  }
  return <Button variant="ghost" size="sm" className={className} onPress={() => void copy()} isDisabled={!text} aria-label={label}>
    {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
    <span role="status">{state === "copied" ? "已复制" : state === "failed" ? "复制失败" : label}</span>
  </Button>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children).find((child) => isValidElement(child));
  const language = isValidElement<{ className?: string }>(code)
    ? code.props.className?.match(/language-([\w+-]+)/)?.[1]
    : undefined;
  const text = plainText(children);
  return <HeroCodeBlock className="answer-code">
    <HeroCodeBlock.Header className="answer-code-header"><span>{language || "代码"}</span>
      <CopyTextButton text={text} label="复制代码" /></HeroCodeBlock.Header>
    <HeroCodeBlock.Code code={text} language={language || "plaintext"} tabIndex={0}
      aria-label={language ? `${language} 代码` : "代码"} />
  </HeroCodeBlock>;
}

// Keep only product policy and copy behavior here; HeroUI owns parsing and streaming blocks.
const markdownComponents: Components = {
  code: ({ children, className }) => <code className={className}>{children}</code>,
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  table: ({ children }) => <div className="answer-table" role="region" aria-label="回答表格" tabIndex={0}><table>{children}</table></div>,
  img: () => null,
};

export const AnswerMarkdown = memo(function AnswerMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const components = useMemo<Components>(() => ({ ...markdownComponents,
    a: ({ children, href }) => {
      // Do not make a URL clickable while its final characters are still arriving.
      const safeHref = streaming && href && text.endsWith(href) ? "" : safeAnswerLink(href);
      return safeHref ? <a href={safeHref} target="_blank" rel="noreferrer noopener">{children}</a> : <span>{children}</span>;
    },
  }), [streaming, text]);
  return <AnswerMathMarkdown text={text} components={components} />;
});
