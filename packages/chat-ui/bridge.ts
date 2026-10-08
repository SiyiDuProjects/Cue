export type Event = Record<string, any>;
export interface CueBridge {
  openSettings(): Promise<unknown>;
  /** Mac only: opens the system privacy page without requesting access. */
  openPrivacy?(): Promise<unknown>;
  /** Mac answer view: asks the native window to resend the current chat. */
  ready?(): Promise<unknown>;
  copy(text: string): Promise<unknown>;
  connect(): Promise<unknown>;
  command(value: Event): Promise<unknown>;
  request(path: string, method?: string, body?: Event): Promise<any>;
  audio(start: boolean): Promise<unknown>;
  screenshot(recording: string): Promise<any>;
  sources(): Promise<any[]>;
  selectSource(id: string): Promise<unknown>;
  uploadMaterials(): Promise<any>;
  importConnection(): Promise<unknown>;
  pin(value: boolean): Promise<unknown>;
}
declare global {
  interface Window {
    cue: CueBridge;
    cueReceive?: (value: Event) => void;
  }
}
export const receive = (value: Event) =>
  window.dispatchEvent(new CustomEvent("cue:event", { detail: value }));
