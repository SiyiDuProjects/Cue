/// <reference types="vite/client" />

interface InterviewSessionCredentials {
  interview_id: string;
  session_token: string;
  capture_token: string;
}

interface InterviewScreenSource {
  id: string;
  name: string;
  displayId: string;
  thumbnailDataUrl: string;
  selected: boolean;
}

interface Window {
  interviewDesktop?: {
    isElectron: boolean;
    captureHost?: boolean;
    platform: string;
    apiBaseUrl?: string;
    getWindowState?: () => Promise<{ recoveryNotice?: string }>;
    listScreenSources?: () => Promise<InterviewScreenSource[]>;
    selectScreenSource?: (sourceId: string) => Promise<{ id: string; name: string }>;
    captureScreenSnapshot?: () => Promise<{ image_data: string; source_id: string; captured_at: string }>;
    createInterview?: (apiBaseUrl: string) => Promise<InterviewSessionCredentials>;
    conversationRequest?: (apiBaseUrl: string, payload: { action: "list" | "switch" | "rename";
      current_id: string; session_token: string; target_id?: string | null; stop_active?: boolean; title?: string }) => Promise<any>;
    requestCaptureInitialization?: () => Promise<void>;
    endInterview?: (
      apiBaseUrl: string,
      interviewId: string,
      sessionToken: string,
    ) => Promise<{ ok: boolean }>;
  };
}
