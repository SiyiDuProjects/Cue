import readline from "node:readline";
import initializeVAD from "@ozymandiasthegreat/vad/lib/embedded.js";
import {
  DirectTranscription,
  decodePCM,
} from "../../../packages/transcription/direct.mjs";

// Native acceptance only. stdin may contain ephemeral tokens; stdout contains
// only whitelisted server controls and transcript text, never token responses.
const output = (value) => process.stdout.write(JSON.stringify(value) + "\n");
const direct = new DirectTranscription({
  send: (value) => output({ kind: "send", value }),
  fail: (detail) => output({ kind: "error", detail }),
  makeVAD: async () => {
    const VAD = await initializeVAD(),
      vad = new VAD(2, 8000);
    return {
      voice: (frame) => {
        const result = vad.processFrame(frame);
        if (result < 0) throw Error("VAD failed");
        return result === 1;
      },
      destroy: () => vad.destroy(),
    };
  },
});
const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (message.kind === "server") direct.handle(message.value);
    else if (message.kind === "pcm")
      direct.pcm(message.role, decodePCM(message.audio));
    else if (message.kind === "control") direct.control(message.value);
    else if (message.kind === "close") {
      direct.reset();
      process.exit(0);
    }
  } catch {
    output({ kind: "error", detail: "Direct acceptance bridge failed" });
  }
});
input.on("close", () => {
  direct.reset();
  process.exit(0);
});
