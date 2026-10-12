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
      height: 900,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, "chat-ui-preload.cjs"),
        contextIsolation: false,
        nodeIntegration: false,
      },
    });
    const js = (code) =>
      win.webContents.executeJavaScript(code).catch((error) => {
        throw Error("Page script failed: " + code.slice(0, 160), {
          cause: error,
        });
      });
    const wait = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await js("!!(" + code + ")")) return;
        await new Promise((r) => setTimeout(r, 30));
      }
      throw Error("UI timed out: " + code);
    };
    const click = (selector) =>
      js(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const event = (detail) =>
      js(
        `window.dispatchEvent(new CustomEvent('cue:event',{detail:${JSON.stringify(detail)}}))`,
      );
    const type = (text) =>
      js(
        `{const input=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}));}`,
      );
    try {
      await win.loadFile(path.join(__dirname, "../dist/index.html"));
      await wait(
        "document.querySelector('.connection')?.textContent==='已连接'",
      );
      // One timeline: no chat controls; the newest chat is used silently.
      await wait("window.lastHistory");
      assert.deepEqual(
        await js("[window.lastHistory.chat, window.lastHistory.scope]"),
        ["chat", "recent"],
      );
      assert.equal(
        await js("document.body.textContent.includes('聊天')"),
        false,
      );
      // Starts as the bar only; the window follows the content size.
      assert.equal(await js("document.querySelector('.card')"), null);
      await wait("window.lastSize");
      const collapsed = await js("window.lastSize");
      assert.ok(collapsed.width < 560 && collapsed.height < 90, collapsed);
      await click(".shot-button");
      await wait("document.querySelector('.shot-count')?.textContent==='1'");
      await click('[aria-label="展开"]');
      await wait("document.querySelector('.card .attachments img')");
      await wait("window.lastSize.width>=560");
      // Typing asks the host for focus; clicks elsewhere never do.
      await js(
        "document.querySelector('textarea').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))",
      );
      assert.deepEqual(await js("window.focusCalls"), [true]);
      await type("如何处理重复元素？");
      await click(".send-button");
      // Summary streams openly while thinking, then folds once the answer starts.
      await wait(
        "document.querySelector('.reasoning-text')?.textContent.includes('哈希表') && !document.querySelector('.assistant-message .markdown')",
      );
      assert.equal(
        await js("document.querySelector('details.reasoning')"),
        null,
      );
      await wait("document.querySelector('.assistant-message table')");
      assert.equal(
        await js(
          "!!document.querySelector('details.reasoning:not([open]) summary')",
        ),
        true,
      );
      assert.equal(await js("window.lastAsk.images[0]"), "shot");
      assert.equal(await js("window.lastAsk.text"), "如何处理重复元素？");
      assert.equal(await js("window.lastAsk.chat"), "chat");
      assert.equal(
        await js("document.querySelectorAll('.katex').length>0"),
        true,
      );
      await wait(
        "document.querySelector('.copy') && !document.querySelector('.thinking')",
      );
      assert.match(
        await js("document.querySelector('details.reasoning').textContent"),
        /思路.*读题.*哈希表/s,
      );
      await click(".copy");
      assert.equal(await js("window.copied"), "使用哈希表。");
      // A second question from the bar; the card shows one exchange at a time.
      await type("还有别的做法吗？");
      await click(".answer-button");
      await wait(
        "document.querySelector('.pager')?.textContent.includes('2 / 2') && document.querySelector('.copy')",
      );
      assert.equal(
        await js("document.querySelectorAll('.exchange').length"),
        1,
      );
      await click('[aria-label="上一条"]');
      await wait(
        "document.querySelector('.user-message').textContent.includes('重复元素')",
      );
      // Native menu choices: depth, screenshot source and its failure.
      await js("window.nextMenu={effort:'high'}");
      await click('[aria-label="更多"]');
      await wait("localStorage.getItem('cue.effort')==='high'");
      assert.deepEqual(await js("window.menuState"), {
        effort: "",
        remote: true,
      });
      await js("window.nextMenu={source:'screen:0'}");
      await click('[aria-label="更多"]');
      await wait("window.selectedSource==='screen:0'");
      await js("window.rejectSource=true;window.nextMenu={source:'screen:1'}");
      await click('[aria-label="更多"]');
      await wait(
        "document.querySelector('.notice')?.textContent.includes('来源已关闭')",
      );
      // Interviewer captions show only while transcribing.
      await click(".record-button");
      await wait("document.querySelector('.captions.waiting')");
      await event({
        type: "caption",
        item: "i1",
        text: "好的，我们先从项目开始。",
      });
      await event({ type: "caption", item: "i2", text: "缓存一致性" });
      await event({
        type: "caption",
        item: "i2",
        text: "缓存一致性怎么保证？",
      });
      await wait(
        "document.querySelector('.captions p').textContent==='好的，我们先从项目开始。缓存一致性怎么保证？'",
      );
      // The strip follows the newest words and scrolls back over earlier ones;
      // scrolling up stops following until the reader returns to the end.
      for (let i = 3; i < 12; i++)
        await event({
          type: "caption",
          item: "i" + i,
          text: "第" + i + "句比较长的面试官发言，用来撑出好几行字幕。",
        });
      await wait(
        "(e=>e.scrollHeight>e.clientHeight&&e.scrollHeight-e.scrollTop-e.clientHeight<4)(document.querySelector('.captions'))",
      );
      await js(
        "(e=>{e.scrollTop=0;e.dispatchEvent(new Event('scroll'))})(document.querySelector('.captions'))",
      );
      await event({ type: "caption", item: "i12", text: "新的一句。" });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        await js("document.querySelector('.captions').scrollTop"),
        0,
      );
      assert.match(
        await js("document.querySelector('.captions p').textContent"),
        /新的一句。$/,
      );
      await wait("document.querySelector('.clock')");
      fs.mkdirSync(path.join(__dirname, "../../../artifacts"), {
        recursive: true,
      });
      await win.setSize(640, 900);
      fs.writeFileSync(
        path.join(__dirname, "../../../artifacts/cue-chat-ui.png"),
        (await win.webContents.capturePage()).toPNG(),
      );
      await click(".record-button");
      await wait("!document.querySelector('.captions')");
      // ChatGPT panel: this window reports its status, and a panel button runs
      // the same action as the button here, unless remote control is off.
      await wait("window.remoteStates?.at(-1)?.phase==='idle'");
      assert.equal(await js("window.remoteStates.at(-1).allow"), true);
      await event({ type: "remote", connected: true });
      await wait("document.querySelector('.remote-mark')");
      await event({
        type: "remote_command",
        command: {
          id: "r1",
          type: "start",
          generation: "test-desktop",
          expires: Date.now() + 15000,
        },
      });
      await wait("document.querySelector('.source')?.textContent==='网页'");
      await wait(
        "window.remoteStates.at(-1).phase==='active' && window.remoteStates.at(-1).source==='remote'",
      );
      await event({
        type: "remote_command",
        command: {
          id: "r2",
          type: "stop",
          generation: "test-desktop",
          expires: Date.now() + 15000,
        },
      });
      await wait("!document.querySelector('.clock')");
      await wait("window.remoteResults?.some(r=>r.id==='r2'&&r.ok)");
      assert.equal(
        await js("window.remoteResults.some(r=>r.id==='r1'&&r.ok)"),
        true,
      );
      assert.equal(await js("window.remoteStates.at(-1).version"), 3);
      const remote = (id, type, extra = {}) =>
        event({
          type: "remote_command",
          command: {
            id,
            type,
            generation: "test-desktop",
            expires: Date.now() + 15000,
            ...extra,
          },
        });
      const beforeShots = await js("window.shotCalls");
      await remote("stale", "shot", { generation: "old-desktop" });
      await remote("expired", "shot", { expires: 0 });
      await wait("window.remoteResults.some(r=>r.id==='expired'&&!r.ok)");
      assert.equal(await js("window.shotCalls"), beforeShots);
      await js("window.holdShot=true");
      await remote("delayed", "shot");
      await wait("window.finishShot");
      assert.equal(
        await js("window.remoteResults.some(r=>r.id==='delayed')"),
        false,
      );
      await remote("blocked", "shot");
      await wait("window.remoteResults.some(r=>r.id==='blocked'&&!r.ok)");
      await js("window.holdShot=false;window.finishShot()");
      await wait(
        "window.remoteResults.some(r=>r.id==='delayed'&&r.ok&&!r.image)",
      );
      await js("window.failShot=true");
      await remote("failure", "shot");
      await wait(
        "window.remoteResults.some(r=>r.id==='failure'&&!r.ok&&r.detail.includes('录屏权限'))",
      );
      await js("window.failShot=false");
      await remote("remove", "unselect", { image: "shot" });
      await wait("window.remoteResults.some(r=>r.id==='remove'&&r.ok)");
      await wait("!window.remoteStates.at(-1).selected.includes('shot')");
      await js("window.holdUpload=true");
      await remote("queued-shot", "shot");
      await wait(
        "window.finishUpload && window.remoteResults.some(r=>r.id==='queued-shot'&&r.ok)",
      );
      await wait("window.remoteStates.at(-1).uploading===1");
      const oldAsk = await js("window.lastAsk?.id");
      await remote("web-ask", "ask", {
        text: "remote follow-up",
        effort: "low",
      });
      await wait(
        "window.remoteResults.some(r=>r.id==='web-ask'&&r.ok&&r.answer)",
      );
      assert.equal(await js("window.lastAsk?.id"), oldAsk);
      await remote("web-cancel", "cancel");
      await wait("window.remoteResults.some(r=>r.id==='web-cancel'&&r.ok)");
      await js("window.holdUpload=false;window.finishUpload()");
      await wait("window.remoteStates.at(-1).uploading===0");
      assert.equal(await js("window.lastAsk?.id"), oldAsk);
      await remote("web-answer", "ask", {
        text: "remote follow-up",
        effort: "low",
      });
      await wait("window.lastAsk?.text==='remote follow-up'");
      assert.equal(await js("window.lastAsk.effort"), "low");
      assert.ok((await js("window.lastAsk.images")).includes("shot"));
      await wait(
        "!document.querySelector('.bar .answer-button')?.textContent.includes('停止')",
      );
      await js("window.nextMenu={remote:false}");
      await click('[aria-label="更多"]');
      await wait("window.remoteStates.at(-1).allow===false");
      assert.equal(await js("window.menuState.remote"), true);
      await event({
        type: "remote_command",
        command: {
          id: "r3",
          type: "start",
          generation: "test-desktop",
          expires: Date.now() + 15000,
        },
      });
      await wait("window.remoteResults.some(r=>r.id==='r3'&&!r.ok)");
      assert.equal(await js("!!document.querySelector('.clock')"), false);
      assert.equal(await js("document.querySelector('.remote-mark')"), null);
      // The refused web command left a notice; dismiss it before collapsing.
      await click('[aria-label="关闭提示"]');
      assert.equal(await js("document.querySelector('.transcript')"), null);
      assert.equal(
        await js("document.documentElement.scrollWidth<=innerWidth"),
        true,
      );
      await click('[aria-label="收起"]');
      await wait(
        "!document.querySelector('.card') && window.lastSize.height<120",
      );
      await event({ type: "replaced", detail: "连接已被替换" });
      await wait("document.querySelector('.reconnect')");
      assert.equal(
        await js("document.querySelector('.answer-button').disabled"),
        true,
      );
      await click(".reconnect");
      await wait(
        "document.querySelector('.connection').textContent==='已连接'",
      );
      assert.equal(
        await js("document.querySelector('.reconnect')===null"),
        true,
      );
      console.log(
        "PASS overlay: hidden newest chat and recent history, web remote status/commands/switch, content-sized window, focus only for typing, screenshot attachment, streaming reasoning/Markdown/table/math, copy, one exchange with paging, native menu depth/source/failure, scrollable interviewer captions and manual reconnect; all network blocked",
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
