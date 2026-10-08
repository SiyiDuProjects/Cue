import initializeVAD from "@ozymandiasthegreat/vad/lib/embedded.js";
import {
  DirectTranscription,
  decodePCM,
} from "../../../packages/transcription/direct.mjs";
import { receive, type Event } from "../../../packages/chat-ui/bridge";

export function directTranscription(
  send: (event: Event) => void,
  fail: (detail: string) => void,
) {
  return new DirectTranscription({
    send,
    fail,
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
    (event) => {
      void host
        .command({ type: "asr_forward", message: event })
        .catch((error) => {
          direct.reset();
          receive({ type: "error", detail: String(error) });
          void host.audio(false).catch(() => {});
        });
    },
    (detail) => {
      receive({ type: "error", detail });
      void host.audio(false).catch(() => {});
    },
  );
  window.cueReceive = (event) => {
    try {
      if (event.type === "pcm") direct.pcm(event.role, decodePCM(event.data));
      else if (event.type === "audio_control") direct.control(event.value);
      else if (!direct.handle(event)) receive(event);
    } catch (error) {
      direct.reset();
      receive({ type: "error", detail: String(error) });
      void host.audio(false).catch(() => {});
    }
  };
  window.addEventListener("beforeunload", () => direct.reset());
}
