"""Audio boundaries for streaming ASR, independent of interview turn taking.

All original 24 kHz PCM still reaches ASR immediately. WebRTC VAD only decides
when to request a final transcript; it never filters audio or triggers answers.
"""
from array import array
import sys

import webrtcvad


class CandidateAudioBoundary:
    FRAME_BYTES = 960  # 20 ms of PCM16 mono at 24 kHz
    QUIET_FRAMES = 40  # 800 ms; a brief thinking pause need not end the record
    MAX_BYTES = 24_000 * 2 * 30  # Bound continuous speech / silence to 30 seconds

    def __init__(self):
        self.vad = webrtcvad.Vad(1)
        self.pending = bytearray()
        self.sent_bytes = 0
        self.heard_speech = False
        self.quiet_frames = 0

    def feed(self, pcm: bytes) -> bool:
        self.sent_bytes += len(pcm)
        self.pending.extend(pcm)
        boundary = False
        while len(self.pending) >= self.FRAME_BYTES:
            samples = array("h", self.pending[:self.FRAME_BYTES])
            del self.pending[:self.FRAME_BYTES]
            if sys.byteorder != "little":
                samples.byteswap()
            # A downsampled copy is sufficient for voice detection. The model
            # receives the untouched original, never this 8 kHz detector input.
            detector = array("h", (sum(samples[i:i+3]) // 3 for i in range(0, len(samples), 3)))
            if sys.byteorder != "little":
                detector.byteswap()
            if self.vad.is_speech(detector.tobytes(), 8000):
                self.heard_speech, self.quiet_frames = True, 0
            else:
                self.quiet_frames += 1
            boundary |= self.heard_speech and self.quiet_frames >= self.QUIET_FRAMES
        if boundary or self.sent_bytes >= self.MAX_BYTES:
            # The whole incoming chunk was sent before the commit. Do not
            # carry its residual bytes into the next provider item.
            self.pending.clear()
            self.sent_bytes, self.quiet_frames, self.heard_speech = 0, 0, False
            return True
        return False

    def finish(self) -> bytes | None:
        """Commit a nonempty tail; pad sub-100ms buffers to the API minimum."""
        if not self.sent_bytes:
            return None
        padding = bytes(max(0, 4800 - self.sent_bytes))
        self.pending.clear()
        self.sent_bytes, self.quiet_frames, self.heard_speech = 0, 0, False
        return padding
