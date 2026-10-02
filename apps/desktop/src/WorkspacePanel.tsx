import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button, Tabs, Modal, Popover } from "@heroui/react";
import { CaretDown } from "@phosphor-icons/react";
import { AnswerMarkdown, CopyTextButton } from "./AnswerMarkdown";
import { codeDiff } from "./codeWorkspaceState";
import type { CodeWorkspace, OperationRecord, WorkspaceHistoryEntry } from "./types";

export type Props = { workspace: CodeWorkspace; enabled: boolean; connected?: boolean; operations: OperationRecord[];
  dispatch: (payload: Record<string, unknown>) => string | null; historyEntries?: Record<string, WorkspaceHistoryEntry> };
const stamp = (value?: string) => value ? new Date(value).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

export function WorkspacePanel({ workspace, connected = true, operations, dispatch, historyEntries = {} }: Props) {
  const [historyKey, setHistoryKey] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [archives, setArchives] = useState(false);
  const [historyOperation, setHistoryOperation] = useState<string | null>(null);
  const [selection, setSelection] = useState({ version: "", filename: "" });
  const [showDiff, setShowDiff] = useState(true);
  const entry = historyKey ? historyEntries[historyKey] : undefined;
  const version = historyKey ? entry?.version : workspace.current;
  const file = version?.files.find(f => selection.version === version.id && f.filename === selection.filename)
    ?? version?.files.find(f => f.filename === version.active_file) ?? version?.files[0];
  const comparison = file?.comparison;
  const complexity = version?.complexity;
  const failure = operations.find(op => op.operation_id === historyOperation && ["failed", "cancelled"].includes(op.status));
  const lines = useMemo(() => codeDiff(showDiff && comparison ? comparison.before : file?.code ?? "", file?.code ?? ""),
    [file?.code, comparison, showDiff]);
  const scroller = useRef<HTMLDivElement>(null);
  const positions = useRef(new Map<string, { top: number; left: number }>());
  const readingKey = (version?.id ?? "empty") + ":" + (file?.filename ?? "") + ":" + showDiff;
  useLayoutEffect(() => {
    const saved = positions.current.get(readingKey);
    if (scroller.current) { scroller.current.scrollTop = saved?.top ?? 0; scroller.current.scrollLeft = saved?.left ?? 0; }
  }, [readingKey]);

  function load(id: string, interview?: string, group?: string) {
    if (!interview && id === workspace.current?.id) { setHistoryKey(""); setHistoryOpen(false); return; }
    const key = interview ? interview + ":" + group + ":" + (id || "latest") : id;
    if (!historyEntries[key]) {
      const op = dispatch({ type: "code_action", action: interview ? "load_archive" : "load_history",
        version_id: id || undefined, archive_interview_id: interview, archive_problem_id: group });
      if (!op) return;
      setHistoryOperation(op);
    }
    setHistoryKey(key); setHistoryOpen(false);
  }
  return <section className="preview-workspace" aria-label="代码区">
    <div className="preview-workspace-tabs">
      <div className="preview-workspace-heading">
        <strong className="sage-code-title">代码</strong>
        <Button variant="ghost" size="sm" aria-label="代码历史" onPress={() => { setArchives(false); setHistoryOpen(true); }}>历史<CaretDown size={13} /></Button>
      </div>
      {historyKey && <div className="workspace-history-notice" role="status">
        <span>{entry ? "历史代码 · " + stamp(entry.version.created_at) : failure?.detail || "正在读取历史…"}</span>
        <Button size="sm" variant="ghost" onPress={() => setHistoryKey("")}>回到当前代码</Button>
      </div>}
      {workspace.history_error && <p className="plan-notice">{workspace.history_error}</p>}
      <div className="preview-code-panel">
        <div className="preview-file-bar">
          {(version?.files.length ?? 0) > 1 ? <Tabs variant="secondary" selectedKey={file?.filename} onSelectionChange={key => setSelection({ version: version!.id, filename: String(key) })}>
            <Tabs.ListContainer><Tabs.List aria-label="代码文件">{version!.files.map(f => <Tabs.Tab id={f.filename} key={f.filename}>{f.filename}<Tabs.Indicator /></Tabs.Tab>)}</Tabs.List></Tabs.ListContainer>
          </Tabs> : <span className="preview-single-file">{file?.filename ?? ""}</span>}
          {complexity && (complexity.time || complexity.space) && <Popover>
            <Button variant="ghost" size="sm" aria-label="复杂度说明">时间 {complexity.time ?? "—"} · 空间 {complexity.space ?? "—"}</Button>
            <Popover.Content><Popover.Dialog><Popover.Heading>这份实现的复杂度</Popover.Heading><AnswerMarkdown text={complexity.explanation} /></Popover.Dialog></Popover.Content>
          </Popover>}
          {file && <CopyTextButton text={file.code} label="复制代码" />}
        </div>
        {version && <div className="pinned-code-heading"><h2>{version.title}</h2>
          {comparison && <Button size="sm" variant="ghost" onPress={() => setShowDiff(!showDiff)}>{showDiff ? "查看完整代码" : "查看修改"}</Button>}
        </div>}
        {showDiff && comparison && <p className="code-comparison-label">{comparison.label}{comparison.captured_at ? " · " + stamp(comparison.captured_at) : ""}</p>}
        {!version && !historyKey && <p className="workspace-baseline-empty">需要实现时，直接在聊天里提出。生成的代码文件会显示在这里。</p>}
        {version && !version.files.length && <p className="workspace-baseline-empty">此版本没有代码文件。</p>}
        {version?.interrupted && <p role="status" className="plan-notice">未完成修改 · 生成已中断，这些文件可能尚未写完。</p>}
        {workspace.run_id && !historyKey && <p role="status" className="code-comparison-label">正在更新，原代码保留…</p>}
        <div ref={scroller} className="preview-code-scroll" onScroll={e => positions.current.set(readingKey, { top: e.currentTarget.scrollTop, left: e.currentTarget.scrollLeft })}>
          <pre className="preview-code" tabIndex={0} aria-label={file ? file.filename + " 代码" : "代码"}>
            {lines.map((line, index) => <span key={index} className={"preview-code-line is-" + line.kind}>
              <span className="preview-line-number" aria-hidden="true">{line.after ?? line.before}</span>
              <span className="preview-line-sign" aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</span>
              <span className={/^\s*(#|\/\/)/.test(line.text) ? "python-comment" : undefined}>{line.text || " "}</span>
            </span>)}
          </pre>
        </div>
      </div>
    </div>
    <Modal isOpen={historyOpen} onOpenChange={setHistoryOpen}><Modal.Backdrop><Modal.Container size="md"><Modal.Dialog aria-label="代码历史">
      <Modal.CloseTrigger aria-label="关闭历史" /><Modal.Header><Modal.Heading>代码历史</Modal.Heading></Modal.Header>
      <Modal.Body>
        <Tabs selectedKey={archives ? "archives" : "versions"} onSelectionChange={key => setArchives(key === "archives")}>
          <Tabs.ListContainer><Tabs.List aria-label="历史范围">
            <Tabs.Tab id="versions">{entry?.archive_interview_id ? "所选往场的版本" : "本场版本"}<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="archives">往场代码<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List></Tabs.ListContainer>
        </Tabs>
        <div className="workspace-version-list">
        {archives ? workspace.saved_workspaces?.map(item => <Button key={item.interview_id + item.problem_id} variant="ghost" isDisabled={!connected}
          onPress={() => load("", item.interview_id, item.problem_id)}><span>{item.title}<small>{stamp(item.updated_at)}</small></span></Button>)
          : (entry?.versions ?? workspace.versions).map(v => <Button key={v.id} variant="ghost" isDisabled={!connected && !historyEntries[v.id]}
            onPress={() => load(v.id, entry?.archive_interview_id, entry?.archive_problem_id)}><span>{v.title}<small>{stamp(v.created_at)}</small></span>
            {v.id === workspace.current?.id && <small>当前</small>}</Button>)}
        {(archives ? !workspace.saved_workspaces?.length : !(entry?.versions ?? workspace.versions).length) && <p className="preview-muted">还没有代码记录。</p>}
      </div></Modal.Body>
    </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
  </section>;
}

