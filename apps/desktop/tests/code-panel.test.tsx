import assert from "node:assert/strict";
import React from "react";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CodePanel } from "../src/CodePanel";
import type { CodeWorkspace, CodeVersion } from "../src/types";

const version: CodeVersion = { id: "v1", revision: 1, title: "遍历求解", created_at: "2026-09-28T10:00:00Z",
  files: [{ filename: "main.py", language: "python", code: "return sum(values)", comparison: null }], complexity: null };
function render(current: CodeVersion | null) {
  const workspace: CodeWorkspace = { workspace_id: "w", revision: current?.revision ?? 0, current,
    versions: current ? [current] : [], run_id: "", reveal_id: "" };
  return renderToStaticMarkup(<CodePanel workspace={workspace} enabled operations={[]} dispatch={() => null} />);
}
test("empty code pane offers explicit update without a fabricated baseline", () => {
  const html = render(null);
  assert.match(html, /直接在聊天里提出/);
  assert.doesNotMatch(html, /当前代码|步骤目录|is-added/);
});
test("a first complete answer renders as code, not an all-green diff or an extra step", () => {
  const html = render(version);
  assert.match(html, /遍历求解/);
  assert.match(html, /return sum\(values\)/);
  assert.doesNotMatch(html, /is-added|is-removed|查看完整代码|步骤目录/);
});
test("a real comparison names its basis and renders both changed sides", () => {
  const next = structuredClone(version);
  next.files[0].comparison = { source: "previous", before: "return 0", label: "相对上一版代码", screenshot_id: null };
  const html = render(next);
  assert.match(html, /相对上一版代码/);
  assert.match(html, /is-removed/);
  assert.match(html, /is-added/);
  assert.match(html, /查看完整代码/);
});
