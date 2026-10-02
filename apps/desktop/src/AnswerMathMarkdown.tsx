import React, { memo, useMemo } from "react";
import { Markdown } from "@heroui-pro/react/markdown";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import rehypeKatex from "rehype-katex";
import { unified } from "unified";
import type { Root, RootContent } from "mdast";

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

type PositionedNode = { type: string; children?: PositionedNode[]; position?: RootContent["position"] };
function closedMath(node: PositionedNode, source: string): boolean {
  if (node.type === "inlineMath") return true;
  if (node.type !== "math") return false;
  const raw = source.slice(node.position?.start.offset, node.position?.end.offset).trimEnd();
  const lines = raw.split("\n");
  const opening = lines[0].match(/^\s*(\${2,})/);
  const closing = lines.at(-1)!.match(/^[\s>]*(\${2,})[ \t]*$/);
  return lines.length > 1 && !!opening && !!closing && closing[1].length >= opening[1].length;
}

function containsMath(node: PositionedNode, source: string): boolean {
  return closedMath(node, source) || !!node.children?.some(child => containsMath(child, source));
}

// An unfinished display fence remains literal, including when another formula
// in the same list/quote is complete. Never invent a closing delimiter.
function preserveUnfinishedMath() {
  return (tree: Root, file: { value: unknown }) => {
    const source = String(file.value);
    const walk = (node: PositionedNode) => {
      if (!node.children) return;
      node.children = node.children.map(child => {
        if (child.type === "math" && !closedMath(child, source)) return {
          type: "paragraph", children: [{ type: "text", value: source.slice(child.position?.start.offset, child.position?.end.offset) }],
        };
        walk(child);
        return child;
      });
    };
    walk(tree);
  };
}

const remarkPlugins = [remarkGfm, remarkBreaks, remarkMath, preserveUnfinishedMath];
const rehypePlugins: NonNullable<React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]> = [
  [rehypeKatex, { trust: false, strict: "ignore", maxExpand: 500, maxSize: 20 }],
];

const MathBlock = memo(function MathBlock({ text, components }: { text: string; components: Components }) {
  return <div className="markdown markdown__block answer-math-block">
    <ReactMarkdown components={components} remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins}>{text}</ReactMarkdown>
  </div>;
});

export const AnswerMathMarkdown = memo(function AnswerMathMarkdown({ text, components }: { text: string; components: Components }) {
  const parts = useMemo(() => {
    // HeroUI beta.8 has no remark/rehype hooks. Only formula-containing blocks
    // need its underlying parser with the standard math plugins; all other
    // content keeps HeroUI's existing memoized Markdown renderer.
    if (!text.includes("$")) return [{ text, math: false, offset: 0 }];
    const parts: { text: string; math: boolean; offset: number }[] = [];
    let offset = 0;
    for (const node of parser.parse(text).children) {
      if (!containsMath(node, text)) continue;
      const start = node.position!.start.offset!, end = node.position!.end.offset!;
      if (start > offset) parts.push({ text: text.slice(offset, start), math: false, offset });
      parts.push({ text: text.slice(start, end), math: true, offset: start });
      offset = end;
    }
    if (offset < text.length) parts.push({ text: text.slice(offset), math: false, offset });
    return parts;
  }, [text]);
  return <div className="answer-markdown">{parts.map(part => part.math
    ? <MathBlock key={part.offset} text={part.text} components={components} />
    : part.text.trim() && <Markdown key={part.offset} components={components}>{part.text}</Markdown>)}</div>;
});
