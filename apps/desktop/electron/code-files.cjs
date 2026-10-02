const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const languages = { py: "python", js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", java: "java",
  go: "go", rs: "rust", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", rb: "ruby", swift: "swift",
  kt: "kotlin", sql: "sql", json: "json", md: "markdown", txt: "text", yaml: "yaml", yml: "yaml" };
const ignored = new Set(["node_modules", "__pycache__", "target", "dist", "build"]);

class CodeFiles {
  constructor(root, env = process.env) {
    this.root = path.resolve(root);
    this.env = Object.fromEntries(Object.entries(env).filter(([key]) => !/^GIT_/i.test(key)));
    Object.assign(this.env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  }
  async git(...args) {
    const { stdout } = await execute("git", ["--no-pager", "-c", "core.autocrlf=false", "-c", "core.hooksPath=.git/no-hooks",
      "-c", "user.name=Sage", "-c", "user.email=sage@localhost", ...args],
      { cwd: this.root, env: this.env, windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    return stdout.trimEnd();
  }
  async prepare() {
    await fs.mkdir(this.root, { recursive: true });
    if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error("代码目录不能是链接。");
    try {
      const stat = await fs.lstat(path.join(this.root, ".git"));
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("代码仓库路径无效。");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.git("init", "-q");
      await this.git("commit", "--allow-empty", "-qm", "开始代码记录");
    }
  }
  async read() {
    const files = [];
    let total = 0;
    const walk = async (directory, depth) => {
      if (depth > 6) throw new Error("代码目录层级过深。");
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || ignored.has(entry.name)) continue;
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("代码目录中的链接未同步。");
        if (entry.isDirectory()) { await walk(full, depth + 1); continue; }
        const language = languages[path.extname(entry.name).slice(1).toLowerCase()];
        if (!entry.isFile() || !language) continue;
        const stat = await fs.lstat(full);
        if (stat.nlink !== 1 || stat.size > 320000) throw new Error("代码文件过大或不是独立文件。");
        const code = await fs.readFile(full, "utf8");
        if (code.includes("\0") || code.length > 80000) throw new Error("代码文件不是可显示的文本，或超过上限。");
        total += code.length;
        if (total > 250000 || files.length >= 30) throw new Error("本对话代码超过同步上限（30 个文件／250K 字符）。");
        files.push({ filename: path.relative(this.root, full).replaceAll("\\", "/"), language, code, comparison: null });
      }
    };
    await walk(this.root, 0);
    return files.sort((a,b) => a.filename.localeCompare(b.filename));
  }
  async checkpoint({ interrupted = false } = {}) {
    await this.prepare();
    const files = await this.read();
    const tracked = (await this.git("ls-files", "-z")).split("\0").filter(Boolean);
    const changed = [];
    for (const file of files) {
      let before = null;
      // Git's show output is literal file text (including its trailing newline).
      if (tracked.includes(file.filename)) {
        const { stdout } = await execute("git", ["show", `HEAD:${file.filename}`], { cwd: this.root, env: this.env,
          windowsHide: true, timeout: 15000, maxBuffer: 400000 });
        before = stdout;
      }
      if (before !== file.code) {
        changed.push(file.filename);
        if (before !== null) file.comparison = { source: "previous", before, label: "相对上一版文件" };
      }
    }
    const removed = tracked.filter(name => !files.some(f => f.filename === name));
    let commit = await this.git("rev-parse", "HEAD");
    let title = `${interrupted ? "未完成 · " : ""}${changed.length ? "更新 " + changed.join("、") : "移除 " + removed.join("、")}`.slice(0,120);
    if (changed.length || removed.length) {
      if (files.length) await this.git("add", "-f", "--", ...files.map(f => f.filename));
      if (removed.length) await this.git("rm", "--cached", "--ignore-unmatch", "--", ...removed);
      await this.git("commit", "-qm", title);
      commit = await this.git("rev-parse", "HEAD");
    } else {
      title = await this.git("log", "-1", "--format=%s");
      interrupted = title.startsWith("未完成 · ");
    }
    return { title, files, commit, interrupted, active_file: changed[0] || files[0]?.filename || "" };
  }
  async seed(files) {
    await this.prepare();
    if ((await this.read()).length || (await this.git("rev-list", "--count", "HEAD")) !== "1") return;
    for (const file of files || []) {
      const name = file.filename;
      if (typeof name !== "string" || name.includes("\\") || name.includes(":") ||
          name.split("/").some(p => !p || p.startsWith(".")) || !languages[path.extname(name).slice(1)]) {
        throw new Error("旧代码文件名无法安全迁入本地目录。");
      }
      if (typeof file.code !== "string" || file.code.length > 80000) throw new Error("旧代码文件无效。");
      const target = path.join(this.root, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.code, { flag: "wx" });
    }
    if (files?.length) await this.checkpoint();
  }
}

module.exports = { CodeFiles };
