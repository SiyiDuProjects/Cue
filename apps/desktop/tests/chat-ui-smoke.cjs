const { app, BrowserWindow, session } = require("electron");
const assert = require("node:assert/strict"),
  path = require("node:path"),
  fs = require("node:fs");
app.setPath(
  "userData",
  fs.mkdtempSync(path.join(require("node:os").tmpdir(), "cue-ui-check-")),
);
app.commandLine.appendSwitch("disable-gpu");
app
  .whenReady()
  .then(async () => {
    session.defaultSession.webRequest.onBeforeRequest((details, cb) =>
      cb({ cancel: /^https?:/.test(details.url) }),
    );
    const win = new BrowserWindow({
      width: 640,
      height: 780,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "chat-ui-preload.cjs"),
        contextIsolation: false,
        nodeIntegration: false,
      },
    });
    const js = (code) => win.webContents.executeJavaScript(code);
    const wait = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await js("!!(" + code + ")")) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw Error("UI timed out: " + code);
    };
    try {
      await win.loadFile(path.join(__dirname, "../dist/index.html"));
      await wait(
        "document.querySelector('.connection')?.textContent==='已连接'",
      );
      assert.equal(
        await js("document.querySelector('.cue-symbol').textContent"),
        "cue",
      );
      await js("document.querySelector('.composer-actions button').click()");
      await wait("document.querySelector('.attachments img')");
      await js(
        "const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'如何处理重复元素？');input.dispatchEvent(new Event('input',{bubbles:true}));",
      );
      await js("document.querySelector('.primary').click()");
      await wait("document.querySelector('.assistant-message table')");
      assert.equal(await js("window.lastAsk.images[0]"), "shot");
      assert.equal(await js("window.lastAsk.text"), "如何处理重复元素？");
      assert.equal(
        await js("document.querySelectorAll('.katex').length>0"),
        true,
      );
      fs.mkdirSync(path.join(__dirname, "../../../artifacts"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(__dirname, "../../../artifacts/cue-chat-ui.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      await wait(
        "document.querySelector('.copy') && !document.querySelector('.thinking')",
      );
      await js("document.querySelector('.copy').click()");
      assert.equal(await js("window.copied"), "使用哈希表。");
      await js("document.querySelector('[aria-label=\"设置\"]').click()");
      await wait("document.querySelector('#source option')");
      assert.equal(await js("document.querySelector('#effort').value"), "");
      assert.equal(
        await js("document.querySelector('#source').value"),
        "frontmost",
      );
      assert.equal(
        await js(
          "document.querySelector('#source option[value=unavailable]').disabled",
        ),
        true,
      );
      const choose = async (id) => {
        await js(
          `document.querySelector('#source').value=${JSON.stringify(id)};document.querySelector('#source').dispatchEvent(new Event('change',{bubbles:true}));`,
        );
        await wait("!document.querySelector('#source').disabled");
      };
      await choose("screen:0");
      assert.equal(
        await js("document.querySelector('#source').value"),
        "screen:0",
      );
      await choose("frontmost");
      assert.equal(
        await js("document.querySelector('#source').value"),
        "frontmost",
      );
      await js("window.rejectSource=true");
      await choose("screen:0");
      assert.equal(
        await js("document.querySelector('#source').value"),
        "frontmost",
      );
      await js("document.querySelector('[aria-label=\"设置\"]').click()");
      assert.equal(await js("window.sourceReads"), 1);
      await js("document.querySelector('[aria-label=\"设置\"]').click()");
      await wait(
        "window.sourceReads===2 && !document.querySelector('#source').disabled",
      );
      assert.equal(
        await js("document.querySelector('#source').value"),
        "frontmost",
      );
      await win.setSize(440, 650);
      assert.equal(
        await js("document.documentElement.scrollWidth<=innerWidth"),
        true,
      );
      await js(`
        for (const turn of [
          {id:'silence',text:'',status:'final'},
          {id:'speech',text:'测试转录',status:'final'},
          {id:'interrupted',text:'',status:'interrupted'},
        ]) window.dispatchEvent(new CustomEvent('cue:event',{detail:{type:'transcript',turn:{...turn,speaker:'interviewer',created:1}}}));
        [...document.querySelectorAll('.capturebar button')].find(b=>b.textContent.startsWith('转录')).click();
      `);
      await wait("document.querySelectorAll('.turn').length===2");
      assert.match(
        await js("document.querySelector('.transcript').textContent"),
        /未完整确认/,
      );
      await js(
        "window.dispatchEvent(new CustomEvent('cue:event',{detail:{type:'replaced',detail:'连接已被替换'}}))",
      );
      await wait("document.querySelector('.reconnect')");
      assert.equal(
        await js("document.querySelector('.primary').disabled"),
        true,
      );
      await js("document.querySelector('.reconnect').click()");
      await wait(
        "document.querySelector('.connection').textContent==='已连接'",
      );
      assert.equal(
        await js("document.querySelector('.reconnect')===null"),
        true,
      );
      assert.equal(await js("localStorage.getItem('cue.chat')"), "chat");
      console.log(
        "PASS chat, screenshot attachment, streaming Markdown/table/math, copy, source restore/failure, silence display, manual reconnect and narrow layout; all network blocked",
      );
    } finally {
      win.destroy();
      app.quit();
    }
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
