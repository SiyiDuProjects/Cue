export class DirectTranscription {
  constructor(options: {
    send: (value: any) => void | Promise<unknown>;
    makeVAD: () => Promise<any>;
    fail: (detail: string) => void;
    caption?: (value: { role: string; item: string; text: string }) => void;
    emit?: (event: any) => void;
    log?: (event: any) => void;
    WebSocket?: any;
  });
  handle(event: any): boolean;
  pcm(role: string, buffer: ArrayBuffer): void;
  start(): Promise<void>;
  stop(): void;
  control(value: any): Promise<void>;
  reset(): void;
}
export function decodePCM(base64: string): ArrayBuffer;
