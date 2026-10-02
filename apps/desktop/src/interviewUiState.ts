import type {
  AnswerRecord,
  AnswerStatus,
  AnswerStore,
  ChannelHealth,
  ChannelState,
  DeviceStatus,
  OperationRecord,
  OperationStatus,
  ServerEvent,
  Speaker,
  TranscriptState,
  TranscriptTurn,
} from "./types";

const TERMINAL_OPERATIONS = new Set<OperationStatus>(["completed", "failed", "cancelled"]);

export function mergeTranscriptTurn(turns: TranscriptTurn[], turn: TranscriptTurn): TranscriptTurn[] {
  const previous = turns.find((item) => item.turn_id === turn.turn_id);
  if (!previous) return [...turns, turn];
  if (previous.status && previous.status !== "streaming" && turn.status === "streaming") return turns;
  return turns.map((item) => item.turn_id === turn.turn_id ? { ...item, ...turn } : item);
}

export function transcriptForSpeaker(turns: TranscriptTurn[], speaker: Speaker): TranscriptState {
  let final = "";
  const partial: string[] = [];
  for (const turn of turns) {
    if (turn.speaker !== speaker) continue;
    if (turn.status === "streaming") partial.push(turn.text);
    else if (turn.text) final = turn.text;
  }
  return { final, partial: partial.filter(Boolean).join(" ") };
}

export function operationIsPending(operation: OperationRecord) {
  return !TERMINAL_OPERATIONS.has(operation.status);
}

export function mergeOperation(
  operations: OperationRecord[],
  incoming: OperationRecord,
): OperationRecord[] {
  const existing = operations.find((operation) => operation.operation_id === incoming.operation_id);
  if (existing && !operationIsPending(existing) && operationIsPending(incoming)) return operations;
  if (!existing) return [...operations, incoming];
  return operations.map((operation) => operation.operation_id === incoming.operation_id
    ? { ...operation, ...incoming }
    : operation);
}

export function visibleAnswerOrder(answers: AnswerStore) {
  return answers.order.filter((id) => answers.byId[id]);
}

export function mergeAnswerEvent(
  current: AnswerRecord,
  payload: ServerEvent,
  status: AnswerStatus,
  replaceText: boolean,
): AnswerRecord {
  if (!replaceText && current.status !== "streaming") return current;
  return {
    ...current,
    activities: payload.activities ?? current.activities,
    question: payload.question ?? current.question,
    questionId: payload.question_id ?? current.questionId,
    text: payload.type === "answer_delta"
      ? `${current.text}${payload.delta ?? payload.text ?? ""}`
      : replaceText ? (payload.text ?? "") : (payload.text ?? current.text),
    status,
    createdAt: payload.created_at ?? current.createdAt,
    detail: payload.detail ?? payload.error ?? payload.message ?? current.detail,
  };
}

export function applyChannelHealth(
  ready: boolean,
  status: DeviceStatus,
  active: boolean,
  health?: ChannelHealth,
): ChannelState {
  const phase = health?.phase;
  const message = health?.detail || health?.message;
  if (phase === "muted") return { phase, message: message || "音轨已静音，暂未收到声音" };
  if (phase === "error" || phase === "interrupted") {
    return { phase, message: message || "采集已中断，请恢复这路音频" };
  }
  if (phase === "reconnecting" || phase === "connecting") {
    return { phase, message: message || "正在连接采集设备" };
  }
  if (ready) return { phase: active ? "listening" : "ready", message: message || (active ? "采集中" : "已就绪") };
  return status === "initializing"
    ? { phase: "connecting", message: message || "初始化中" }
    : { phase: "idle", message: message || "采集设备离线" };
}

export function listeningStatus({
  connected,
  reconnecting,
  active,
  deviceStatus,
  channels,
  answering,
}: {
  connected: boolean;
  reconnecting: boolean;
  active: boolean;
  deviceStatus: DeviceStatus;
  channels: Record<Speaker, ChannelState>;
  answering: boolean;
}) {
  if (!connected) return {
    label: reconnecting ? "重新连接中" : "等待连接",
    detail: active ? "同步已中断，采集和回答状态等待恢复。" : "连接后才能确认采集状态。",
    live: false,
  };
  if (!active) return {
    label: deviceStatus === "ready" ? "准备就绪" : "设备未就绪",
    detail: deviceStatus === "ready" ? "开始后才会发送音频。" : "请查看两路音频状态。",
    live: false,
  };
  if (deviceStatus !== "ready" || Object.values(channels).some((channel) => channel.phase !== "listening" && channel.phase !== "ready")) {
    return { label: "音频需检查", detail: "至少一路采集尚未就绪，请查看设备详情。", live: false };
  }
  return { label: answering ? "回答中" : "转录中", detail: "两路音频只记录上下文，发送消息时才回答。", live: true };
}

export function operationLabel(operation: OperationRecord) {
  const name = operation.kind === "code_action" ? "代码"
    : operation.kind === "clear_screens" ? "移除附件"
    : operation.kind === "request_screen_capture" ? "截图"
    : operation.kind === "chat_stop" ? "停止生成"
    : operation.kind === "manual_text" ? "更新上下文"
    : "回答请求";
  const state: Record<OperationStatus, string> = {
    sent: "已发送，等待确认",
    accepted: "已接收",
    running: "处理中",
    completed: "已完成",
    failed: "未完成",
    cancelled: "已取消",
  };
  return `${name} · ${state[operation.status]}`;
}

export function safeAnswerLink(url: string | undefined) {
  if (!url || !/^https?:\/\//i.test(url)) return "";
  try {
    const parsed = new URL(url);
    return parsed.username || parsed.password ? "" : parsed.href;
  } catch { return ""; }
}
