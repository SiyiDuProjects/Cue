import { useEffect, useRef } from "react";

/** How far back the caption strip can be scrolled. */
export const CAPTION_WINDOW = 10 * 60000;

/** Chinese and Japanese run sentences together; other scripts use a space. */
export const joinCaptions = (parts: string[]) =>
  parts
    .map((t) => t.trim())
    .filter(Boolean)
    .reduce(
      (line, next) =>
        !line
          ? next
          : line +
            (line.charCodeAt(line.length - 1) >= 0x2e80 ? "" : " ") +
            next,
      "",
    );

/**
 * Interviewer captions on every platform: a short strip that follows the
 * newest words and scrolls back over the last ten minutes. Scrolling up
 * stops following until the reader returns to the end.
 */
export function CaptionStrip({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div
      ref={box}
      className={"captions glass" + (text ? "" : " waiting")}
      aria-label="面试官字幕"
      onScroll={() => {
        const el = box.current!;
        follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
      }}
    >
      <p>{text || "等待面试官说话…"}</p>
    </div>
  );
}
