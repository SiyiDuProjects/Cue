export class DirectTranscription {
  constructor(options: {
    send: (value: any) => void;
    makeVAD: () => Promise<any>;
    fail: (detail: string) => void;
    WebSocket?: any;
  });
  handle(event: any): boolean;
  pcm(role: string, buffer: ArrayBuffer): void;
  control(value: any): void;
  reset(): void;
}
export function decodePCM(base64: string): ArrayBuffer;
