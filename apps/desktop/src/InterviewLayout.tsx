import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Resizable } from "@heroui-pro/react/resizable";
import type { PanelImperativeHandle } from "react-resizable-panels";

export function InterviewLayout({ conversation, workspace, open, onOpenChange }: {
  conversation: ReactNode; workspace: ReactNode; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const [portrait, setPortrait] = useState(false);
  const panel = useRef<PanelImperativeHandle>(null);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 600px) and (orientation: portrait)");
    const sync = () => setPortrait(query.matches);
    sync(); query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useLayoutEffect(() => {
    if (open) panel.current?.expand(); else panel.current?.collapse();
  }, [open, portrait]);
  return <Resizable orientation={portrait ? "vertical" : "horizontal"} className="preview-split" id="interview-split">
    <Resizable.Panel defaultSize={43} minSize={27} id="answers">{conversation}</Resizable.Panel>
    <Resizable.Handle className={!open ? "hidden" : undefined} aria-label="调整文字区与工作区宽度" type="line" withIndicator disabled={!open} />
    <Resizable.Panel id="workspace" handleRef={panel} defaultSize={57} minSize={32} collapsible collapsedSize={0}
      onCollapse={() => onOpenChange(false)} onExpand={() => onOpenChange(true)}>
      <div className="preview-workspace-boundary" inert={!open} aria-hidden={!open}>{workspace}</div>
    </Resizable.Panel>
  </Resizable>;
}
