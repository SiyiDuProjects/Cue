// Real built UI and local server; synthetic content, no device capture or model calls.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "../../..");
const artifacts = path.join(root, process.env.QUALITY_ARTIFACTS || "artifacts/answer-quality");
fs.mkdirSync(artifacts, { recursive: true });
app.setPath("userData", path.join(artifacts, "profile"));
app.disableHardwareAcceleration();
let server, win, log = "";
const errors = [];
const freePort = () => new Promise(resolve => {
  const socket = net.createServer(); socket.listen(0, "127.0.0.1", () => {
    const port = socket.address().port; socket.close(() => resolve(port));
  });
});
function finish(error) {
  clearTimeout(timeout);
  if (win && !win.isDestroyed()) win.destroy();
  server?.kill();
  fs.writeFileSync(path.join(artifacts, "server.log"), log);
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}
const timeout = setTimeout(() => finish(Error("Quality smoke timed out")), 60000);
app.whenReady().then(async () => {
  try {
    const base = "http://127.0.0.1:" + await freePort();
    server = spawn(path.join(root, "apps/server/.venv/Scripts/python.exe"), [path.join(__dirname, "answer-quality-server.py")], {
      cwd: path.join(root, "apps/server"), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, AUDIT_PORT: new URL(base).port, OPENAI_API_KEY: "", OPENAI_BASE_URL: "http://127.0.0.1:1/v1", INTERVIEW_WORKSPACE_HISTORY_DIR: "" },
    });
    server.stdout.on("data", b => log += b); server.stderr.on("data", b => log += b);
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    win = new BrowserWindow({ show: false, width: 1180, height: 920,
      webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    win.webContents.on("console-message", (_e, level, message) => { if (level >= 3) errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel:
      !(d.url.startsWith(base + "/") || d.url.startsWith(base.replace("http", "ws") + "/") || d.url.startsWith("data:")) }));
    await win.loadURL(base + "/__audit/ui?desktop=1");
    const checks = await win.webContents.executeJavaScript(`(async () => {
      const until = async f => { for(let i=0;i<500;i++){if(f())return;await new Promise(r=>setTimeout(r,20));} throw Error('Timeout: '+f); };
      const aria = t => document.querySelector('[aria-label="'+t+'"]');
      await until(() => aria('消息') && !aria('消息').disabled);
      Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async t=>{window.qualityCopied=t;}}});
      const el=aria('消息'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'验证公式和代码显示');
      el.dispatchEvent(new Event('input',{bubbles:true}));
      await until(()=>aria('发送消息')&&!aria('发送消息').disabled); aria('发送消息').click();
      await until(()=>document.querySelector('.sage-assistant-message .katex-display') && !aria('停止生成'));
      await until(()=>document.querySelector('.answer-code pre.shiki span[style]'));
      const answer=document.querySelector('.sage-assistant-message');
      const colors=new Set([...answer.querySelectorAll('pre.shiki span[style]')].map(e=>getComputedStyle(e).color));
      if(colors.size<3)throw Error('Syntax tokens exist but highlight colors are missing');
      const code=answer.querySelector('pre code').textContent;
      aria('复制代码').click();await until(()=>window.qualityCopied===code);
      if(!code.includes('marker = "$x$"') || answer.querySelector('pre .katex'))throw Error('Code was changed by math rendering');
      const math=answer.querySelectorAll('.katex');
      if(math.length!==3 || !answer.querySelector('math'))throw Error('Missing accessible formulas');
      if(!answer.querySelector('table'))throw Error('Lost table rendering');
      const font=await document.fonts.load('16px KaTeX_Main');if(!font.length)throw Error('KaTeX fonts missing');
      const copyAll=answer.querySelector('[aria-label="复制回答"]');if(!copyAll)throw Error('Missing raw answer copy');
      copyAll.click();await until(()=>window.qualityCopied.includes('$$'));
      if(!window.qualityCopied.includes('$O(n'))throw Error('Answer copy lost original LaTeX');
      return {highlighted:true,inlineAndDisplayMath:true,accessibleMath:true,fontsLoaded:true,codeCopyExact:true,answerCopyOriginal:true};
    })()`, true);
    // Offscreen capture can return the previous compositor frame even after DOM
    // assertions pass. Let highlighted pixels and copy feedback reach the frame.
    await new Promise(r => setTimeout(r, 200));
    fs.writeFileSync(path.join(artifacts, "desktop.png"), (await win.webContents.capturePage()).toPNG());
    const layouts = [];
    for (const width of [390, 320, 430]) {
      win.setContentSize(width, 844);
      await new Promise(r => setTimeout(r, 200));
      const layout = await win.webContents.executeJavaScript(`(() => {
        const answer = document.querySelector('.sage-assistant-message');
        const rect = e => { const r=e.getBoundingClientRect(); return {left:r.left,right:r.right,width:r.width}; };
        const scroll = answer.querySelector('.code-block__code');
        scroll.scrollLeft = scroll.scrollWidth;
        const codeScrolls = scroll.scrollLeft > 0;
        const lastLine = [...scroll.querySelectorAll('.line')].find(e => e.textContent.includes('def solve'));
        const range = document.createRange(); range.selectNodeContents(lastLine);
        const endVisible = range.getBoundingClientRect().right <= scroll.getBoundingClientRect().right + 1;
        scroll.scrollLeft = 0;
        answer.scrollIntoView({block:'start'});
        return {viewport:innerWidth, pageFits:document.documentElement.scrollWidth <= innerWidth + 1,
          answer:rect(answer), paragraph:rect(answer.querySelector('.answer-markdown p')),
          code:rect(answer.querySelector('.answer-code')), codeScrolls, endVisible};
      })()`);
      layouts.push(layout);
      fs.writeFileSync(path.join(artifacts, "mobile-layout.json"), JSON.stringify(layouts, null, 2));
      await new Promise(r => setTimeout(r, 200));
      fs.writeFileSync(path.join(artifacts, `mobile-${width}.png`), (await win.webContents.capturePage()).toPNG());
      if (!layout.pageFits) throw Error("Answer overflows narrow viewport");
      if (Math.abs(layout.paragraph.width - layout.answer.width) > 1 || Math.abs(layout.code.width - layout.answer.width) > 1)
        throw Error("Mobile text/code leave unused answer width: " + JSON.stringify(layout));
      if (!layout.codeScrolls || !layout.endVisible) throw Error("Long code cannot be scrolled to its last character");
    }
    if (errors.length) throw Error(errors.join("\n"));
    fs.writeFileSync(path.join(artifacts, "checks.json"), JSON.stringify({ ...checks, narrowViewport: true, fullAnswerWidth: true, codeScrolls: true }, null, 2));
    console.log("PASS", JSON.stringify({ ...checks, narrowViewport: true, fullAnswerWidth: true, codeScrolls: true })); finish();
  } catch (error) { finish(error); }
});
