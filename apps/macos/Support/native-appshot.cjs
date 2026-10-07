// Calls the user's installed ChatGPT runtime. No ChatGPT code is bundled with Sage.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const PREFIX = '__SAGE_NATIVE_APPSHOT__';
const MAX_MESSAGE = 2 * 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;

function discoverRuntime(home = os.homedir()) {
  const root = path.join(home, '.codex/plugins/cache/openai-bundled/unified-computer-use');
  let versions;
  try { versions = fs.readdirSync(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); }
  catch { throw new Error('未找到 ChatGPT 原生采集组件。请安装并打开 ChatGPT 桌面应用。'); }
  for (const version of versions) {
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(root, version, '.mcp.json'), 'utf8')).mcpServers?.cua_repl; }
    catch { continue; }
    if (!config || config.enabled === false || !path.isAbsolute(config.command || '')) continue;
    const runtime = path.dirname(path.dirname(config.command));
    const entry = path.join(runtime, 'lib/node_modules/@oai/cua-repl/bin/cua-repl.mjs');
    // Only run the installed app's known launcher, never an arbitrary MCP command.
    if (!runtime.endsWith('.app/Contents/Resources/cua_node') ||
        config.command !== path.join(runtime, 'bin/node') ||
        config.args?.length !== 1 || config.args[0] !== entry ||
        !fs.existsSync(config.command) || !fs.existsSync(entry)) continue;
    const env = {};
    for (const [key, value] of Object.entries(config.env || {})) {
      if (typeof value !== 'string') throw new Error('ChatGPT 原生采集配置无效。');
      env[key] = value;
    }
    return { command: config.command, args: config.args, env };
  }
  throw new Error('ChatGPT 原生采集组件版本不兼容，请更新并打开 ChatGPT 后重试。');
}

class MCPClient {
  constructor(config, captureBundleID) {
    this.pending = new Map(); this.nextID = 1; this.closed = false; this.buffer = Buffer.alloc(0);
    this.captureBundleID = captureBundleID; this.approvalUsed = false;
    // Do not borrow another Codex chat's native pipe, request metadata or credentials.
    const env = Object.fromEntries(['HOME', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
    Object.assign(env, config.env);
    this.child = spawn(config.command, config.args, { env, stdio: ['pipe', 'pipe', 'ignore'], detached: true });
    this.child.on('error', () => this.fail(new Error('无法启动 ChatGPT 原生采集组件。')));
    this.child.on('exit', () => this.fail(new Error('ChatGPT 原生采集组件已退出。')));
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stdin.on('error', () => this.fail(new Error('ChatGPT 原生采集连接已关闭。')));
  }
  send(message) { this.child.stdin.write(JSON.stringify(message) + '\n'); }
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_MESSAGE) return this.fail(new Error('ChatGPT 原生采集返回的数据过大。'));
    let end;
    while ((end = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, end).toString('utf8'); this.buffer = this.buffer.subarray(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { return this.fail(new Error('ChatGPT 原生采集协议无效。')); }
      if (message.method && message.id !== undefined) {
        if (message.method === 'elicitation/create') {
          const params = message.params || {}, meta = params._meta || {};
          // The manual App Shot click authorizes this one read of this exact app.
          // Fulfil that scoped MCP confirmation, never persist approval or approve an action.
          const accepted = !this.approvalUsed && params.mode === 'form' &&
            meta.connector_id === 'computer-use' && meta.tool_name === 'get_app_state' &&
            meta.tool_params?.app === this.captureBundleID &&
            Object.keys(params.requestedSchema?.properties || {}).length === 0 &&
            !(params.requestedSchema?.required?.length);
          this.approvalUsed = true;
          this.send({ jsonrpc: '2.0', id: message.id, result: accepted ? { action: 'accept', content: {} } : { action: 'decline' } });
          if (!accepted) this.fail(new Error('ChatGPT 请求的权限超出本次手动截图范围，已拒绝采集。'));
        } else this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported client request' } });
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error('ChatGPT 原生采集请求失败。'));
      else pending.resolve(message.result);
    }
  }
  request(method, params) {
    if (this.closed) return Promise.reject(new Error('ChatGPT 原生采集连接已关闭。'));
    return new Promise((resolve, reject) => {
      const id = this.nextID++; this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear(); this.stop();
  }
  stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.child.pid) {
      try { process.kill(-this.child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-this.child.pid, 'SIGKILL'); } catch {} }, 1000);
      // Keep the bridge alive until its own runtime descendants have been reaped.
    }
  }
}

function snapshotFromResult(result, expectedTitle) {
  const blocks = result?.content || [];
  const records = blocks.filter(b => b.type === 'text' && b.text?.startsWith(PREFIX));
  if (result?.isError || records.length !== 1) throw new Error('ChatGPT 原生采集失败，请在 ChatGPT 中确认该应用可被读取。');
  let shot;
  try { shot = JSON.parse(records[0].text.slice(PREFIX.length)); } catch { throw new Error('ChatGPT 原生采集结果无效。'); }
  if (typeof shot.text !== 'string' || typeof shot.app !== 'string') throw new Error('ChatGPT 原生采集结果缺少窗口信息。');
  // The runtime may prepend its own app-use guidance; retain the captured window state only.
  const text = shot.text.replace(/^<app_specific_instructions>[\s\S]*?<\/app_specific_instructions>\s*/, '');
  const title = /^Window: "(.*)", App: [^\r\n]+(?:\r?\n|$)/.exec(text)?.[1];
  if (!title || (expectedTitle !== undefined && title !== expectedTitle)) throw new Error('ChatGPT 返回的窗口与所选窗口不一致，已拒绝使用其截图和文字。');
  return { ...shot, text, window_title: title };
}

async function readImage(url, temporaryDirectory = os.tmpdir()) {
  if (typeof url !== 'string' || !url.startsWith('file:')) throw new Error('ChatGPT 未返回本机窗口原图。');
  const file = await fsp.realpath(fileURLToPath(url));
  const root = await fsp.realpath(temporaryDirectory);
  if (!file.startsWith(root + path.sep)) throw new Error('ChatGPT 原图位置无效。');
  const handle = await fsp.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_IMAGE) throw new Error('ChatGPT 原图超过 5 MB，未缩小或上传。');
    const data = await handle.readFile();
    const png = data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = data[0] === 255 && data[1] === 216 && data[2] === 255;
    if (!png && !jpeg) throw new Error('ChatGPT 原图格式无效。');
    return `data:image/${png ? 'png' : 'jpeg'};base64,${data.toString('base64')}`;
  } finally { await handle.close(); }
}

async function capture(request, config = discoverRuntime()) {
  if (typeof request.app !== 'string' || !path.isAbsolute(request.app) || !request.app.endsWith('.app') ||
      typeof request.bundle_id !== 'string' || !request.bundle_id ||
      (request.window_title !== undefined && (typeof request.window_title !== 'string' || !request.window_title || /[\r\n]/.test(request.window_title)))) {
    throw new Error('原生采集需要可唯一识别的应用和窗口标题。');
  }
  const client = new MCPClient(config, request.bundle_id);
  const stop = () => client.fail(new Error('原生采集已取消。'));
  const timer = setTimeout(() => client.fail(new Error('ChatGPT 原生采集超时，请重试。')), 25000);
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: { elicitation: { form: {} } }, clientInfo: { name: 'sage-native-appshot', version: '1.0' } });
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Fixed capture-only code. Window text never becomes executable JavaScript.
    const code = `var sageSky=(await import('@oai/sky')).sky; var sageShot=await sageSky.get_app_state({app:${JSON.stringify(request.app)},disableDiff:true}); nodeRepl.write(${JSON.stringify(PREFIX)}+JSON.stringify(sageShot));`;
    const result = await client.request('tools/call', { name: 'js', arguments: { code, timeout_ms: 20000, title: 'Sage 手动 App Shot' } });
    const shot = snapshotFromResult(result, request.window_title);
    if (await fsp.realpath(shot.app) !== await fsp.realpath(request.app)) throw new Error('ChatGPT 返回的应用与所选应用不一致。');
    const image_data = await readImage(shot.screenshot?.url);
    const characters = Array.from(shot.text); const partial = characters.length > 180000;
    return { image_data, window_title: shot.window_title, text: characters.slice(0, 180000).join(''), status: partial ? 'partial' : 'available',
      detail: partial ? 'ChatGPT 原生采集；窗口文字超过上限，已标记为不完整。' : 'ChatGPT 原生采集', captured_at: new Date().toISOString() };
  } finally {
    clearTimeout(timer); process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); client.stop();
  }
}

if (require.main === module) {
  const input = readline.createInterface({ input: process.stdin });
  let started = false;
  input.on('line', async line => {
    if (started) return;
    started = true;
    try {
      if (line.length > 16384) throw new Error('原生采集请求过大。');
      const result = await capture(JSON.parse(line));
      process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, error: error.message || 'ChatGPT 原生采集失败。' }) + '\n');
    } finally { input.close(); process.stdin.destroy(); }
  });
  input.on('close', () => { if (!started) process.exitCode = 1; });
}

module.exports = { discoverRuntime, MCPClient, snapshotFromResult, readImage, capture, PREFIX };
