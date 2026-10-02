/** Playback and a virtual interviewer track share one native audio clock. */
export class MockAudio {
  private readonly context = new AudioContext({ sampleRate: 24000 });
  private readonly destination = this.context.createMediaStreamDestination();
  private readonly silence = this.context.createConstantSource();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private closed = false;

  constructor() {
    this.silence.offset.value = 0;
    this.silence.connect(this.destination);
    this.silence.start();
  }

  get stream() { return this.destination.stream; }

  async resume() {
    await this.context.resume();
    if (this.closed || this.context.state !== "running") throw new Error("请在桌面端点击开始以启用面试官语音。");
  }

  append(encoded: string) {
    if (this.closed || this.context.state !== "running") throw new Error("面试官语音播放已暂停，请恢复音频。");
    const bytes = atob(encoded);
    if (!bytes.length) return;
    if (bytes.length % 2 || bytes.length > 24000 * 2 * 10) throw new Error("面试官音频格式异常。");
    const duration = bytes.length / 2 / 24000;
    if (this.nextTime - this.context.currentTime + duration > 120) throw new Error("面试官音频积压，请重连面试官。");
    const buffer = this.context.createBuffer(1, bytes.length / 2, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) {
      const sample = bytes.charCodeAt(i * 2) | (bytes.charCodeAt(i * 2 + 1) << 8);
      channel[i] = (sample >= 32768 ? sample - 65536 : sample) / 32768;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    source.connect(this.destination);
    source.onended = () => { source.disconnect(); this.sources.delete(source); };
    const start = Math.max(this.context.currentTime + 0.02, this.nextTime);
    this.nextTime = start + duration;
    this.sources.add(source);
    source.start(start);
  }

  clear() {
    this.sources.forEach((source) => { source.onended = null; source.stop(); source.disconnect(); });
    this.sources.clear();
    this.nextTime = 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    this.silence.stop();
    this.silence.disconnect();
    this.destination.stream.getTracks().forEach((track) => track.stop());
    void this.context.close().catch(() => {});
  }
}
