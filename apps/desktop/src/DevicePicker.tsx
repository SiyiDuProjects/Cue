import { useEffect, useRef, useState } from "react";
import { Button, Description, Label, ListBox, Spinner, Surface } from "@heroui/react";
import { CaretRight, Monitor } from "@phosphor-icons/react";
import type { InterviewSession } from "./types";

interface Device { device_id: string; name: string; active: boolean }

async function result(response: Response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || "连接失败，请重试。");
  return data;
}

export function DevicePicker({ apiBaseUrl, onConnected }: {
  apiBaseUrl: string; onConnected: (session: InterviewSession) => Promise<void>;
}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState("");
  const [discoveryError, setDiscoveryError] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const joining = useRef(false);
  const connect = useRef(onConnected);
  connect.current = onConnected;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await fetch(apiBaseUrl + (waiting ? "/api/browser/connection" : "/api/devices"), {
          credentials: "include", redirect: "error", cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        const data = await result(response);
        if (controller.signal.aborted) return;
        if (!waiting) {
          if (!Array.isArray(data.devices)) throw new Error("设备列表格式不正确，请更新服务端。");
          setDevices(data.devices);
          setDiscoveryError("");
        } else if (data.status === "connected") {
          joining.current = true;
          try { await connect.current(data.session); }
          finally { joining.current = false; }
          return;
        } else if (data.status === "denied") {
          setWaiting(false);
          setError("电脑未允许连接，可以重新选择。");
          return;
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        const message = failure instanceof Error ? failure.message : "暂时无法连接服务器。";
        if (waiting) { setError(message); setWaiting(false); return; }
        setDiscoveryError(message);
      }
      if (!controller.signal.aborted) timer = setTimeout(refresh, waiting ? 1_000 : 3_000);
    }
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [apiBaseUrl, waiting]);

  async function select(deviceId: string) {
    if (joining.current || busy || waiting) return;
    joining.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await result(await fetch(`${apiBaseUrl}/api/devices/${encodeURIComponent(deviceId)}/connect`, {
        method: "POST", credentials: "include", redirect: "error",
        headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000), body: "{}",
      }));
      if (!alive.current) return;
      if (data.status === "connected") await connect.current(data.session);
      else if (data.status === "pending") setWaiting(true);
      else throw new Error("连接状态不正确，请重试。");
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : "连接失败，请重试。");
    } finally {
      joining.current = false;
      if (alive.current) setBusy(false);
    }
  }

  async function cancel() {
    if (busy) return;
    setBusy(true);
    try {
      await result(await fetch(apiBaseUrl + "/api/browser/connection", {
        method: "DELETE", credentials: "include", redirect: "error", signal: AbortSignal.timeout(10_000),
      }));
      if (alive.current) { setWaiting(false); setError(""); }
    } catch { if (alive.current) setError("取消失败，请重试。"); }
    finally { if (alive.current) setBusy(false); }
  }

  return <section className="m-auto flex w-full max-w-sm flex-col gap-4 px-6 py-8" aria-labelledby="devices-title">
    <h1 id="devices-title" className="text-xl font-semibold">{waiting ? "在电脑上确认" : "选择设备"}</h1>
    {waiting ? <>
      <p className="text-sm text-muted" role="status">首次连接需要允许控制 Sage，之后会记住此浏览器。</p>
      <Button variant="secondary" isDisabled={busy} onPress={() => void cancel()}>取消</Button>
    </> : devices?.length ? <Surface className="rounded-2xl">
      <ListBox aria-label="在线电脑" selectionMode="none" className="p-2" disabledKeys={busy ? devices.map(device => device.device_id) : []}
        onAction={key => void select(String(key))}>
        {devices.map(device => <ListBox.Item id={device.device_id} key={device.device_id} textValue={device.name} className="min-h-16 gap-3">
          <Monitor size={24} className="shrink-0 text-muted" />
          <div className="flex min-w-0 flex-1 flex-col gap-1"><Label className="truncate">{device.name}</Label><Description>{device.active ? "面试中" : "在线"}</Description></div>
          {busy ? <Spinner size="sm" /> : <CaretRight size={16} className="text-muted" />}
        </ListBox.Item>)}
      </ListBox>
    </Surface> : <p className="text-sm text-muted" role="status">{devices ? "请在电脑上打开 Sage" : "正在查找在线设备…"}</p>}
    {(error || discoveryError) && <p className="text-sm text-danger" role="alert">{error || discoveryError}</p>}
  </section>;
}
