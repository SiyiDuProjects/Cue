/** Preserve originals until acknowledged; retries are explicit and keep the upload ID. */
export class UploadQueue {
  items = [];
  error = "";
  running = null;
  constructor(upload, saved, changed) {
    this.upload = upload;
    this.saved = saved;
    this.changed = changed;
  }
  notify() {
    this.changed(this.items.length, this.error);
  }
  add(shot) {
    this.items.push(shot);
    this.notify();
    this.start();
  }
  start() {
    if (this.running || this.error || !this.items.length) return;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
  }
  async drain() {
    while (this.items.length) {
      try {
        const image = await this.upload(this.items[0]);
        if (!image?.id) throw Error("截图上传结果未确认。");
        this.saved(image);
        this.items.shift();
        this.notify();
      } catch (error) {
        this.error =
          "截图上传失败，原图已保留：" + (error.message || String(error));
        this.notify();
        return;
      }
    }
  }
  retry() {
    this.error = "";
    this.notify();
    this.start();
  }
  async wait() {
    while (this.running) await this.running;
    if (this.error || this.items.length)
      throw Error(this.error || "截图尚未上传。");
  }
}
