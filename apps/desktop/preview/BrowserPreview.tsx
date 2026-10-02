import React, { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button, Chip, Dropdown, Label, Modal, Tabs, TextArea, Toast, Toolbar, Tooltip, Typography, toast, useTheme } from "@heroui/react";
import { ChatConversation } from "@heroui-pro/react/chat-conversation";
import { Resizable } from "@heroui-pro/react/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { Camera, CaretLeft, CaretRight, Check, Copy, DotsThree, Moon, SidebarSimple, Sun, X } from "@phosphor-icons/react";
import { AnswerMarkdown } from "../src/AnswerMarkdown";
import { codeDiff } from "../src/codeWorkspaceState";
import { projectFile, scenarioFiles, scenarios, type PreviewScenario } from "./scenarios";

type Answer = { id: string; label: string; text: string; streaming?: boolean };
type Dialog = "screenshots" | "correction" | "devices" | null;

function IconButton({ label, children, onPress, disabled = false }: {
  label: string; children: ReactNode; onPress: () => void; disabled?: boolean;
}) {
  return <Tooltip delay={400}>
    <Button isIconOnly variant="ghost" aria-label={label} isDisabled={disabled} onPress={onPress}>{children}</Button>
    <Tooltip.Content>{label}</Tooltip.Content>
  </Tooltip>;
}

function pythonLine(text: string) {
  if (text.trimStart().startsWith("#")) return <span className="python-comment">{text}</span>;
  return text.split(/("[^"\n]*"|'[^'\n]*'|\b(?:class|def|return|if|in|for|from|import|raise|try|finally|except|continue|assert|pass)\b)/g)
    .map((part, index) => <span key={index} className={/^['"]/.test(part) ? "python-string" : /^(class|def|return|if|in|for|from|import|raise|try|finally|except|continue|assert|pass)$/.test(part) ? "python-keyword" : undefined}>{part}</span>);
}

function StepCode({ scenario, stepIndex, filename }: { scenario: PreviewScenario; stepIndex: number; filename: string }) {
  const projection = projectFile(scenario, stepIndex, filename);
  const lines = useMemo(() => codeDiff(projection.before, projection.after), [projection.before, projection.after]);
  if (!projection.after) return <div className="preview-file-empty">尚未创建</div>;
  return <pre className="preview-code" tabIndex={0} aria-label={`${filename} 步骤预览，绿色加号为建议新增，减号为删除`}>
    {lines.map((line, index) => <span key={index} className={`preview-code-line is-${line.kind}`}>
      <span className="preview-line-number" aria-hidden="true">{line.after ?? line.before}</span>
      <span className="preview-line-sign" aria-hidden="true">{line.kind === "added" ? "+" : line.kind === "removed" ? "−" : ""}</span>
      <span>{pythonLine(line.text || " ")}</span>
    </span>)}
  </pre>;
}

function CodeWorkspace({ scenario, initialStep, onNotice }: { scenario: PreviewScenario; initialStep: number; onNotice: (text: string) => void }) {
  const [view, setView] = useState(scenario.steps.length ? "code" : "analysis");
  const [stepIndex, setStepIndex] = useState(initialStep);
  const [filename, setFilename] = useState(Object.keys(scenario.steps[initialStep]?.changes ?? {})[0] ?? "");
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollPositions = useRef(new Map<string, { top: number; left: number }>());
  const fileNames = scenarioFiles(scenario);
  const step = scenario.steps[stepIndex];
  const affected = Object.keys(step?.changes ?? {});
  const readingKey = `${stepIndex}:${filename}`;
  const savedKey = useRef(readingKey);

  useLayoutEffect(() => {
    const position = scrollPositions.current.get(readingKey);
    const scroller = scrollRef.current;
    if (scroller) { scroller.scrollTop = position?.top ?? 0; scroller.scrollLeft = position?.left ?? 0; }
    savedKey.current = readingKey;
    setCopied(false);
  }, [readingKey]);

  function turnPage(direction: number) {
    const next = Math.min(scenario.steps.length - 1, Math.max(0, stepIndex + direction));
    if (next === stepIndex) return;
    setStepIndex(next);
    // Only this explicit navigation may focus the file involved in the step.
    setFilename(Object.keys(scenario.steps[next].changes)[0]);
  }

  async function copy() {
    const text = view === "analysis" ? scenario.analysis : projectFile(scenario, stepIndex, filename).after;
    try { await navigator.clipboard.writeText(text); setCopied(true); }
    catch { onNotice("复制失败"); }
  }
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  return <section className="preview-workspace" aria-label="题目工作区">
    <Tabs selectedKey={view} onSelectionChange={key => setView(String(key))} className="preview-workspace-tabs">
      <div className="preview-workspace-heading">
        <Tabs.ListContainer><Tabs.List aria-label="工作区视图">
          <Tabs.Tab id="analysis">分析<Tabs.Indicator /></Tabs.Tab>
          <Tabs.Tab id="code" isDisabled={!step}>代码<Tabs.Indicator /></Tabs.Tab>
        </Tabs.List></Tabs.ListContainer>
        {view === "analysis" ? <IconButton label="复制题目分析" onPress={() => void copy()}>{copied ? <Check size={17} /> : <Copy size={17} />}</IconButton> : <div className="preview-page-controls">
          <IconButton label="上一步" disabled={stepIndex === 0 || view !== "code"} onPress={() => turnPage(-1)}><CaretLeft size={18} /></IconButton>
          <span aria-live="polite" aria-label={`第 ${stepIndex + 1} 步，共 ${scenario.steps.length} 步`}>{stepIndex + 1}<span className="preview-muted"> / {scenario.steps.length}</span></span>
          <IconButton label="下一步" disabled={stepIndex === scenario.steps.length - 1 || view !== "code"} onPress={() => turnPage(1)}><CaretRight size={18} /></IconButton>
        </div>}
      </div>
      <Tabs.Panel id="analysis" shouldForceMount className="preview-analysis-panel">
        <div className="preview-analysis-scroll" tabIndex={0}><Typography.Prose><AnswerMarkdown text={scenario.analysis || "暂无分析"} /></Typography.Prose></div>
      </Tabs.Panel>
      <Tabs.Panel id="code" shouldForceMount className="preview-code-panel">
        <div className="preview-file-bar">
          {fileNames.length > 1 ? <Tabs variant="secondary" className="preview-file-tabs" selectedKey={filename} onSelectionChange={key => setFilename(String(key))}>
            <Tabs.ListContainer><Tabs.List aria-label="代码文件">
              {fileNames.map(name => <Tabs.Tab id={name} key={name} aria-label={`${name}${affected.includes(name) ? "，本步修改" : "，本步不修改"}`}>
                <span>{name}</span>{affected.includes(name) && <Chip size="sm" color="success" variant="soft">本步</Chip>}<Tabs.Indicator />
              </Tabs.Tab>)}
            </Tabs.List></Tabs.ListContainer>
          </Tabs> : <span className="preview-single-file">{filename}</span>}
          <IconButton label="复制当前文件代码" disabled={!projectFile(scenario, stepIndex, filename).after} onPress={() => void copy()}>{copied ? <Check size={17} /> : <Copy size={17} />}</IconButton>
        </div>
        <div className="preview-step-heading">
          <h2>{step?.title}</h2>
        </div>
        <div ref={scrollRef} className="preview-code-scroll" onScroll={event => {
          scrollPositions.current.set(savedKey.current, { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft });
        }}>
          <StepCode scenario={scenario} stepIndex={stepIndex} filename={filename} />
        </div>
      </Tabs.Panel>
    </Tabs>
  </section>;
}

export function BrowserPreview() {
  const { resolvedTheme, setTheme } = useTheme("light");
  // Fixture selection belongs to the development URL, never the product menus.
  const [scenario] = useState(() => scenarios.find(item => item.id === new URLSearchParams(window.location.search).get("scenario")) ?? scenarios[0]);
  const [answers, setAnswers] = useState<Answer[]>(scenario.answers);
  const [hasTask, setHasTask] = useState(Boolean(scenario.steps.length));
  const [workspaceOpen, setWorkspaceOpen] = useState(Boolean(scenario.steps.length));
  const [active, setActive] = useState(true);
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ id: number; name: string }[]>([]);
  const [submitted, setSubmitted] = useState(0);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [input, setInput] = useState("");
  const [portrait, setPortrait] = useState(false);
  const [workspaceEpoch, setWorkspaceEpoch] = useState(0);
  const taskTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const sequence = useRef(0);
  const panel = useRef<PanelImperativeHandle>(null);
  const archivedTasks = useRef<{ title: string; screenshots: number }[]>([]);

  useEffect(() => {
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", resolvedTheme === "dark" ? "dark" : "light");
  }, [resolvedTheme]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 600px) and (orientation: portrait)");
    const sync = () => setPortrait(query.matches);
    sync(); query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => () => { if (taskTimer.current) clearInterval(taskTimer.current); }, []);
  useLayoutEffect(() => {
    if (workspaceOpen) panel.current?.expand(); else panel.current?.collapse();
  }, [workspaceOpen, portrait]);

  function setNotice(text: string) { toast(text); }

  function stopGeneration() {
    if (taskTimer.current) clearInterval(taskTimer.current);
    taskTimer.current = null;
    setBusy(false);
    setAnswers(previous => previous.map(answer => answer.streaming ? { ...answer, streaming: false, label: "已停止 · 保留收到的内容" } : answer));
  }
  function requestAnalysis() {
    if (busy) { stopGeneration(); return; }
    // This build has no session transport. Keep product controls truthful while
    // retaining an external, opt-in fixture path for UI streaming verification.
    if (!new URLSearchParams(window.location.search).has("interactive")) {
      setNotice("服务未连接"); return;
    }
    setSubmitted(count => count + pending.length); setPending([]); setBusy(true);
    if (!hasTask) setWorkspaceOpen(true);
    const id = `preview-answer-${++sequence.current}`;
    const text = hasTask ? scenario.followup : "先确认输入、输出和限制。";
    setAnswers(previous => [...previous, { id, label: "正在生成", text: "", streaming: true }]);
    let length = 0;
    taskTimer.current = setInterval(() => {
      length = Math.min(text.length, length + 3);
      setAnswers(previous => previous.map(answer => answer.id === id ? { ...answer, text: text.slice(0, length), streaming: length < text.length, label: length < text.length ? "正在生成" : "继续讨论" } : answer));
      if (length >= text.length) {
        if (taskTimer.current) clearInterval(taskTimer.current);
        taskTimer.current = null; setBusy(false); setHasTask(true);
      }
    }, 45);
  }
  function newTask() {
    stopGeneration();
    archivedTasks.current.push({ title: scenario.title, screenshots: pending.length + submitted });
    setHasTask(false); setWorkspaceOpen(false); setPending([]); setSubmitted(0); setWorkspaceEpoch(value => value + 1);
    setNotice("已开始新题");
  }
  const dialogTitle = dialog === "screenshots" ? "待用截图" : dialog === "correction" ? "补充信息" : "设备";

  const actions = <Toolbar aria-label="题目操作">
      <div className="preview-capture-actions"><Button variant="secondary" isDisabled={!active} onPress={() => {
        if (!new URLSearchParams(window.location.search).has("interactive")) { setNotice("电脑端未连接"); return; }
        const id = ++sequence.current;
        setPending(previous => [...previous, { id, name: ["题目与限制", "formatter.py", "resolver.py"][previous.length % 3] }]);
      }}><Camera size={18} />截图</Button>
      {pending.length > 0 && <Button className="preview-pending-count" variant="ghost" onPress={() => setDialog("screenshots")}>{pending.length} 张待用</Button>}</div>
      <Button className="preview-analyze" isDisabled={!active} onPress={requestAnalysis}>{busy ? "停止" : hasTask ? "更新方案" : "分析题目"}</Button>
      <Button variant="ghost" isDisabled={!active || !hasTask} onPress={newTask}>换题</Button>
      <Dropdown><Button isIconOnly variant="ghost" aria-label="更多"><DotsThree size={21} /></Button>
        <Dropdown.Popover placement="top end"><Dropdown.Menu aria-label="更多操作" onAction={key => {
          if (key === "pause") { setPaused(value => !value); if (!paused) stopGeneration(); }
          else if (key === "theme") setTheme(resolvedTheme === "dark" ? "light" : "dark");
          else { if (key === "correction") setInput(""); setDialog(key as Dialog); }
        }}>
          <Dropdown.Item id="correction" textValue="补充信息" isDisabled={!active}><Label>补充信息</Label></Dropdown.Item>
          <Dropdown.Item id="pause" textValue={paused ? "继续回答" : "暂停回答"} isDisabled={!active}><Label>{paused ? "继续回答" : "暂停回答"}</Label></Dropdown.Item>
          <Dropdown.Item id="theme" textValue={resolvedTheme === "dark" ? "日间模式" : "夜间模式"}>{resolvedTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}<Label>{resolvedTheme === "dark" ? "日间模式" : "夜间模式"}</Label></Dropdown.Item>
        </Dropdown.Menu></Dropdown.Popover>
      </Dropdown>
    </Toolbar>;

  return <div className="browser-preview">
    <main className="preview-main">
      <Resizable orientation={portrait ? "vertical" : "horizontal"} className="preview-split" id="browser-preview-split">
        <Resizable.Panel defaultSize={43} minSize={27} id="answers">
          <section className="preview-conversation" aria-label="实时回答">
            <div className="preview-session-controls">
              <Button variant="ghost" onPress={() => setDialog("devices")}>{active ? "未连接" : "已结束"}</Button>
              <div className="preview-session-actions">
                <Tooltip delay={400}><Button isIconOnly variant="ghost" aria-label="工作区" aria-pressed={workspaceOpen} onPress={() => setWorkspaceOpen(value => !value)}><SidebarSimple size={19} /></Button><Tooltip.Content>工作区</Tooltip.Content></Tooltip>
                <Button variant="ghost" onPress={() => { if (active) { stopGeneration(); setActive(false); } else setNotice("请先连接电脑端"); }}>{active ? "结束面试" : "开始面试"}</Button>
              </div>
            </div>
            {paused && <div className="preview-paused" role="status">已暂停</div>}
            <ChatConversation initial="instant" resize="instant" className="preview-answer-scroll" aria-label="连续回答记录" aria-live="off">
              <ChatConversation.Content className="preview-answer-content">
                {answers.map((answer, index) => <article key={answer.id} className="preview-answer" aria-label={`回答 ${index + 1}`}>
                  <Typography.Prose><AnswerMarkdown text={answer.text} streaming={answer.streaming} /></Typography.Prose>
                </article>)}
                <ChatConversation.ScrollAnchor />
              </ChatConversation.Content>
              <Tooltip delay={400}><ChatConversation.ScrollButton aria-label="回到实时" /><Tooltip.Content>回到实时</Tooltip.Content></Tooltip>
            </ChatConversation>
            <div className="preview-local-actions">{actions}</div>
          </section>
        </Resizable.Panel>
        <Resizable.Handle className={!workspaceOpen ? "hidden" : undefined} aria-label="调整文字区与工作区宽度" type="line" withIndicator disabled={!workspaceOpen} />
        <Resizable.Panel id="workspace" handleRef={panel} defaultSize={57} minSize={32} collapsible collapsedSize={0} onCollapse={() => setWorkspaceOpen(false)} onExpand={() => setWorkspaceOpen(true)}>
          <div className="preview-workspace-boundary" inert={!workspaceOpen} aria-hidden={!workspaceOpen}>
            {hasTask ? <CodeWorkspace key={`${scenario.id}:${workspaceEpoch}`} scenario={scenario} initialStep={workspaceEpoch === 0 && scenario.id === "ood" ? 1 : 0} onNotice={setNotice} /> : <section className="preview-empty-workspace">暂无题目</section>}
          </div>
        </Resizable.Panel>
      </Resizable>
    </main>
    <Toast.Provider placement="bottom start" />

    <Modal isOpen={dialog !== null} onOpenChange={open => { if (!open) setDialog(null); }}>
      <Modal.Backdrop><Modal.Container size="md"><Modal.Dialog className="preview-dialog">
        <Modal.CloseTrigger aria-label="关闭" /><Modal.Header><Modal.Heading>{dialogTitle}</Modal.Heading></Modal.Header>
        <Modal.Body>
          {dialog === "screenshots" && <div className="preview-capture-list">
            {pending.length === 0 && <p>暂无截图</p>}
            {pending.map((capture, index) => <div className="preview-capture-item" key={capture.id}><span className="preview-capture-number">{index + 1}</span><strong>{capture.name}</strong><IconButton label={`移除截图 ${index + 1}`} onPress={() => setPending(previous => previous.filter(item => item.id !== capture.id))}><X size={16} /></IconButton></div>)}
          </div>}
          {dialog === "correction" && <TextArea aria-label="补充或纠正内容" fullWidth rows={6} value={input} onChange={event => setInput(event.target.value)} />}
          {dialog === "devices" && <div className="preview-device-info"><dl><div><dt>电脑端</dt><dd>未连接</dd></div><div><dt>面试官音频</dt><dd>未接入</dd></div><div><dt>麦克风</dt><dd>未接入</dd></div></dl><p>请打开电脑端 Sage</p></div>}
        </Modal.Body>
        {dialog === "correction" && <Modal.Footer><Button variant="ghost" slot="close">取消</Button><Button isDisabled={!input.trim()} onPress={() => setNotice("发送失败：服务未连接")}>发送</Button></Modal.Footer>}
      </Modal.Dialog></Modal.Container></Modal.Backdrop>
    </Modal>
  </div>;
}
