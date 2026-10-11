export type Event = Record<string, any>;
export interface CueBridge {
  openSettings(): Promise<unknown>;
  /** Mac only: opens the system privacy page without requesting access. */
  openPrivacy?(): Promise<unknown>;
  /** Mac answer view: asks the native window to resend the current chat. */
  ready?(): Promise<unknown>;
  /** Mac answer view: content height, so the overlay hugs the answer. */
  height?(value: number): Promise<unknown>;
  /** Mac only: live interviewer caption from the local transcription stream. */
  caption?(value: { item: string; text: string }): Promise<unknown>;
  copy(text: string): Promise<unknown>;
  connect(): Promise<unknown>;
  command(value: Event): Promise<unknown>;
  request(path: string, method?: string, body?: Event): Promise<any>;
  audio(start: boolean): Promise<unknown>;
  screenshot(): Promise<any>;
  sources(): Promise<any[]>;
  selectSource(id: string): Promise<unknown>;
  uploadMaterials(): Promise<any>;
  importConnection(): Promise<unknown>;
  /** Windows overlay: size the window to the rendered content. */
  resize?(size: { width: number; height: number }): Promise<unknown>;
  /** Windows overlay: take keyboard focus only while typing. */
  focus?(on: boolean): Promise<unknown>;
  /** Windows overlay: native menu; resolves to the choice or null. */
  menu?(state: { effort: string }): Promise<any>;
}
declare global {
  interface Window {
    cue: CueBridge;
    cueReceive?: (value: Event) => void;
  }
}
export const receive = (value: Event) =>
  window.dispatchEvent(new CustomEvent("cue:event", { detail: value }));
