// Built React in Electron, with offline session/clipboard fixtures. No media or provider calls.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const artifacts = path.resolve(__dirname, '../../../artifacts');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'answer-ui-electron'));
app.disableHardwareAcceleration();
function fixture() {
  const sockets = [], answers = new Map(), sent = [], questions = [];
  const state = { sent, questions, copied: '', failCopy: false, deferCopy: false, pendingCopies: [] };
  const workspace = { document_id: 'main', filename: 'main.py', revision: 0, code: '', language: 'python', files: [],
    context_version: 0, problem_id: 'p1', can_undo: false, proposal: null, screen_follow: { enabled: false, status: 'off' } };
  const emit = event => sockets.filter(socket => socket.readyState === 1).forEach(socket => socket.message(event));
  state.emit = event => {
    if (event.type === 'answer_snapshot') answers.set(event.response_id, { ...event });
    if (event.type === 'answer_delta') {
      const answer = answers.get(event.response_id);
      if (answer?.status === 'streaming') answer.text += event.delta;
    }
    if (['answer_completed', 'answer_interrupted'].includes(event.type)) {
      const answer = answers.get(event.response_id);
      if (answer?.status === 'streaming') answer.status = event.type === 'answer_completed' ? 'completed' : 'interrupted';
    }
    emit(event);
  };
  state.question = (id, text) => {
    const previous = questions.find(question => question.question_id === id);
    if (previous) previous.text = text;
    else questions.push({ question_id: id, text });
    emit({ type: 'question_state', current_question_id: id, questions });
  };
  state.disconnect = () => sockets.filter(socket => socket.readyState === 1).forEach(socket => socket.close(1006));
  window.answerSmoke = state;
  window.interviewDesktop = { isElectron: false, captureHost: false, apiBaseUrl: 'https://fixture.invalid' };
  window.fetch = async () => new Response(JSON.stringify({ interview_id: 'answer-fixture', session_token: 'fixture-only', device_status: { status: 'ready', channels: { interviewer: true, candidate: true } }, interview_state: { active: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
    if (state.deferCopy) return new Promise((resolve, reject) => state.pendingCopies.push({
      resolve: () => { state.copied = text; resolve(); }, reject: () => reject(new Error('Deferred clipboard failure')),
    }));
    if (state.failCopy) throw new Error('Fixture clipboard failure');
    state.copied = text;
  } } });
  if (navigator.mediaDevices) {
    navigator.mediaDevices.getUserMedia = () => { throw new Error('Unexpected microphone access'); };
    navigator.mediaDevices.getDisplayMedia = () => { throw new Error('Unexpected screen access'); };
  }
  class Socket extends EventTarget {
    static OPEN = 1; static CLOSING = 2;
    constructor() { super(); this.readyState = 0; sockets.push(this); setTimeout(() => { this.readyState = 1; this.dispatchEvent(new Event('open')); }, 0); }
    message(event) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) })); }
    close(code = 1000) { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { code })); }
    send(raw) {
      const event = JSON.parse(raw); sent.push(event);
      queueMicrotask(() => {
        if (event.type === 'authenticate') {
          this.message({ type: 'session_ready', realtime_protocol: 'realtime-interview-v5', stepwise_code: true });
          this.message({ type: 'interview_state', active: true, mode: 'assist' });
          this.message({ type: 'device_status', status: 'ready', channels: { interviewer: true, candidate: true } });
          this.message({ type: 'question_state', current_question_id: questions.at(-1)?.question_id, questions });
          answers.forEach(answer => this.message(answer));
          this.message({ type: 'answer_snapshot_done' });
          this.message({ type: 'code_state', workspace });
        } else if (event.type === 'ping') this.message({ type: 'pong' });
      });
    }
  }
  window.WebSocket = Socket;
}
const timeout = setTimeout(() => { console.error('ANSWER_UI_SMOKE_TIMEOUT'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1060, height: 760, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  let stage = 'load';
  const run = fn => win.webContents.executeJavaScript('(' + fn.toString() + ')()', true);
  const screenshot = async name => fs.writeFileSync(path.join(artifacts, name), (await win.webContents.capturePage()).toPNG());
  try {
    const html = path.join(artifacts, 'answer-ui-smoke.html'), dist = path.resolve(__dirname, '../dist');
    fs.writeFileSync(html, fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(dist + path.sep).href + '"><script>(' + fixture.toString() + ')();</script>'));
    await win.loadFile(html);
    stage = 'reading during streaming and question changes';
    const reading = await run(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      const until = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await wait(30); } throw new Error('Wait failed: ' + document.body.innerText); };
      const find = text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text);
      const pane = () => document.querySelector('.answer-stage');
      const follow = () => [...document.querySelectorAll('.reading-navigation button')].find(button => /回到实时/.test(button.textContent));
      const scroll = async top => { pane().scrollTop = top; pane().dispatchEvent(new Event('scroll', { bubbles: true })); await wait(80); };
      const snapshot = (id, questionId, text, status = 'streaming') => window.answerSmoke.emit({ type: 'answer_snapshot', response_id: id, question_id: questionId, text, status });
      window.answerTest = { wait, until, find, pane, follow, scroll, snapshot };
      await until(() => document.querySelector('button[aria-controls="code-workspace"]') && !document.querySelector('button[aria-controls="code-workspace"]').disabled);
      const initialHeight = document.querySelector('.app-shell').getBoundingClientRect().height;
      window.answerSmoke.question('q1', '同一位歌手在三年内演唱的角色，如何统计共现次数？');
      const text = Array.from({ length: 28 }, (_, i) => `第 ${i + 1} 段：先按歌手分组，再比较演出年份；三年窗口包括边界，不能跨歌手配对。`).join('\n\n');
      snapshot('a1', 'q1', text);
      await until(() => pane().textContent.includes('第 28 段'));
      await wait(100);
      if (pane().scrollHeight - pane().clientHeight - pane().scrollTop > 34) throw new Error('Not following initial streaming answer');
      window.answerSmoke.emit({ type: 'answer_delta', response_id: 'a1', delta: '\n\n流式追加仍跟随底部。' });
      await until(() => pane().textContent.includes('流式追加')); await wait(80);
      if (pane().scrollHeight - pane().clientHeight - pane().scrollTop > 34) throw new Error('Lost bottom during append');
      await scroll(190); const offset = pane().scrollTop;
      window.answerSmoke.emit({ type: 'answer_delta', response_id: 'a1', delta: '\n\n新的补充不应抢走阅读位置。' });
      await until(() => pane().textContent.includes('新的补充')); await wait(80);
      if (Math.abs(pane().scrollTop - offset) > 2) throw new Error('Stream moved scrolled-up reader');
      const canReturnWithinAnswer = Boolean(follow());
      window.answerSmoke.emit({ type: 'answer_completed', response_id: 'a1' });
      window.answerSmoke.question('q2', '如果同一个歌手重复演唱某个角色，应该如何计数？');
      snapshot('a2', 'q2', '第二题的回答：先确认按演出配对还是按歌手去重。', 'completed');
      await wait(120);
      const preservesReadingAcrossTopics = pane().textContent.includes('第 1 段') && Math.abs(pane().scrollTop - offset) <= 2;
      const newQuestionAffordance = Boolean(follow());
      if (follow()) { follow().click(); await until(() => pane().textContent.includes('第二题的回答')); }
      if (!pane().textContent.includes('第二题的回答')) throw new Error('Cannot navigate to new question');
      snapshot('a3', 'q2', '同一题的追加回答：重复演出是否算多次属于计数规则。', 'completed');
      await until(() => pane().querySelectorAll('.answer-segment').length === 3);
      if (pane().querySelector('.answer-question') || find('上一条') || /问题 \d+ \/ \d+/.test(document.body.innerText)) throw new Error('Question paging leaked into the Live stream');
      const ids = [...pane().querySelectorAll('[data-answer-id]')].map(node => node.dataset.answerId);
      if (ids.join(',') !== 'a1,a2,a3') throw new Error('Continuous stream did not retain ordered content across topics');
      if (Math.abs(document.querySelector('.app-shell').getBoundingClientRect().height - initialHeight) > 1 || document.documentElement.scrollHeight > innerHeight) throw new Error('Stream grew the page instead of scrolling inside its bounded area');
      window.answerSmoke.emit({ type: 'answer_delta', response_id: 'a2', delta: 'late-should-never-appear' });
      await wait(60);
      if (pane().textContent.includes('late-should-never-appear')) throw new Error('Completed answer rewritten');
      await scroll(offset);
      const authentications = window.answerSmoke.sent.filter(event => event.type === 'authenticate').length;
      window.answerSmoke.disconnect();
      await until(() => window.answerSmoke.sent.filter(event => event.type === 'authenticate').length > authentications);
      await until(() => !document.querySelector('button[aria-controls="code-workspace"]').disabled); await wait(100);
      const reconnectPreservedReading = pane().textContent.includes('第 1 段') && Math.abs(pane().scrollTop - offset) <= 2;
      return { streamingFollowsBottom: true, scrolledUpAppendStable: true, canReturnWithinAnswer, preservesReadingAcrossTopics,
        newQuestionAffordance, continuousOrderedStream: true, noQuestionPagination: true, fixedHeightReadingArea: true, completedTextImmutable: true, reconnectPreservedReading };
    });
    fs.writeFileSync(path.join(artifacts, 'answer-ui-reading.json'), JSON.stringify(reading, null, 2));
    if (Object.values(reading).some(value => value === false)) throw new Error('Reading checks failed: ' + JSON.stringify(reading));
    await run(async () => { window.answerTest.follow()?.click(); await window.answerTest.wait(80); });
    await screenshot('live-stream-desktop.png');
    stage = 'markdown, copy and mobile layout';
    const markdown = await run(async () => {
      const { until, wait, pane, follow, snapshot, scroll } = window.answerTest;
      const segment = () => pane().querySelector('[data-answer-id="markdown"]');
      if (follow()) follow().click();
      window.answerSmoke.question('q3', '如何设计一个支持递归引用的 PromptFormatter？');
      const text = '先澄清缺失键的行为，再确定 **循环引用';
      snapshot('markdown', 'q3', text);
      await until(() => pane().textContent.includes('循环引用'));
      if (pane().textContent.includes('**循环引用') || !pane().querySelector('strong')) throw new Error('Partial bold marker leaked');
      segment().querySelector('button[aria-label="复制回答"]').click();
      await until(() => window.answerSmoke.copied === text);
      window.answerSmoke.deferCopy = true;
      segment().querySelector('button[aria-label="复制回答"]').click();
      await until(() => window.answerSmoke.pendingCopies.length === 1);
      window.answerSmoke.emit({ type: 'answer_delta', response_id: 'markdown', delta: '** 如何报错。\n\n[官方文档](https://example.com/incom' });
      await wait(90);
      window.answerSmoke.pendingCopies[0].resolve(); await wait(40);
      if (segment().querySelector('button[aria-label="复制回答"]').textContent.includes('已复制')) throw new Error('Old copy success labeled new stream text copied');
      segment().querySelector('button[aria-label="复制回答"]').click();
      segment().querySelector('button[aria-label="复制回答"]').click();
      await until(() => window.answerSmoke.pendingCopies.length === 3);
      window.answerSmoke.pendingCopies[2].resolve();
      await until(() => segment().querySelector('button[aria-label="复制回答"]').textContent.includes('已复制'));
      window.answerSmoke.pendingCopies[1].reject(); await wait(40);
      if (!segment().querySelector('button[aria-label="复制回答"]').textContent.includes('已复制')) throw new Error('Late failed copy replaced newer success');
      window.answerSmoke.deferCopy = false;
      if (pane().querySelector('a')) throw new Error('Incomplete link became clickable');
      for (const [source, codeText] of [
        ['~~~python\nresult = "**literal', 'result = "**literal\n'],
        ['    return "[link](incomplete', 'return "[link](incomplete\n'],
        ['    if a <b', 'if a <b\n'],
      ]) {
        snapshot('markdown', 'q3', source); await wait(50);
        if (pane().querySelector('pre')?.textContent !== codeText) throw new Error('Streaming changed code: ' + source);
        pane().querySelector('button[aria-label="复制代码"]').click(); await until(() => window.answerSmoke.copied === codeText);
      }
      const finalText = '先澄清缺失键的行为，再确定 **循环引用** 如何报错。\n\n## 当前思路\n\n1. 用 `parameters` 保存原始参数。\n2. 用 `visiting` 记录当前递归路径。\n   - 遇到路径中的键就报告循环。\n   - 已完成结果放入缓存。\n\n> 暂时不决定缺失键是保留原文还是抛出异常，先与面试官确认。\n\n| 情况 | 输入 | 预期行为 | 原因 |\n| --- | --- | --- | --- |\n| 普通引用 | `%NAME%` | 返回参数值 | 直接查找 |\n| 循环引用 | `A → B → A` | 报告循环 | 当前路径重复 |\n\n```python\n# 我们用 visiting 记录这一轮正在展开的键\nvisiting = set()\nlong_name = "' + 'value_'.repeat(35) + '"\n```\n\n完整参考：[文档](https://example.com/guide)。';
      snapshot('markdown', 'q3', finalText, 'completed'); await wait(100);
      if (!pane().querySelector('ol ul') || !pane().querySelector('table') || !pane().querySelector('pre') || !pane().querySelector('blockquote')) throw new Error('Structured markdown missing');
      const link = pane().querySelector('a');
      if (!link || link.getAttribute('href') !== 'https://example.com/guide' || link.rel !== 'noreferrer noopener') throw new Error('Safe link broken');
      const expectedCode = '# 我们用 visiting 记录这一轮正在展开的键\nvisiting = set()\nlong_name = "' + 'value_'.repeat(35) + '"\n';
      pane().querySelector('button[aria-label="复制代码"]').click(); await until(() => window.answerSmoke.copied === expectedCode);
      segment().querySelector('button[aria-label="复制回答"]').click(); await until(() => window.answerSmoke.copied === finalText);
      window.answerSmoke.failCopy = true;
      segment().querySelector('button[aria-label="复制回答"]').click(); await until(() => segment().textContent.includes('复制失败'));
      window.answerSmoke.failCopy = false;
      segment().querySelector('button[aria-label="复制回答"]').click(); await until(() => segment().querySelector('button[aria-label="复制回答"]').textContent.includes('已复制'));
      await scroll(pane().scrollTop + segment().getBoundingClientRect().top - pane().getBoundingClientRect().top);
      return { incompleteMarkdownStable: true, incompleteLinksInactive: true, exactAnswerCopy: true, exactCodeCopy: true, copyFailureVisible: true, copyFeedbackFollowsCurrentContent: true, lateCopyResultIgnored: true, structuredMarkdown: true };
    });
    await screenshot('answer-ui-desktop.png');
    const widths = [];
    for (const width of [390, 320]) {
      stage = 'mobile layout ' + width; win.setSize(width, 780); await new Promise(resolve => setTimeout(resolve, 150));
      const mobile = await run(async () => {
        const { pane, scroll, until, wait } = window.answerTest;
        await scroll(0);
        if (document.documentElement.scrollWidth > innerWidth || pane().scrollWidth > pane().clientWidth + 2) throw new Error('Answer overflows viewport');
        const table = pane().querySelector('.answer-table'), pre = pane().querySelector('pre');
        if (table.scrollWidth <= table.clientWidth || pre.scrollWidth <= pre.clientWidth) throw new Error('Long table/code did not remain locally scrollable');
        for (const button of pane().querySelectorAll('button')) if (button.getBoundingClientRect().height < 43.5) throw new Error('Copy target too small');
        await scroll(170); const offset = pane().scrollTop;
        const toggle = document.querySelector('button[aria-controls="code-workspace"]');
        toggle.click(); await until(() => pane().clientHeight === 0);
        pane().dispatchEvent(new Event('scroll', { bubbles: true }));
        toggle.click(); await until(() => pane().clientHeight > 0); await wait(80);
        if (Math.abs(pane().scrollTop - offset) > 2) throw new Error('Code/answer switch lost reading position');
        return { width: innerWidth, noPageOverflow: true, localTableCodeScroll: true, copyTouchTargets: true, paneSwitchRetainsReading: true };
      });
      widths.push(mobile);
      await run(async () => {
        const { pane, scroll } = window.answerTest;
        const segment = pane().querySelector('[data-answer-id="markdown"]');
        await scroll(pane().scrollTop + segment.getBoundingClientRect().top - pane().getBoundingClientRect().top);
      });
      await screenshot('answer-ui-' + width + '.png');
      await run(async () => { const pane = window.answerTest.pane(); await window.answerTest.scroll(pane.scrollHeight); });
      await screenshot('answer-ui-' + width + '-code.png');
    }
    stage = 'history selects a specific segment within a question';
    const history = await run(async () => {
      const { until, wait, pane, snapshot, follow } = window.answerTest;
      if (follow()) follow().click();
      window.answerSmoke.question('q4', '介绍你最有挑战的项目，并解释当时的技术取舍。');
      snapshot('project-first', 'q4', Array.from({ length: 35 }, (_, i) => `背景 ${i + 1}：已确认的项目事实和本人职责。`).join('\n\n'), 'completed');
      snapshot('project-detail', 'q4', Array.from({ length: 30 }, (_, i) => `取舍 ${i + 1}：结合当时的负载与交付时间解释决定。`).join('\n\n'), 'completed');
      snapshot('project-final', 'q4', '最后一段：项目结果需要用真实的验证记录支持。', 'completed');
      window.answerSmoke.question('q5', '为什么选择 PostgreSQL？');
      snapshot('storage', 'q5', '这里需要一致性约束和多条件查询。', 'completed');
      await until(() => pane().textContent.includes('一致性约束'));
      document.querySelector('.more-button').click();
      await until(() => document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === '回答记录').click();
      await until(() => document.querySelector('.history-answer [data-answer-id="project-detail"]'));
      const target = document.querySelector('.history-answer [data-answer-id="project-detail"]').closest('.history-answer');
      [...target.querySelectorAll('button')].find(button => button.textContent.trim() === '阅读这条').click();
      await until(() => pane().querySelector('[data-answer-id="project-detail"]') && !document.querySelector('[role="dialog"]'));
      await wait(100);
      const targetTop = pane().querySelector('[data-answer-id="project-detail"]').getBoundingClientRect().top;
      if (Math.abs(targetTop - pane().getBoundingClientRect().top) > 2) throw new Error('History opened the question but not the requested segment');
      const offset = pane().scrollTop;
      snapshot('storage-followup', 'q5', '补充：同时说明事务和索引的代价。', 'completed');
      await wait(80);
      if (Math.abs(pane().scrollTop - offset) > 2 || !pane().textContent.includes('取舍 1')) throw new Error('History target was lost to later answer');
      document.querySelector('.more-button').click(); await until(() => document.querySelector('[role="menu"]'));
      const expand = [...document.querySelectorAll('[role="menuitem"]')].find(item => /展开/.test(item.textContent));
      if (!expand) throw new Error('Expand action missing');
      expand.click(); await until(() => window.answerSmoke.sent.some(event => event.type === 'quick_answer'));
      const request = window.answerSmoke.sent.filter(event => event.type === 'quick_answer').at(-1);
      if (request.response_id !== 'project-detail' || request.question_id !== 'q4') throw new Error('Action target did not match the chosen historical answer: ' + JSON.stringify(request));
      window.answerSmoke.emit({ type: 'operation_status', operation_id: request.operation_id, kind: 'quick_answer', action: request.action, status: 'completed' });
      return { historySelectsSpecificSegment: true, historyStaysPinnedDuringNewAnswer: true, actionTargetsChosenAnswer: true };
    });
    stage = 'resize while following and while reading older text';
    const beforeResize = await run(async () => {
      await window.answerTest.scroll(150);
      const pane = window.answerTest.pane(), top = pane.getBoundingClientRect().top;
      const anchor = [...pane.querySelectorAll('.answer-markdown p')].find(element => element.getBoundingClientRect().bottom > top);
      return { text: anchor.textContent, top: anchor.getBoundingClientRect().top - top, height: anchor.getBoundingClientRect().height };
    });
    win.setSize(390, 600); await new Promise(resolve => setTimeout(resolve, 160));
    const pinnedResize = await run(() => {
      const pane = window.answerTest.pane(), top = pane.getBoundingClientRect().top;
      return { text: pane.textContent, anchors: [...pane.querySelectorAll('.answer-markdown p')].map(element => ({ text: element.textContent, top: element.getBoundingClientRect().top - top, height: element.getBoundingClientRect().height })) };
    });
    // A width change reflows lines; preserving the paragraph matters, not the old pixel offset.
    const anchorAfter = pinnedResize.anchors.find(anchor => anchor.text === beforeResize.text);
    if (!anchorAfter || Math.abs(anchorAfter.top - beforeResize.top) > Math.max(beforeResize.height, anchorAfter.height) + 4 || !pinnedResize.text.includes('取舍 1')) throw new Error('Resize displaced pinned reading');
    await run(async () => {
      const { follow, snapshot, until, pane } = window.answerTest;
      follow().click();
      window.answerSmoke.question('q6', '请解释缓存失效策略。');
      snapshot('resize-answer', 'q6', Array.from({ length: 25 }, (_, i) => `策略 ${i + 1}：先说明一致性要求，再比较失效方案。`).join('\n\n'));
      await until(() => pane().textContent.includes('策略 25'));
    });
    win.setSize(320, 780); await new Promise(resolve => setTimeout(resolve, 180));
    const atBottomAfterResize = await run(() => { const pane = window.answerTest.pane(); return pane.scrollHeight - pane.scrollTop - pane.clientHeight <= 34; });
    if (!atBottomAfterResize) throw new Error('Latest-follow lost bottom after resize');
    stage = 'interruption preserves partial text';
    const interrupted = await run(async () => {
      const { pane, until, wait } = window.answerTest;
      window.answerSmoke.emit({ type: 'answer_interrupted', response_id: 'resize-answer', detail: '测试连接中断，保留已收到的内容。' });
      await until(() => pane().textContent.includes('测试连接中断'));
      window.answerSmoke.emit({ type: 'answer_delta', response_id: 'resize-answer', delta: 'late-interrupted-delta' }); await wait(50);
      if (!pane().textContent.includes('策略 25') || pane().textContent.includes('late-interrupted-delta')) throw new Error('Interrupted text not stable');
      return { interruptedTextPreserved: true, interruptedLateDeltaIgnored: true };
    });
    stage = 'history action for a short latest group';
    const shortHistory = await run(async () => {
      const { until, wait, pane, snapshot, follow } = window.answerTest;
      if (follow()) follow().click();
      window.answerSmoke.question('q7', '解释 TCP 和 UDP 的区别。');
      snapshot('short-first', 'q7', 'TCP 提供可靠有序的字节流。', 'completed');
      snapshot('short-last', 'q7', 'UDP 提供独立的数据报。', 'completed');
      await until(() => pane().textContent.includes('独立的数据报'));
      document.querySelector('.more-button').click(); await until(() => document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(item => item.textContent.trim() === '回答记录').click();
      await until(() => document.querySelector('.history-answer [data-answer-id="short-first"]'));
      const target = document.querySelector('.history-answer [data-answer-id="short-first"]').closest('.history-answer');
      [...target.querySelectorAll('button')].find(button => button.textContent.trim() === '阅读这条').click();
      await until(() => !document.querySelector('[role="dialog"]')); await wait(120);
      const count = window.answerSmoke.sent.filter(event => event.type === 'quick_answer').length;
      document.querySelector('.more-button').click(); await until(() => document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(item => /展开/.test(item.textContent)).click();
      await until(() => window.answerSmoke.sent.filter(event => event.type === 'quick_answer').length > count);
      if (window.answerSmoke.sent.filter(event => event.type === 'quick_answer').at(-1).response_id !== 'short-first') throw new Error('Short historical answer action silently selected group-last');
      return { shortHistoryActionKeepsExplicitTarget: true };
    });
    if (errors.length) throw new Error('Renderer errors: ' + errors.join('\n'));
    const report = { ...reading, ...markdown, ...history, ...shortHistory, ...interrupted, mobile: widths, pinnedResize: true, followingResize: true, rendererErrors: errors, fixtureOnly: true, providerOrMediaTested: false };
    fs.writeFileSync(path.join(artifacts, 'answer-ui-smoke.json'), JSON.stringify(report, null, 2));
    console.log('ANSWER_UI_SMOKE_OK ' + JSON.stringify(report)); clearTimeout(timeout); win.destroy(); app.exit(0);
  } catch (error) {
    const diagnostics = await run(() => ({ text: document.body.innerText, scrollTop: document.querySelector('.answer-stage')?.scrollTop, scrollHeight: document.querySelector('.answer-stage')?.scrollHeight }));
    fs.writeFileSync(path.join(artifacts, 'answer-ui-failure.json'), JSON.stringify({ stage, error: String(error), diagnostics, errors }, null, 2));
    await screenshot('answer-ui-failure.png'); console.error('ANSWER_UI_SMOKE_FAILED', stage, error); clearTimeout(timeout); win.destroy(); app.exit(1);
  }
});
