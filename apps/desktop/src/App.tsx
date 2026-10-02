import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Dropdown, Label, ListBox, Modal, Select, TextArea, useTheme } from "@heroui/react";
import { ChatConversation } from "@heroui-pro/react/chat-conversation";
import {
  DotsThree, SidebarSimple, Sun, Moon,
  Microphone, Monitor, Play, Square, WarningCircle, X,
} from "@phosphor-icons/react";
import { requestCaptureStream } from "./audioCapture";
import { CaptureAdapter } from "./captureAdapter";
import { SessionClient, type ClientConnectionState } from "./sessionClient";
import { ChatComposer, ChatMessages } from "./Chat";
import { CopyTextButton } from "./AnswerMarkdown";
import { DevicePicker } from "./DevicePicker";
import { ConversationList, conversationRequest } from "./ConversationList";
import { applyChannelHealth, listeningStatus, mergeAnswerEvent, mergeOperation, mergeTranscriptTurn, transcriptForSpeaker, operationIsPending, operationLabel, visibleAnswerOrder } from "./interviewUiState";
import type {
  ChatRequest,
  AnswerRecord,
  AnswerStatus,
  AnswerStore,
  ChannelState,
  ChannelHealth,
  DeviceStatus,
  InterviewSession,
  ServerEvent,
  SessionPhase,
  Speaker,
  TranscriptState,
  TranscriptTurn,
  OperationRecord,
  CapturedScreen,
} from "./types";

const IS_CAPTURE_HOST = window.interviewDesktop?.captureHost === true;
const API_BASE_URL = (
  window.interviewDesktop?.apiBaseUrl ||
  import.meta.env.VITE_API_BASE_URL ||
  (IS_CAPTURE_HOST ? "https://interview.siyidu.com" : window.location.origin)
).replace(/\/+$/, "");
const CURRENT_POLL_MS = 5_000;

const EMPTY_ANSWERS: AnswerStore = { order: [], byId: {} };
const INITIAL_CHANNELS: Record<Speaker, ChannelState> = {
  interviewer: { phase: "idle", message: "采集设备离线" },
  candidate: { phase: "idle", message: "采集设备离线" },
};
const INITIAL_TRANSCRIPTS: Record<Speaker, TranscriptState> = {
  interviewer: { final: "", partial: "" },
  candidate: { final: "", partial: "" },
};

interface CurrentInterviewResponse extends InterviewSession {
  expires_at?: string;
  device_status?: {
    status?: string;
    channels?: Partial<Record<Speaker, boolean>>;
    channel_details?: Partial<Record<Speaker, ChannelHealth>>;
  };
  interview_state?: { active?: boolean; stopping?: boolean };
}

export default function App() {
  const { resolvedTheme, setTheme } = useTheme("light");
  useEffect(() => {
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", resolvedTheme === "dark" ? "dark" : "light");
  }, [resolvedTheme]);
  const [sessionPhase, setSessionPhase] = useState<SessionPhase>("idle");
  const [mode, setMode] = useState<"assist" | "mock">("assist");
  const [modeBusy, setModeBusy] = useState(false);
  const audioModeRef = useRef<"assist" | "mock">("assist");
  const [audioPrepared, setAudioPrepared] = useState(false);
  const [mockStatus, setMockStatus] = useState({ status: "idle", detail: "" });
  const [connectionState, setConnectionState] =
    useState<ClientConnectionState>("disconnected");
  const [deviceStatus, setDeviceStatus] = useState<DeviceStatus>(
    IS_CAPTURE_HOST ? "initializing" : "offline",
  );
  const [channels, setChannels] = useState<Record<Speaker, ChannelState>>(INITIAL_CHANNELS);
  const [transcripts, setTranscripts] =
    useState<Record<Speaker, TranscriptState>>(INITIAL_TRANSCRIPTS);
  const [messages, setMessages] = useState<ChatRequest[]>([]);
  const [chatAvailable, setChatAvailable] = useState(false);
  const [correctingTurn, setCorrectingTurn] = useState<TranscriptTurn | null>(null);
  const [answers, setAnswers] = useState<AnswerStore>(EMPTY_ANSWERS);
  const [interviewActive, setInterviewActive] = useState(false);
  const [manualText, setManualText] = useState("");
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [currentQuestionId, setCurrentQuestionId] = useState<string | undefined>();
  const [collectedScreens, setCollectedScreens] = useState<CapturedScreen[]>([]);
  const [operations, setOperations] = useState<OperationRecord[]>([]);
  const [toolError, setToolError] = useState<string | null>(null);
  const [modelStatus, setModelStatus] = useState<{ status: string; detail?: string }>({ status: "ready" });
  const [modelRecoveryNotice, setModelRecoveryNotice] = useState<string | null>(null);
  const [sessionMetrics, setSessionMetrics] = useState<Record<string, unknown>>({});
  const [contextStatus, setContextStatus] = useState<{ documents: number; characters: number } | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const [screenSources, setScreenSources] = useState<InterviewScreenSource[]>([]);
  const [screenPickerOpen, setScreenPickerOpen] = useState(false);
  const [screenBusy, setScreenBusy] = useState(false);
  const [selectedScreenName, setSelectedScreenName] = useState("");
  const [recoveringChannel, setRecoveringChannel] = useState<Speaker | null>(null);
  const answerStageRef = useRef<HTMLDivElement>(null);
  const [answerSnapshotComplete, setAnswerSnapshotComplete] = useState(false);
  const modelRecoveringRef = useRef(false);
  const [authRequired, setAuthRequired] = useState(!IS_CAPTURE_HOST);
  const [browserConnection, setBrowserConnection] = useState<{ request_id: string; name: string; read_only?: boolean } | null>(null);
  const [initializationFailed, setInitializationFailed] = useState(false);
  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const [conversationsOpen, setConversationsOpen] = useState(false);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [conversationTitle, setConversationTitle] = useState("新对话");
  const [switchTarget, setSwitchTarget] = useState<string | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [newTranscriptionOpen, setNewTranscriptionOpen] = useState(false);
  const [detailView, setDetailView] = useState<"transcript" | "device">("device");
  const [detailOpen, setDetailOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<InterviewSession | null>(null);
  const displayedSessionIdRef = useRef<string | null>(null);
  const sessionClientRef = useRef<SessionClient | null>(null);
  const captureAdapterRef = useRef<CaptureAdapter | null>(null);
  const initializationInFlightRef = useRef(false);
  const hostEnsurePromiseRef = useRef<Promise<void> | null>(null);
  const browserRequestInFlightRef = useRef(false);
  const pollTimerRef = useRef<number | undefined>(undefined);
  const disposedRef = useRef(false);
  const operationRef = useRef(0);
  const activeRef = useRef(false);

  const visibleAnswerIds = useMemo(() => visibleAnswerOrder(answers), [answers]);
  const answerList = useMemo(() => visibleAnswerIds.map((id) => answers.byId[id]), [answers, visibleAnswerIds]);
  const clientReady = connectionState === "connected";
  const pendingOperations = operations.filter(operationIsPending);
  const screenshotBusy = pendingOperations.some((operation) => operation.kind === "request_screen_capture");

  function followLatestAnswer() {
    const stage = answerStageRef.current;
    // Explicit send returns to the current turn; the component owns all following.
    stage?.scrollTo({ top: stage.scrollHeight, behavior: "instant" });
  }


  function dispatchControl(payload: Record<string, unknown>): string | null {
    const operationId = typeof payload.operation_id === "string" ? payload.operation_id : crypto.randomUUID();
    if (!sessionClientRef.current?.send({ ...payload, conversation_id: sessionRef.current?.conversation_id, operation_id: operationId })) {
      setError("会话同步正在重连，请稍后再试。");
      return null;
    }
    setOperations((current) => mergeOperation(current, { operation_id: operationId, kind: String(payload.type), status: "sent", ...(typeof payload.action === "string" ? { action: payload.action } : {}) }));
    setError(null);
    return operationId;
  }

  async function chooseScreen() {
    setScreenBusy(true);
    try {
      const listSources = window.interviewDesktop?.listScreenSources;
      if (!listSources) throw new Error("请在 Electron 桌面端选择要读取的屏幕或窗口。");
      const sources = await listSources();
      setScreenSources(sources);
      const selected = sources.find((source) => source.selected);
      setSelectedScreenName(selected?.name || "");
      setScreenPickerOpen(true);
    } catch (screenError) { setError(errorMessage(screenError, "无法列出屏幕。")); }
    finally { setScreenBusy(false); }
  }

  async function selectScreen(source: InterviewScreenSource) {
    setScreenBusy(true);
    try {
      const selection = await window.interviewDesktop?.selectScreenSource?.(source.id);
      if (!selection) throw new Error("屏幕选择接口不可用，请重新打开桌面端。");
      setSelectedScreenName(selection.name);
      setScreenPickerOpen(false);
    } catch (screenError) { setError(errorMessage(screenError, "无法选择屏幕。")); }
    finally { setScreenBusy(false); }
  }

  async function recoverChannel(speaker: Speaker) {
    const adapter = captureAdapterRef.current;
    if (!adapter || recoveringChannel) return;
    setRecoveringChannel(speaker);
    try {
      if (speaker === "interviewer" && adapter.mode === "mock") await adapter.prepareMode("mock");
      else adapter.replaceChannel(speaker, await requestCaptureStream(speaker));
      setError(null);
    } catch (captureError) { setError(errorMessage(captureError, "这路音频恢复失败，请重试。")); }
    finally { setRecoveringChannel(null); }
  }

  function openDetails(view: typeof detailView) {
    setDetailView(view);
    setDetailOpen(true);
  }

  function selectConversation(identity: string | null) {
    setConversationsOpen(false);
    if (identity === (sessionRef.current?.conversation_id || sessionRef.current?.interview_id) || switchBusy) return;
    setSwitchTarget(identity);
    if (pendingOperations.some(op => op.kind === "chat_send")) setStopConfirmOpen(true);
    else void switchConversation(identity, false);
  }

  async function switchConversation(identity: string | null, stopActive: boolean) {
    const session = sessionRef.current;
    if (!session || switchBusy) return;
    setSwitchBusy(true); setStopConfirmOpen(false); setError(null);
    try {
      const next = await conversationRequest(API_BASE_URL, session, "switch", { target_id: identity, stop_active: stopActive });
      // The server broadcasts a chat reset on the existing socket. Do not
      // tear down CaptureAdapter or the audio streams when changing chats.
      if (sessionRef.current) sessionRef.current.conversation_id = next.conversation_id;

    } catch (e) { setError(errorMessage(e, "切换会话失败，原内容保留。")); }
    finally { setSwitchBusy(false); }
  }

  useEffect(() => {
    activeRef.current = interviewActive;
  }, [interviewActive]);

  useEffect(() => {
    let disposed = false;
    void window.interviewDesktop?.getWindowState?.().then((state) => {
      if (!disposed) setRecoveryNotice(state.recoveryNotice || null);
    }).catch(() => { if (!disposed) setError("无法同步桌面状态，请重新打开桌面端。"); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    disposedRef.current = false;
    const handleCaptureInitialization = () => {
      if (initializationInFlightRef.current) {
        return;
      }

      initializationInFlightRef.current = true;
      setInitializationFailed(false);
      setDeviceStatus("initializing");
      setError(null);
      setChannel("candidate", "connecting", "初始化麦克风");
      setChannel("interviewer", "connecting", "初始化系统音频");

      // Both permission requests must be created in the same user-gesture task.
      const candidatePromise = requestCaptureStream("candidate");
      const interviewerPromise = audioModeRef.current === "mock" ? Promise.resolve(null) : requestCaptureStream("interviewer");
      void finishCaptureInitialization(candidatePromise, interviewerPromise);
    };

    if (IS_CAPTURE_HOST) {
      window.addEventListener("sage:capture-initialize", handleCaptureInitialization);
    }

    const bootstrapTimer = window.setTimeout(() => {
      if (!IS_CAPTURE_HOST) return;
      let adapter: CaptureAdapter;
      adapter = new CaptureAdapter(API_BASE_URL, {}, {
        onChannelChange: (speaker, state) => {
          if (captureAdapterRef.current === adapter) setChannels(current => ({ ...current, [speaker]: state }));
        },
        onError: message => setError(message),
        onMediaEnded: speaker => handleMediaEnded(adapter, speaker),
        onSessionEnded: () => handleSessionEnded(),
        onPrepareCapture: nextMode => {
          if (initializationInFlightRef.current) return;
          audioModeRef.current = nextMode;
          setMode(nextMode);
          setAudioPrepared(false);
          setSessionPhase("starting");
          void requestCaptureInitialization().catch(reportCaptureInitializationFailure);
        },
        onBrowserConnectionRequest: request => {
          setBrowserConnection(request);
        },
      });
      captureAdapterRef.current = adapter;
      void ensureHostSession();
    }, 0);

    return () => {
      disposedRef.current = true;
      operationRef.current += 1;
      window.clearTimeout(bootstrapTimer);
      if (IS_CAPTURE_HOST) {
        window.removeEventListener("sage:capture-initialize", handleCaptureInitialization);
      }
      clearPollTimer();
      sessionClientRef.current?.stop();
      sessionClientRef.current = null;
      captureAdapterRef.current?.dispose();
      captureAdapterRef.current = null;
    };
  }, []);

  async function finishCaptureInitialization(
    candidatePromise: Promise<MediaStream>,
    interviewerPromise: Promise<MediaStream | null>,
  ) {
    const startingSession = sessionRef.current;
    let candidateStream: MediaStream | null = null;
    let interviewerStream: MediaStream | null = null;
    try {
      const [candidateResult, interviewerResult] = await Promise.all([
        settleMediaRequest(candidatePromise),
        interviewerPromise.then(stream => ({ ok: true as const, stream }), error => ({ ok: false as const, error })),
      ]);
      if (!candidateResult.ok || !interviewerResult.ok) {
        if (candidateResult.ok) {
          candidateResult.stream.getTracks().forEach((track) => track.stop());
        }
        if (interviewerResult.ok) {
          interviewerResult.stream?.getTracks().forEach((track) => track.stop());
        }
        if (!candidateResult.ok) throw candidateResult.error;
        if (!interviewerResult.ok) throw interviewerResult.error;
      }
      candidateStream = candidateResult.stream;
      interviewerStream = interviewerResult.stream;
      if (disposedRef.current || sessionRef.current !== startingSession) {
        candidateStream.getTracks().forEach((track) => track.stop());
        interviewerStream?.getTracks().forEach((track) => track.stop());
        return;
      }

      const adapter = captureAdapterRef.current;
      if (!adapter) throw new Error("桌面连接已关闭，请重试。");
      adapter.replaceChannel("candidate", candidateStream);
      candidateStream = null;
      if (interviewerStream) {
        adapter.replaceChannel("interviewer", interviewerStream);
        interviewerStream = null;
      }
      await adapter.prepareMode(audioModeRef.current);
      if (sessionRef.current === startingSession && !disposedRef.current) setAudioPrepared(true);
    } catch (initializationError) {
      captureAdapterRef.current?.stopAudio();
      setAudioPrepared(false);
      setSessionPhase("idle");
      sessionClientRef.current?.send({ type: "stop_transcription" });
      candidateStream?.getTracks().forEach((track) => track.stop());
      interviewerStream?.getTracks().forEach((track) => track.stop());
      if (!disposedRef.current) {
        setInitializationFailed(true);
        setDeviceStatus("error");
        setError(errorMessage(initializationError, "采集设备初始化失败。"));
        setChannels({
          interviewer: { phase: "error", message: "初始化失败" },
          candidate: { phase: "error", message: "初始化失败" },
        });
      }
    } finally {
      initializationInFlightRef.current = false;
    }
  }

  useEffect(() => {
    if (!audioPrepared || deviceStatus !== "ready" || !clientReady) return;
    setAudioPrepared(false);
    if (!sessionClientRef.current?.send({ type: "start_transcription", mode: audioModeRef.current })) {
      captureAdapterRef.current?.stopAudio();
      setSessionPhase("idle");
      setError("连接已断开，请重试转录。");
    }
  }, [audioPrepared, deviceStatus, clientReady]);

  async function ensureHostSession() {
    if (!IS_CAPTURE_HOST || !captureAdapterRef.current || disposedRef.current) {
      return;
    }
    if (hostEnsurePromiseRef.current) {
      return hostEnsurePromiseRef.current;
    }

    const operation = operationRef.current + 1;
    operationRef.current = operation;
    const promise = (async () => {
      setSessionPhase("starting");
      setDeviceStatus("initializing");
      setInitializationFailed(false);
      try {
        const session = await createInterviewSession();
        if (disposedRef.current || operationRef.current !== operation) {
          return;
        }
        prepareForSession(session);
        const adapter = captureAdapterRef.current;
        if (!adapter) {
          throw new Error("采集设备尚未初始化。");
        }
        await Promise.all([connectSessionClient(session), adapter.connect(session)]);
        if (operationRef.current === operation) {
          setError(null);
        }
      } catch (sessionError) {
        if (!disposedRef.current && operationRef.current === operation) {
          sessionClientRef.current?.stop();
          sessionClientRef.current = null;
          captureAdapterRef.current?.disconnectSession();
          setSessionPhase("idle");
          setDeviceStatus("error");
          setInitializationFailed(true);
          setError(errorMessage(sessionError, "连接采集会话失败。"));
        }
      }
    })();
    hostEnsurePromiseRef.current = promise;
    try {
      await promise;
    } finally {
      if (hostEnsurePromiseRef.current === promise) {
        hostEnsurePromiseRef.current = null;
      }
    }
  }

  async function loadBrowserCurrentInterview() {
    if (IS_CAPTURE_HOST || disposedRef.current || browserRequestInFlightRef.current) {
      return;
    }
    browserRequestInFlightRef.current = true;
    clearPollTimer();
    try {
      const response = await fetch(`${API_BASE_URL}/api/interviews/current`, {
        method: "GET",
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (response.status === 401) {
        setAuthRequired(true);
        setDeviceOffline("请选择设备");
        return;
      }
      setAuthRequired(false);
      if (response.status === 204) {
        if (sessionRef.current) {
          handleSessionEnded();
        } else {
          setDeviceOffline("采集设备离线");
          scheduleCurrentPoll();
        }
        return;
      }
      if (!response.ok) {
        throw new Error(await readResponseError(response));
      }

      const current = (await response.json()) as CurrentInterviewResponse;
      const session = parseInterviewSession(current, false);
      applyDeviceStatus(current.device_status?.status, current.device_status?.channels, current.device_status?.channel_details);
      applyInterviewState(Boolean(current.interview_state?.active), Boolean(current.interview_state?.stopping));

      if (
        sessionRef.current?.interview_id === session.interview_id &&
        sessionClientRef.current?.isReady()
      ) {
        return;
      }
      prepareForSession(session);
      await connectSessionClient(session);
      setError(null);
    } catch (currentError) {
      if (!disposedRef.current) {
        setError(errorMessage(currentError, "获取当前面试失败。"));
        setDeviceOffline("采集设备离线");
        scheduleCurrentPoll();
      }
    } finally {
      browserRequestInFlightRef.current = false;
    }
  }

  function prepareForSession(session: InterviewSession) {
    if (displayedSessionIdRef.current !== (session.conversation_id || session.interview_id)) {
      displayedSessionIdRef.current = session.conversation_id || session.interview_id;
      setAnswers(EMPTY_ANSWERS);
      setMessages([]);
      setConversationTitle("新对话");
      setChatAvailable(false);
      setTranscripts(INITIAL_TRANSCRIPTS);
      setTurns([]);

      setCurrentQuestionId(undefined);

      setCollectedScreens([]);
      setOperations([]);

      setManualText("");
      setCorrectionOpen(false);

      setToolError(null);


      setAnswerSnapshotComplete(false);
      setModelStatus({ status: "ready" });
      setModelRecoveryNotice(null);
      modelRecoveringRef.current = false;
      setSessionMetrics({});
      setContextStatus(null);

    }
    sessionRef.current = session;
  }

  async function connectSessionClient(session: InterviewSession) {
    sessionClientRef.current?.stop();
    let client: SessionClient;
    client = new SessionClient(API_BASE_URL, session, {
      onConnectionChange: (state) => {
        if (sessionClientRef.current === client) {
          setConnectionState(state);
          if (state !== "connected") setAnswerSnapshotComplete(false);
        }
      },
      onEvent: (event) => {
        if (sessionClientRef.current === client) {
          handleServerEvent(event);
        }
      },
      onError: (message) => {
        if (sessionClientRef.current === client) {
          setError(message);
        }
      },
      onSessionUnavailable: () => {
        if (sessionClientRef.current === client) {
          handleSessionEnded();
        }
      },
    });
    sessionClientRef.current = client;
    await client.start();
  }

  async function connectBrowserDevice(value: InterviewSession) {
    const session = parseInterviewSession(value, false);
    prepareForSession(session);
    await connectSessionClient(session);
    setAuthRequired(false);
    setError(null);
  }

  function decideBrowserConnection(approved: boolean) {
    if (!browserConnection) return;
    if (captureAdapterRef.current?.decideBrowserConnection(browserConnection.request_id, approved)) setBrowserConnection(null);
    else { setBrowserConnection(null); setError("电脑连接已断开，请让浏览器重新连接。"); }
  }

  async function chooseMode(nextMode: "assist" | "mock") {
    if (activeRef.current || initializationInFlightRef.current) return;
    audioModeRef.current = nextMode;
    setMode(nextMode);
  }

  async function restartMock() {
    if (modeBusy || !clientReady) return;
    setModeBusy(true);
    try {
      if (IS_CAPTURE_HOST) await captureAdapterRef.current?.prepareMode("mock");
      if (!sessionClientRef.current?.send({ type: "mock_restart" })) throw new Error("会话正在重连。");
    } catch (error) { setError(errorMessage(error, "恢复面试官失败。")); }
    finally { setModeBusy(false); }
  }

  async function startTranscription() {
    if (!clientReady || sessionPhase === "starting" || modeBusy) return;
    setError(null);
    setSessionPhase("starting");
    if (!sessionClientRef.current?.send({ type: "start_transcription", mode })) {
      setSessionPhase("idle");
      setError("连接正在恢复，请稍后重试。");
    }
  }

  function stopTranscription() {
    setAudioPrepared(false);
    setSessionPhase("stopping");
    if (!sessionClientRef.current?.send({ type: "stop_transcription" })) {
      setSessionPhase(activeRef.current ? "live" : "idle");
      setError("连接正在恢复，请稍后重试。");
    }
  }

  async function confirmConversationSwitch() {
    await switchConversation(switchTarget, true);
  }

  function collectScreen() {
    if (!clientReady || screenshotBusy || screenBusy) return;
    dispatchControl({ type: "request_screen_capture", question_id: currentQuestionId, collect_only: true });
  }

  async function retryCaptureInitialization() {
    setInitializationFailed(false);
    setError(null);
    try {
      if (captureAdapterRef.current) {
        if (clientReady) await requestCaptureInitialization();
        else await ensureHostSession();
      } else {
        await requestCaptureInitialization();
      }
    } catch (retryError) {
      reportCaptureInitializationFailure(retryError);
    }
  }

  function reportCaptureInitializationFailure(initializationError: unknown) {
    if (disposedRef.current) {
      return;
    }
    setInitializationFailed(true);
    setAudioPrepared(false);
    setSessionPhase("idle");
    sessionClientRef.current?.send({ type: "stop_transcription" });
    setDeviceStatus("error");
    setChannels({
      interviewer: { phase: "error", message: "初始化失败" },
      candidate: { phase: "error", message: "初始化失败" },
    });
    setError(errorMessage(initializationError, "采集设备初始化失败，请检查系统设置。"));
  }

  function handleServerEvent(payload: ServerEvent) {
    switch (payload.type) {
      case "conversation_reset":
        if (sessionRef.current && payload.conversation_id) {
          sessionRef.current = { ...sessionRef.current, conversation_id: payload.conversation_id };
          displayedSessionIdRef.current = payload.conversation_id;
          setAnswers(EMPTY_ANSWERS); setMessages([]); setCollectedScreens([]); setOperations([]);
          setAnswerSnapshotComplete(false); setToolError(null); setConversationTitle("新对话");
        }
        return;
      case "chat_snapshot":
        setMessages(payload.messages || []);
        return;
      case "chat_message":
        if (payload.chat_message) {
          const message = payload.chat_message;
          setMessages(current => current.some(item => item.message_id === message.message_id)
            ? current.map(item => item.message_id === message.message_id ? message : item) : [...current, message]);
        }
        return;
      case "session_ready":
        setChatAvailable(payload.chat === true);
        return;
      case "context_status":
        setContextStatus({ documents: payload.documents_count ?? 0, characters: payload.characters_count ?? 0 });
        return;
      case "screen_collection":
        setCollectedScreens(payload.screens || []);
        return;
      case "device_status":
        if (!IS_CAPTURE_HOST && payload.mode) setMode(payload.mode);
        applyDeviceStatus(payload.status, payload.channels, payload.channel_details);
        return;
      case "interview_state":
        if (payload.active && payload.mode) setMode(payload.mode);
        applyInterviewState(Boolean(payload.active), Boolean(payload.stopping));
        return;
      case "mock_status":
        setMockStatus({ status: payload.status || "idle", detail: payload.detail || "" });
        return;
      case "question_state":
        setCurrentQuestionId(payload.current_question_id);
        return;
      case "model_status":
        if (payload.status === "recovering") modelRecoveringRef.current = true;
        else if (payload.status === "ready" && modelRecoveringRef.current) {
          setModelRecoveryNotice("模型连接已恢复，已记录的上下文保留。断线期间未被处理的音频需要重说或手动补充。");
          modelRecoveringRef.current = false;
        }
        setModelStatus({ status: payload.status || "ready", detail: payload.detail });
        return;
      case "session_metrics":
        setSessionMetrics(payload.metrics || payload as unknown as Record<string, unknown>);
        return;
      case "answer_snapshot_done":
        setAnswerSnapshotComplete(true);
        return;
      case "operation_snapshot":
        setOperations((current) => {
          const restored = (payload.operations || []).map((operation) => ({ ...current.find((item) => item.operation_id === operation.operation_id), ...operation }));
          // A send lost before server acceptance must release the composer,
          // while retaining its draft and attachments for an explicit retry.
          const unconfirmed = current.filter(item => item.status === "sent" && !restored.some(op => op.operation_id === item.operation_id))
            .map(item => ({ ...item, status: "failed" as const, detail: "发送未确认，草稿已保留，请重试。" }));
          return [...restored, ...unconfirmed];
        });
        return;
      case "operation_status": {
        if (!payload.operation_id || !["accepted", "running", "completed", "failed", "cancelled"].includes(payload.status || "")) return;
        const operation = { ...payload, kind: payload.kind || "control", status: payload.status } as OperationRecord;
        setOperations((current) => mergeOperation(current, operation));
        if (payload.status === "failed") {
          setError(payload.detail || "操作未完成，请重试。");
          setSessionPhase(activeRef.current ? "live" : "idle");
        }
        return;
      }
      case "tool_error":
        setToolError(payload.detail || payload.error || "工具未完成，当前会话继续回答。");
        return;
      case "transcript_snapshot": {
        const next: Record<Speaker, TranscriptState> = {
          interviewer: { final: "", partial: "" },
          candidate: { final: "", partial: "" },
        };
        payload.turns?.forEach((turn) => {
          if ((turn.speaker === "interviewer" || turn.speaker === "candidate") && turn.text) {
            next[turn.speaker] = { final: turn.text, partial: "" };
          }
        });
        setTranscripts(next);
        setTurns((payload.turns || []).filter((turn) => turn.turn_id && parseSpeaker(turn.speaker) && typeof turn.text === "string") as TranscriptTurn[]);
        return;
      }
      case "transcript_delta": {
        const speaker = parseSpeaker(payload.speaker);
        if (speaker && payload.turn_id && typeof payload.text === "string") {
          setTurns((current) => mergeTranscriptTurn(current, {
            turn_id: payload.turn_id!, speaker, text: payload.text!, status: "streaming",
            question_id: payload.question_id, created_at: payload.created_at,
          }));
          return;
        }
        const delta = payload.delta ?? payload.text ?? "";
        if (!speaker || !delta) {
          return;
        }
        setTranscripts((current) => ({
          ...current,
          [speaker]: {
            ...current[speaker],
            partial: `${current[speaker].partial}${delta}`,
          },
        }));
        return;
      }
      case "transcript_final": {
        const speaker = parseSpeaker(payload.speaker);
        if (!speaker) {
          return;
        }
        if (speaker && payload.turn_id && typeof payload.text === "string") {
          setTurns((current) => mergeTranscriptTurn(current, {
            turn_id: payload.turn_id!, speaker, text: payload.text!,
            status: payload.status === "interrupted" ? "interrupted" : "completed",
            question_id: payload.question_id, created_at: payload.created_at,
          }));
          return;
        }
        setTranscripts((current) => ({
          ...current,
          [speaker]: {
            final: payload.text ?? payload.delta ?? current[speaker].partial,
            partial: "",
          },
        }));
        if (payload.turn_id && typeof payload.text === "string") {
          const turn: TranscriptTurn = { turn_id: payload.turn_id, speaker, text: payload.text, question_id: payload.question_id, created_at: payload.created_at, kind: payload.kind };
          setTurns((current) => current.some((item) => item.turn_id === turn.turn_id)
            ? current.map((item) => item.turn_id === turn.turn_id ? turn : item) : [...current, turn]);
        }
        return;
      }
      case "answer_started":
      case "answer_delta":
      case "answer_activity":
        updateAnswerFromEvent(payload, "streaming", false);
        return;
      case "answer_snapshot":
        updateAnswerFromEvent(payload, parseAnswerStatus(payload.status), true);
        return;
      case "answer_completed":
        updateAnswerFromEvent(payload, "completed", false);
        return;
      case "answer_interrupted":
        updateAnswerFromEvent(payload, "interrupted", false);
        return;
      case "answer_error":
        updateAnswerFromEvent(payload, "error", false);
        return;
      case "session_ended":
        handleSessionEnded();
        return;
      case "conversation_info":
        if (sessionRef.current && payload.conversation_id) {
          if (displayedSessionIdRef.current !== payload.conversation_id) {
            setAnswers(EMPTY_ANSWERS); setMessages([]); setOperations([]);
          }
          sessionRef.current.conversation_id = payload.conversation_id;
          displayedSessionIdRef.current = payload.conversation_id;
        }
        if (payload.title) setConversationTitle(payload.title);
        return;
      case "persistence_error":
        setError(payload.detail || "会话未保存，请勿关闭或切换。");
        return;
      case "error": {
        const detail = payload.detail ?? payload.error ?? payload.message ?? "实时会话发生错误。";
        if (payload.response_id) {
          updateAnswerFromEvent({ ...payload, detail }, "error", false);
        } else {
          setSessionPhase(activeRef.current ? "live" : "idle");
          setError(detail);
        }
        return;
      }
      default:
        return;
    }
  }

  function updateAnswerFromEvent(
    payload: ServerEvent,
    status: AnswerStatus,
    replaceText: boolean,
  ) {
    if (!payload.response_id) {
      return;
    }
    updateAnswer(payload.response_id, (current) => mergeAnswerEvent(current, payload, status, replaceText));
  }

  function updateAnswer(responseId: string, update: (current: AnswerRecord) => AnswerRecord) {
    setAnswers((current) => {
      const existing = current.byId[responseId];
      const base: AnswerRecord =
        existing ?? {
          responseId,
          text: "",
          status: "streaming",
          createdAt: new Date().toISOString(),
        };
      const next = update(base);
      if (existing && next === existing) {
        return current;
      }
      return {
        order: existing ? current.order : [...current.order, responseId],
        byId: { ...current.byId, [responseId]: next },
      };
    });
  }

  function applyDeviceStatus(
    rawStatus: string | undefined,
    channelReady: Partial<Record<Speaker, boolean>> | undefined,
    details?: Partial<Record<Speaker, ChannelHealth>>,
  ) {
    if (IS_CAPTURE_HOST && !captureAdapterRef.current) {
      if (!initializationInFlightRef.current) {
        setDeviceStatus("error");
        setInitializationFailed(true);
      }
      return;
    }
    const status: DeviceStatus =
      rawStatus === "initializing" || rawStatus === "ready" || rawStatus === "error" ? rawStatus : "offline";
    setDeviceStatus(status);
    setInitializationFailed(false);
    setChannels((current) => {
      const next = { ...current };
      (["interviewer", "candidate"] as Speaker[]).forEach((speaker) => {
        const ready = channelReady?.[speaker] === true;
        next[speaker] = applyChannelHealth(ready, status, activeRef.current, details?.[speaker]);
      });
      return next;
    });
  }

  function applyInterviewState(active: boolean, stopping = false) {
    activeRef.current = active;
    setInterviewActive(active);
    setSessionPhase(stopping ? "stopping" : active ? "live" : "idle");
    setChannels((current) => ({
      interviewer:
        ["listening", "ready"].includes(current.interviewer.phase)
          ? { ...current.interviewer, phase: active ? "listening" : "ready", message: active ? "采集中" : "已就绪" }
          : current.interviewer,
      candidate:
        ["listening", "ready"].includes(current.candidate.phase)
          ? { ...current.candidate, phase: active ? "listening" : "ready", message: active ? "采集中" : "已就绪" }
          : current.candidate,
    }));
  }

  function handleSessionEnded() {
    if (!sessionRef.current) {
      return;
    }
    setStopConfirmOpen(false);
    operationRef.current += 1;
    hostEnsurePromiseRef.current = null;
    sessionRef.current = null;
    sessionClientRef.current?.stop();
    sessionClientRef.current = null;
    setAudioPrepared(false);
    captureAdapterRef.current?.disconnectSession();
    markStreamingAnswersInterrupted("会话已断开，已有内容保留。");
    activeRef.current = false;
    setInterviewActive(false);
    setSessionPhase("idle");
    setConnectionState("disconnected");
    setDeviceStatus(IS_CAPTURE_HOST && captureAdapterRef.current ? "initializing" : "offline");
    if (IS_CAPTURE_HOST && captureAdapterRef.current) {
      window.setTimeout(() => { if (!sessionRef.current) void ensureHostSession(); }, 500);
    } else if (!IS_CAPTURE_HOST) {
      scheduleCurrentPoll(500);
    }
  }

  function handleMediaEnded(adapter: CaptureAdapter, speaker: Speaker) {
    if (captureAdapterRef.current !== adapter) {
      return;
    }
    setDeviceStatus("error");
    setChannel(speaker, "error", "采集已停止");
    setError(`${speaker === "candidate" ? "麦克风" : "系统音频"}采集已停止，请在设备详情中恢复这路音频。`);
  }

  function setDeviceOffline(message: string) {
    setDeviceStatus("offline");
    setInterviewActive(false);
    activeRef.current = false;
    setSessionPhase("idle");
    setChannels({
      interviewer: { phase: "idle", message },
      candidate: { phase: "idle", message },
    });
  }

  function scheduleCurrentPoll(delay = CURRENT_POLL_MS) {
    // This is called after a connected session ends or becomes unavailable.
    // Do not capture the device picker's former login state in socket callbacks.
    if (IS_CAPTURE_HOST || disposedRef.current) {
      return;
    }
    clearPollTimer();
    pollTimerRef.current = window.setTimeout(() => {
      pollTimerRef.current = undefined;
      void loadBrowserCurrentInterview();
    }, delay);
  }

  function clearPollTimer() {
    if (pollTimerRef.current !== undefined) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = undefined;
    }
  }

  function setChannel(speaker: Speaker, phase: ChannelState["phase"], message: string) {
    setChannels((current) => ({ ...current, [speaker]: { phase, message } }));
  }

  function markStreamingAnswersInterrupted(detail: string) {
    setAnswers((current) => {
      let changed = false;
      const byId = { ...current.byId };
      current.order.forEach((responseId) => {
        const answer = byId[responseId];
        if (answer?.status === "streaming") {
          changed = true;
          byId[responseId] = { ...answer, status: "interrupted", detail };
        }
      });
      return changed ? { order: current.order, byId } : current;
    });
  }

  const startDisabled = !clientReady || sessionPhase === "starting" || sessionPhase === "stopping" || authRequired || modeBusy;
  const startLabel = sessionPhase === "starting" ? "准备音频…" : (mode === "mock" ? "开始模拟" : "开始转录");

  const liveStatus = listeningStatus({ connected: clientReady, reconnecting: connectionState === "reconnecting", active: interviewActive, deviceStatus, channels, answering: answerList.some((answer) => answer.status === "streaming") });
  const modelConnecting = ["connecting", "recovering"].includes(modelStatus.status);
  const statusText = clientReady && interviewActive && !modelConnecting ? "转录中" : clientReady && interviewActive && modelConnecting
    ? modelStatus.status === "recovering" ? "转录重连中" : "转录连接中"
    : clientReady ? "转录未开启" : liveStatus.label;
  const latestOperation = pendingOperations[pendingOperations.length - 1] || operations[operations.length - 1];

  const chatBusy = pendingOperations.some(op => op.kind === "chat_send");
  const conversation = <section className="preview-conversation" aria-label="面试聊天">
    {!authRequired && <div className="preview-session-controls">
      <Button variant="ghost" className="sage-conversation-trigger" aria-label="打开会话列表" onPress={() => setConversationsOpen(true)}><SidebarSimple size={19} /><span>{conversationTitle}</span></Button>
      <div className="preview-session-actions" aria-label="转录控制">
        <Button variant="ghost" onPress={() => void openDetails("transcript")}>查看转录</Button>
        {interviewActive || sessionPhase === "stopping" ? <Button variant="ghost" isDisabled={sessionPhase === "stopping"} onPress={stopTranscription}>{sessionPhase === "stopping" ? "正在收尾…" : mode === "mock" ? "停止模拟" : "停止转录"}</Button>
          : <Button variant="ghost" isDisabled={startDisabled} onPress={() => void startTranscription()}>{startLabel}</Button>}
      </div>
    </div>}
    <div className="session-notices">
        {mode === "mock" && <div className="mode-controls" role="status">
          <span>{interviewActive ? mockStatus.detail || "正在准备 AI 面试官…" : "AI 语音提问，需要时在聊天中求助。建议戴耳机；会额外运行一位 AI 面试官。"}</span>
          {interviewActive && mockStatus.status === "error" && <Button size="sm" variant="secondary"
            isDisabled={modeBusy || !clientReady} onPress={() => void restartMock()}>恢复面试官</Button>}
        </div>}
        {error ? <NoticeBanner text={error} onDismiss={() => setError(null)} /> : null}
        {toolError ? <NoticeBanner text={toolError} onDismiss={() => setToolError(null)} /> : null}
        {recoveryNotice ? <NoticeBanner text={recoveryNotice} onDismiss={() => setRecoveryNotice(null)} /> : null}
        {modelRecoveryNotice ? <NoticeBanner text={modelRecoveryNotice} onDismiss={() => setModelRecoveryNotice(null)} /> : null}
        {modelStatus.status === "recovering" && <div className="error-banner" role="status"><WarningCircle size={18} /><span>{modelStatus.detail || "模型连接正在恢复，这段时间的音频可能未被完整处理。"}</span></div>}
        {contextStatus?.characters === 0 && <div className="error-banner" role="status"><WarningCircle size={18} /><span>本场未加载有效背景资料。个人经历问题需要手动补充，或配置资料后开启新对话。</span></div>}

    </div>
        {authRequired && <DevicePicker apiBaseUrl={API_BASE_URL} onConnected={connectBrowserDevice} />}

    {!authRequired && <>
      <ChatConversation key={`conversation:${displayedSessionIdRef.current ?? "new"}`} ref={answerStageRef}
        className="preview-answer-scroll" aria-label="聊天记录" tabIndex={0} initial="instant" resize="instant">
        <ChatConversation.Content className="preview-answer-content">
          <ChatMessages messages={messages} answers={answers} operations={operations} busy={chatBusy} />
        </ChatConversation.Content>
        <ChatConversation.ScrollButton aria-label="回到最新" tooltip="回到最新" onPress={followLatestAnswer} />
      </ChatConversation>
      <ChatComposer key={`composer:${displayedSessionIdRef.current ?? "new"}`} draftKey={displayedSessionIdRef.current ?? undefined} enabled={clientReady && chatAvailable && answerSnapshotComplete && !switchBusy}
        busy={chatBusy} screenshotBusy={screenshotBusy || screenBusy} screens={collectedScreens}
        messages={messages} operations={operations} dispatch={dispatchControl} onCapture={collectScreen} onSent={followLatestAnswer}
        more={<Dropdown><Button isIconOnly size="sm" variant="ghost" aria-label="更多"><DotsThree size={20} /></Button>
          <Dropdown.Popover placement="top end"><Dropdown.Menu aria-label="更多操作">
            <Dropdown.Item id="new-conversation" textValue="新对话" isDisabled={!clientReady} onAction={() => selectConversation(null)}><Label>新对话</Label></Dropdown.Item>
            <Dropdown.Item id="chatgpt-plugin" textValue="连接 ChatGPT" onAction={() => setPluginOpen(true)}><Label>连接 ChatGPT</Label></Dropdown.Item>
            <Dropdown.Item id="device" textValue="设备详情" onAction={() => void openDetails("device")}><Label>设备详情 · {statusText}</Label></Dropdown.Item>
            {IS_CAPTURE_HOST && <Dropdown.Item id="interview-mode" textValue={mode === "assist" ? "切换到模拟面试" : "切回普通聊天"}
              isDisabled={modeBusy || !clientReady || interviewActive || sessionPhase === "starting" || sessionPhase === "stopping"}
              onAction={() => void chooseMode(mode === "assist" ? "mock" : "assist")}><Label>{mode === "assist" ? "切换到模拟面试" : "切回普通聊天"}</Label></Dropdown.Item>}
            {IS_CAPTURE_HOST && <Dropdown.Item id="screen-source" textValue="截图来源" isDisabled={screenBusy || screenshotBusy} onAction={() => void chooseScreen()}><Label>截图来源</Label></Dropdown.Item>}
            <Dropdown.Item id="theme" textValue={resolvedTheme === "dark" ? "日间模式" : "夜间模式"} onAction={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}>{resolvedTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}<Label>{resolvedTheme === "dark" ? "日间模式" : "夜间模式"}</Label></Dropdown.Item>
          </Dropdown.Menu></Dropdown.Popover>
        </Dropdown>} />
      {clientReady && !chatAvailable && <p className="preview-muted" role="status">请先更新服务端，再使用聊天。</p>}
    </>}
  </section>;
  return (
    <div className="browser-preview">
      <main className="preview-main" id="interview-panel">
        {conversation}
      </main>
      <Modal isOpen={pluginOpen} onOpenChange={setPluginOpen}><Modal.Backdrop>
        <Modal.Container size="md"><Modal.Dialog aria-label="连接 ChatGPT"><Modal.CloseTrigger aria-label="关闭 ChatGPT 设置" />
          <Modal.Header><Modal.Heading>在 ChatGPT 里读本场材料</Modal.Heading></Modal.Header>
          <Modal.Body>
            <p>在 ChatGPT 设置中打开开发者模式，创建一个使用 OAuth 的自定义 MCP 连接，填入下方地址。连接时，在电脑上的 Sage 点击允许。</p>
            <p className="mt-3 break-all">{API_BASE_URL}/mcp</p><CopyTextButton text={`${API_BASE_URL}/mcp`} label="复制插件地址" />
            <p className="mt-3">在 ChatGPT 对话中选用 Sage，发送下面这句话；之后直接追问。材料更新后，说「再读取新增材料」。你原有的回答提示词仍可以先发在该对话里。</p>
            <CopyTextButton text={`请使用 Sage 插件 read_interview 读取当前转录（interview_id="current"）。第一页优先最新语音和截图，页内按时间顺序；材料足够就先回答当前问题，不必读完历史。保存 updates_cursor，之后我说「回答」或「读新的」时把它作为 cursor，只读取新增和修正。需要更早上下文才使用 history_cursor；next_cursor 用于继续当前模式的分页。聊天切换不影响转录。需要个人背景时按需查阅相关资料。`} label="复制本场开场语" />
            <p className="mt-3 text-sm text-muted">插件会读到待发截图；输入框里的文字草稿不会共享。背景资料读取需要电脑在线。ChatGPT 账号须有开发者模式权限。</p>
          </Modal.Body>
        </Modal.Dialog></Modal.Container>
      </Modal.Backdrop></Modal>

      {IS_CAPTURE_HOST && <Modal isOpen={!!browserConnection} onOpenChange={open => { if (!open) decideBrowserConnection(false); }}><Modal.Backdrop>
        <Modal.Container size="sm" placement="center"><Modal.Dialog aria-label="允许浏览器连接">
          <Modal.Header><Modal.Heading>允许连接？</Modal.Heading></Modal.Header>
          <Modal.Body><p>{browserConnection?.name}</p><p className="mt-2 text-sm text-muted">{browserConnection?.read_only
            ? "允许 ChatGPT 读取各场的转录、聊天、截图（含待发截图）和背景资料。不能开启采集或控制 Sage；输入框文字草稿不共享。授权 30 天，可在 ChatGPT 断开连接。"
            : "允许此浏览器控制这台电脑上的 Sage，包括转录、截图和新建对话。记住 30 天。"}</p></Modal.Body>
          <Modal.Footer><Button variant="secondary" onPress={() => decideBrowserConnection(false)}>拒绝</Button><Button onPress={() => decideBrowserConnection(true)}>允许</Button></Modal.Footer>
        </Modal.Dialog></Modal.Container>
      </Modal.Backdrop></Modal>}

      <Modal isOpen={detailOpen} onOpenChange={setDetailOpen}><Modal.Backdrop>
        <Modal.Container size="lg" placement="center">
          <Modal.Dialog className="sage-dialog" aria-label={detailView === "transcript" ? "实时转写" : "设备详情"}>
            <Modal.CloseTrigger aria-label="关闭" />
            <Modal.Header><Modal.Heading>{detailView === "transcript" ? "实时转写" : "设备详情"}</Modal.Heading></Modal.Header>
            <Modal.Body className="detail-body">
              {detailView === "transcript" ? <>
                <p className="detail-intro">转录独立于聊天，切换或新建聊天不会停止或清空。回答和 ChatGPT 首次默认读取最近一小时；这里保留完整转录。</p>
                <p className="detail-intro">两路声音分别转录，发送消息时自动带入；语音不会自动触发回答。</p>
                <Button variant="secondary" size="sm" isDisabled={interviewActive || !clientReady}
                  onPress={() => setNewTranscriptionOpen(true)}>新一场转录</Button>
                {interviewActive && <p className="detail-intro">开始下一场前，请先停止转录。</p>}
                <ChannelCard speaker="interviewer" state={channels.interviewer} transcript={transcriptForSpeaker(turns, "interviewer")} />
                <ChannelCard speaker="candidate" state={channels.candidate} transcript={transcriptForSpeaker(turns, "candidate")} />
                {turns.filter((turn) => turn.text).map((turn) => <div className="transcript-turn" key={turn.turn_id}><span>{turn.speaker === "interviewer" ? "面试官" : "你"}{turn.status === "streaming" ? " · 识别中" : turn.status === "interrupted" ? " · 识别未完成" : ""}</span><p>{turn.text}</p>{<Button variant="ghost" size="sm" onPress={() => { setCorrectingTurn(turn); setManualText(turn.text); setDetailOpen(false); setCorrectionOpen(true); }}>纠正这一段</Button>}</div>)}
              </> : <>
                <p className="detail-intro">{connectionLabel(connectionState)} · {statusText}<br />{liveStatus.detail}</p>
                <div className="device-row"><Monitor size={20} /><div><strong>系统音频</strong><p>面试官 · 仅转录为上下文</p></div><span>{channels.interviewer.message}</span></div>
                <div className="device-row"><Microphone size={20} /><div><strong>麦克风</strong><p>你的声音 · 仅作为对话上下文</p></div><span>{channels.candidate.message}</span></div>
                {IS_CAPTURE_HOST && initializationFailed && <Button onPress={() => void retryCaptureInitialization()}>重新连接音频</Button>}
                {IS_CAPTURE_HOST && !initializationFailed && (["interviewer", "candidate"] as Speaker[]).filter((speaker) => ["error", "interrupted", "muted"].includes(channels[speaker].phase)).map((speaker) => <Button key={speaker} variant="secondary" isDisabled={!!recoveringChannel} onPress={() => void recoverChannel(speaker)}>{recoveringChannel === speaker ? "恢复中…" : speaker === "candidate" ? "恢复麦克风" : "恢复系统音频"}</Button>)}
                {IS_CAPTURE_HOST && <div className="screen-setting"><p>截图来源：{selectedScreenName || "主屏幕（默认）"}</p><Button variant="secondary" isDisabled={screenBusy} onPress={() => void chooseScreen()}>选择屏幕或窗口</Button></div>}
                {!IS_CAPTURE_HOST && <p className="detail-intro">音频由 Electron 桌面端采集，此页面同步显示。</p>}
                {operations.length > 0 && <div className="operation-history">{operations.map((operation) => <p key={operation.operation_id}>{operationLabel(operation)}{operation.detail ? ` · ${operation.detail}` : ""}</p>)}</div>}
                {Object.keys(sessionMetrics).length > 0 && <p className="detail-intro">重连 {Number(sessionMetrics.reconnections || 0)} 次 · 音频缺口 {Number(sessionMetrics.audio_gaps || 0)} 次 · 工具失败 {Number(sessionMetrics.tool_failures || 0)} 次</p>}
                {contextStatus && <p className="detail-intro">本场资料：{contextStatus.documents} 份 · {contextStatus.characters} 字符。修改资料后需开始新面试。</p>}
              </>}
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop></Modal>

      <Modal isOpen={correctionOpen} onOpenChange={setCorrectionOpen}><Modal.Backdrop>
        <Modal.Container size="lg"><Modal.Dialog aria-label="纠正转录"><Modal.CloseTrigger aria-label="关闭" />
          <Modal.Header><Modal.Heading>纠正转录</Modal.Heading></Modal.Header>
          <Modal.Body><TextArea aria-label="正确的转录" value={manualText} onChange={event => setManualText(event.target.value)} />
            <p className="detail-intro">更正后作为上下文，不自动生成回答。</p></Modal.Body>
          <Modal.Footer><Button isDisabled={!clientReady || !manualText.trim()} onPress={() => {
            if (correctingTurn && dispatchControl({ type: "manual_text", kind: "correction", text: manualText, turn_id: correctingTurn.turn_id })) setCorrectionOpen(false);
          }}>保存更正</Button></Modal.Footer>
        </Modal.Dialog></Modal.Container>
      </Modal.Backdrop></Modal>

      <Modal isOpen={screenPickerOpen} onOpenChange={setScreenPickerOpen}><Modal.Backdrop>
        <Modal.Container size="lg" placement="center"><Modal.Dialog className="sage-dialog" aria-label="选择看题来源">
          <Modal.CloseTrigger aria-label="关闭" /><Modal.Header><Modal.Heading>选择看题来源</Modal.Heading></Modal.Header>
          <Modal.Body><p className="detail-intro">选择快捷截图读取的显示器或窗口。截图会作为下一条消息的附件。</p><div className="screen-source-grid">{screenSources.map((source) => <Button key={source.id} variant="secondary" className="screen-source" onPress={() => void selectScreen(source)} isDisabled={screenBusy}><img src={source.thumbnailDataUrl} alt="" /><span>{source.name}{source.selected ? " · 已选择" : ""}</span></Button>)}</div>{!screenSources.length && <p>没有可用的屏幕或窗口，请检查系统录屏权限。</p>}</Modal.Body>
        </Modal.Dialog></Modal.Container>
      </Modal.Backdrop></Modal>

      <ConversationList open={conversationsOpen} onOpenChange={setConversationsOpen} base={API_BASE_URL}
        session={sessionRef.current} title={conversationTitle} onSelect={selectConversation} onRename={setConversationTitle} />
      <Modal isOpen={newTranscriptionOpen} onOpenChange={setNewTranscriptionOpen}><Modal.Backdrop>
        <Modal.Container size="sm"><Modal.Dialog role="alertdialog" aria-label="新一场转录">
          <Modal.Header><Modal.Heading>开始新一场转录？</Modal.Heading></Modal.Header>
          <Modal.Body>旧转录保留存档，后续默认只读取新一场。聊天内容不变；已经发给 AI 的旧内容仍在原聊天上下文里。</Modal.Body>
          <Modal.Footer><Button variant="secondary" autoFocus onPress={() => setNewTranscriptionOpen(false)}>取消</Button>
            <Button isDisabled={interviewActive || !clientReady} onPress={() => {
              if (dispatchControl({ type: "new_transcription" })) setNewTranscriptionOpen(false);
            }}>确认新一场</Button></Modal.Footer>
        </Modal.Dialog></Modal.Container>
      </Modal.Backdrop></Modal>
      <Modal isOpen={stopConfirmOpen} onOpenChange={setStopConfirmOpen}><Modal.Backdrop isDismissable={false}>
        <Modal.Container size="sm" placement="center">
          <Modal.Dialog className="sage-dialog" role="alertdialog" aria-labelledby="stop-dialog-title" aria-describedby="stop-dialog-description">
            <Modal.Header><Modal.Heading id="stop-dialog-title">停止回答并切换聊天？</Modal.Heading></Modal.Header>
            <Modal.Body><p id="stop-dialog-description">仅停止正在生成的回答并切换聊天。转录继续，已有转录内容不变；原聊天和附件保留。</p></Modal.Body>
            <Modal.Footer>
              <Button autoFocus variant="secondary" onPress={() => setStopConfirmOpen(false)}>取消</Button>
              <Button variant="primary" onPress={() => void confirmConversationSwitch()}>停止并切换</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop></Modal>
    </div>
  );
}

function ChannelCard({ speaker, state, transcript }: {
  speaker: Speaker; state: ChannelState; transcript: TranscriptState;
}) {
  const isInterviewer = speaker === "interviewer";
  const text = transcript.partial || transcript.final;
  return (
    <article className={`channel-card ${speaker}`}>
      <div className="channel-head">
        <span>{isInterviewer ? <Monitor size={18} /> : <Microphone size={18} />}{isInterviewer ? "面试官" : "你"}</span>
        <span className={`channel-status ${state.phase}`}>{state.message}</span>
      </div>
      <p className={`caption ${transcript.partial ? "live" : ""}`}>{text || (state.phase === "listening" ? "等待语音…" : "尚未开始")}</p>
    </article>
  );
}

function NoticeBanner({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return <div className="error-banner" role="alert"><WarningCircle size={18} /><span>{text}</span><Button isIconOnly size="sm" variant="ghost" aria-label="关闭提示" onPress={onDismiss}><X size={14} /></Button></div>;
}


async function requestCaptureInitialization() {
  const request = window.interviewDesktop?.requestCaptureInitialization;
  if (!request) {
    throw new Error("Electron 采集初始化接口不可用。");
  }
  await request();
}

async function createInterviewSession(): Promise<InterviewSession> {
  const create = window.interviewDesktop?.createInterview;
  if (!create) {
    throw new Error("只有 Electron 采集端可以创建面试会话。");
  }
  return parseInterviewSession(await create(API_BASE_URL), true);
}

function parseInterviewSession(value: Partial<InterviewSession>, requireCaptureToken: boolean) {
  if (
    typeof value.interview_id !== "string" ||
    !value.interview_id ||
    typeof value.session_token !== "string" ||
    !value.session_token ||
    (requireCaptureToken && (typeof value.capture_token !== "string" || !value.capture_token))
  ) {
    throw new Error("服务端返回了无效面试会话。");
  }
  return {
    interview_id: value.interview_id,
    session_token: value.session_token,
    conversation_id: value.conversation_id || value.interview_id,
    ...(requireCaptureToken ? { capture_token: value.capture_token } : {}),
  } satisfies InterviewSession;
}

async function readResponseError(response: Response) {
  try {
    const payload = (await response.json()) as { detail?: string; error?: string };
    return payload.detail ?? payload.error ?? `请求失败（${response.status}）`;
  } catch {
    return `请求失败（${response.status}）`;
  }
}

function parseSpeaker(value: unknown): Speaker | null {
  return value === "interviewer" || value === "candidate" ? value : null;
}

function parseAnswerStatus(status: string | undefined): AnswerStatus {
  return status === "completed" || status === "interrupted" || status === "error"
    ? status
    : "streaming";
}


function connectionLabel(state: ClientConnectionState) {
  switch (state) {
    case "connected":
      return "界面已同步";
    case "connecting":
      return "连接中";
    case "reconnecting":
      return "重连中";
    case "disconnected":
      return "界面未连接";
  }
}


function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function settleMediaRequest(promise: Promise<MediaStream>) {
  try {
    return { ok: true as const, stream: await promise };
  } catch (error) {
    return { ok: false as const, error };
  }
}
