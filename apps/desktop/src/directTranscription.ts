import initializeVAD from "@ozymandiasthegreat/vad/lib/embedded.js";
import {
  DirectTranscription,
  decodePCM,
} from "../../../packages/transcription/direct.mjs";
import { receive, type Event } from "../../../packages/chat-ui/bridge";

export function directTranscription(
  send: (event: Event) => void | Promise<unknown>,
  fail: (detail: string) => void,
  caption?: (value: { role: string; item: string; text: string }) => void,
  emit: (event: Event) => void = receive,
  log: (event: Event) => void = (event) => console.error(JSON.stringify(event)),
) {
  return new DirectTranscription({
    send,
    fail,
    caption,
    emit,
    log,
    makeVAD: async () => {
      // Independent WASM instance and voice state for each channel/upstream.
      const VAD = await initializeVAD();
      const vad = new VAD(2, 8000);
      return {
        voice: (frame: Int16Array) => {
          const result = vad.processFrame(frame);
          if (result < 0) throw Error("VAD processing failed");
          return result === 1;
        },
        destroy: () => vad.destroy(),
      };
    },
  });
}

// The Mac host emits PCM and the cutoff marker in one native ordered stream.
export function installMacTranscription() {
  if (!(window as any).webkit?.messageHandlers?.cue || !window.cue) return;
  const host = window.cue;
  const direct = directTranscription(
    (event) => host.command({ type: "asr_forward", message: event }),
    (detail) => {
      void host.command({
        type: "transcription_state",
        event: { type: "error", detail },
      });
      void host.audio(false).catch(() => {});
    },
    // Interviewer captions go only to the native overlay, never the server.
    ({ role, item, text }) => {
      if (role === "interviewer") void host.caption?.({ item, text });
    },
    (event) => {
      void host.command({ type: "transcription_state", event });
    },
    (event) => {
      void host.command({ type: "transcription_log", event });
    },
  );
  window.cueReceive = (event) => {
    try {
      if (event.type === "pcm") direct.pcm(event.role, decodePCM(event.data));
      else if (event.type === "audio_control")
        void direct.control(event.value).catch((error: Error) => {
          void host.command({
            type: "transcription_state",
            event: { type: "error", id: event.value.id, detail: error.message },
          });
        });
      else if (!direct.handle(event)) receive(event);
    } catch (error) {
      direct.reset();
      void host.command({
        type: "transcription_state",
        event: { type: "error", detail: String(error) },
      });
      void host.audio(false).catch(() => {});
    }
  };
  window.addEventListener("beforeunload", () => direct.reset());
}
