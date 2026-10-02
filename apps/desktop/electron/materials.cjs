const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const allowed = new Set([".md", ".txt", ".json", ".csv"]);
const revision = data => crypto.createHash("sha256").update(data).digest("hex");

// Only explicitly maintained reference documents, never credentials or thread files.
class Materials {
  constructor(root) { this.root = path.resolve(root, "materials"); }
  async file(name) {
    if (typeof name !== "string" || name.length > 600 || name.includes("\\") || name.includes(":")) throw new Error("无效资料路径。");
    const parts = name.split("/");
    if (parts.some(p => !p || p.startsWith(".")) || !allowed.has(path.extname(name).toLowerCase())) throw new Error("只能读取资料目录内的文本文件。");
    let target = this.root;
    if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("资料目录不能是链接。");
    for (const part of parts) {
      target = path.join(target, part);
      if ((await fs.lstat(target)).isSymbolicLink()) throw new Error("不能读取链接资料。");
    }
    const realRoot = await fs.realpath(this.root), real = await fs.realpath(target);
    const relative = path.relative(realRoot, real);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("资料路径越界。");
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("资料必须是小于 2 MB 的文本文件。");
    return fs.readFile(real);
  }
  async call(action, args = {}) {
    if (action === "list_materials") {
      const names = [];
      const walk = async (directory, prefix = "", depth = 0) => {
        if (depth > 12 || names.length > 5000) throw new Error("资料目录过大，请整理后再读取。");
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          const name = prefix + entry.name;
          if (entry.isDirectory()) await walk(path.join(directory, entry.name), name + "/", depth + 1);
          else if (entry.isFile() && allowed.has(path.extname(name).toLowerCase())) names.push(name);
        }
      };
      if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error("资料目录不能是链接。");
      await walk(this.root); names.sort();
      const offset = args.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("无效分页。");
      const files = await Promise.all(names.slice(offset, offset + 100).map(async name => {
        const data = await this.file(name);
        return { path: name, bytes: data.length, revision: revision(data) };
      }));
      return { files, next_offset: offset + files.length < names.length ? offset + files.length : null,
        formats: ["md", "txt", "json", "csv"] };
    }
    if (action !== "read_material") throw new Error("不支持的资料操作。");
    const data = await this.file(args.path), version = revision(data);
    if (args.revision && args.revision !== version) throw new Error("资料已更新，请从头读取新版。");
    const offset = args.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || (offset && !args.revision)) throw new Error("续读需要有效位置和资料版本。");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(data);
    const end = Math.min(content.length, offset + 24000);
    if (offset > content.length) throw new Error("读取位置超出资料长度。");
    return { path: args.path, revision: version, offset, text: content.slice(offset, end),
      next_offset: end < content.length ? end : null };
  }
}
module.exports = { Materials };
