export type Speaker = "interviewer" | "candidate";

export type SessionPhase = "idle" | "starting" | "live" | "stopping";

export type ChannelPhase =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "muted"
  | "interrupted"
  | "reconnecting"
  | "error";

export type AnswerStatus = "streaming" | "completed" | "interrupted" | "error";

export type DeviceStatus = "offline" | "initializing" | "ready" | "error";

export interface InterviewSession {
  conversation_id?: string;
  interview_id: string;
  session_token: string;
  capture_token?: string;
}

export interface ChannelState {
  phase: ChannelPhase;
  message: string;
}

export interface TranscriptState {
  final: string;
  partial: string;
}

export interface TranscriptTurn {
  turn_id: string;
  speaker: Speaker;
  text: string;
  question_id?: string;
  kind?: string;
  created_at?: string;
  status?: "streaming" | "completed" | "interrupted";
}

export interface QuestionRecord {
  question_id: string;
  text: string;
  turn_id?: string;
  created_at?: string;
}

export type ManualTextKind = "question" | "correction" | "candidate_context";
export type OperationStatus = "sent" | "accepted" | "running" | "completed" | "failed" | "cancelled";

export interface OperationRecord {
  operation_id: string;
  kind: string;
  status: OperationStatus;
  action?: string;
  detail?: string;
  question_id?: string;
  response_id?: string;
  created_at?: string;
}

export interface ChannelHealth {
  phase?: string;
  message?: string;
  detail?: string;
}

export interface AgentActivity {
  id: string;
  kind: "command" | "search" | "image" | "code" | "file" | "context";
  label: string;
  status: "running" | "completed" | "failed" | "interrupted";
}

export interface AnswerRecord {
  activities?: AgentActivity[];
  responseId: string;
  questionId?: string;
  question?: string;
  text: string;
  status: AnswerStatus;
  createdAt: string;
  detail?: string;
}

export interface AnswerStore {
  order: string[];
  byId: Record<string, AnswerRecord>;
}

export interface ChatRequest {
  provider?: "codex" | "responses";
  profile?: "default" | "brief" | "lc" | "ood";
  message_id: string;
  response_id: string;
  text: string;
  screens: CapturedScreen[];
  action: string;
  created_at: string;
  code_revision: number;
}

export interface ServerEvent {
  conversation_id?: string;
  transcription_id?: string;
  read_only?: boolean;
  activities?: AgentActivity[];
  title?: string;
  chat?: boolean;
  messages?: ChatRequest[];
  chat_message?: ChatRequest;
  ok?: boolean;
  mode?: "assist" | "mock";
  mock_interview?: boolean;
  pinned_code?: boolean;
  entry?: WorkspaceHistoryEntry;
  documents_count?: number;
  characters_count?: number;
  realtime_protocol?: string;
  workspace?: CodeWorkspace;
  screens?: CapturedScreen[];
  type?: string;
  speaker?: Speaker;
  response_id?: string;
  request_id?: string;
  question?: string;
  delta?: string;
  text?: string;
  status?: string;
  detail?: string;
  error?: string;
  message?: string;
  created_at?: string;
  active?: boolean;
  stopping?: boolean;
  current_question_id?: string;
  question_id?: string;
  turn_id?: string;
  kind?: string;
  action?: string;
  tool?: string;
  operation_id?: string;
  operations?: OperationRecord[];
  metrics?: Record<string, unknown>;
  questions?: QuestionRecord[];
  channel_details?: Partial<Record<Speaker, ChannelHealth>>;
  channels?: Partial<Record<Speaker, boolean>>;
  turns?: Array<Partial<TranscriptTurn>>;
}

export interface CodeFile {
  filename: string; language: string; code: string;
  comparison: { source: "previous" | "screenshot"; screenshot_id: string | null; before: string;
    label: string; captured_at?: string } | null;
}
export interface CodeVersion {
  git_commit?: string;
  active_file?: string | null;
  interrupted?: boolean;
  id: string; revision: number; title: string; created_at: string; files: CodeFile[];
  complexity: { time: string | null; space: string | null; explanation: string } | null;
}
export interface CodeWorkspace {
  workspace_id: string; revision: number; current: CodeVersion | null;
  versions: Array<Pick<CodeVersion, "id" | "revision" | "title" | "created_at">>;
  run_id: string; reveal_id: string; saved_workspaces?: SavedWorkspace[]; history_error?: string;
}
export interface SavedWorkspace { interview_id: string; problem_id: string; title: string; updated_at: string }
export interface WorkspaceHistoryEntry {
  key: string; version: CodeVersion;
  versions?: Array<Pick<CodeVersion, "id" | "revision" | "title" | "created_at">>;
  archive_interview_id?: string; archive_problem_id?: string;
}

export interface CapturedScreen {
  image_url?: string;
  request_id: string;
  question_id: string;
  captured_at: string;
  source_id: string;
}
