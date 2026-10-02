// Offline React + Electron fixture: no audio, provider calls or external network.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const artifacts = path.resolve(__dirname, '../../../artifacts');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'code-ui-electron'));
app.disableHardwareAcceleration();
function fixture() {
  const sockets = [], sent = [];
  const first = { document_id: 'model', filename: 'models.py', revision: 2, code: 'class Model: pass', language: 'python', can_undo: true, completeness: 'complete' };
  const second = { document_id: 'service', filename: 'service.py', revision: 1, code: 'def serve(): pass', language: 'python', can_undo: false, completeness: 'complete' };
  const workspace = { ...first, context_version: 0, problem_id: 'question1', files: [first, second], run_id: '', reveal_id: 'step1', screen_follow: { enabled: false, status: 'off', detail: '' },
    proposal: { proposal_id: 'step1', base_revision: 2, base_code: first.code, code: 'class Model: ready = True', language: 'python', explanation: '先定义返回值，再把 service 接起来。', context_changed: false, code_changed: false,
      changes: [{ ...first, base_revision: 2, base_code: first.code, code: 'class Model: ready = True', code_changed: false },
        { ...second, base_revision: 1, base_code: second.code, code: 'def serve(): return Model()', code_changed: false },
        { document_id: 'newfile', filename: 'test_service.py', base_revision: 0, base_code: '', code: 'assert serve().ready', language: 'python', new_file: true, code_changed: false }] } };
  const emit = event => sockets.filter(socket => socket.readyState === 1).forEach(socket => socket.message(event));
  const sync = () => { Object.assign(workspace, workspace.files.find(file => file.document_id === workspace.document_id)); emit({ type: 'code_state', workspace }); };
  window.codeSmoke = { sent, workspace, emit, sync, disconnect: () => sockets.filter(socket => socket.readyState === 1).forEach(socket => socket.close(1006)) };
  window.interviewDesktop = { isElectron: false, captureHost: false, apiBaseUrl: 'https://fixture.invalid' };
  window.fetch = async () => new Response(JSON.stringify({ interview_id: 'fixture', session_token: 'fixture-only', device_status: { status: 'ready', channels: { interviewer: true, candidate: true } }, interview_state: { active: true } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
          this.message({ type: 'answer_snapshot_done' });
          this.message({ type: 'answer_snapshot', response_id: 'answer1', text: '先定义 Model 的职责，再接入 service。\n\n当前只补上返回值，然后继续核对实际代码。', status: 'completed' });
          this.message({ type: 'code_state', workspace });
        } else if (event.type === 'ping') this.message({ type: 'pong' });
        else if (event.type === 'code_action') {
          const selected = workspace.files.find(file => file.document_id === workspace.document_id);
          if (event.document_id !== selected.document_id || event.base_revision !== selected.revision) throw new Error('Wrong confirmed actual revision: ' + JSON.stringify(event));
          if (event.action === 'select_file') workspace.document_id = event.selected_document_id;
          else if (event.action === 'follow') workspace.screen_follow = { enabled: event.enabled, status: event.enabled ? 'watching' : 'off', detail: '' };
          else if (event.action !== 'generate') throw new Error('Unexpected actual-code mutation: ' + event.action);
          sync(); emit({ type: 'operation_status', operation_id: event.operation_id, kind: 'code_action', action: event.action, status: 'completed' });
        }
      });
    }
  }
  window.WebSocket = Socket;
}
const timeout = setTimeout(() => { console.error('CODE_UI_SMOKE_TIMEOUT'); app.exit(1); }, 40000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1060, height: 760, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
  win.webContents.setAudioMuted(true);
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('file:') }));
  let stage = 'load';
  const run = (fn) => win.webContents.executeJavaScript('(' + fn.toString() + ')()', true);
  const screenshot = async name => fs.writeFileSync(path.join(artifacts, name), (await win.webContents.capturePage()).toPNG());
  try {
    const html = path.join(artifacts, 'code-ui-smoke.html'), dist = path.resolve(__dirname, '../dist');
    fs.writeFileSync(html, fs.readFileSync(path.join(dist, 'index.html'), 'utf8').replace('<head>', '<head><base href="' + pathToFileURL(dist + path.sep).href + '"><script>(' + fixture.toString() + ')();</script>'));
    await win.loadFile(html);
    stage = 'read-only code workflow';
    const result = await run(async () => {
      const find = text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text);
      const until = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error(document.body.innerText); };
      const ref = () => document.querySelector('.code-reference'), title = () => document.querySelector('.code-proposal-file h3')?.textContent;
      const warning = () => document.querySelector('.code-proposal-file > .code-warning')?.textContent ?? '';
      window.codeTest = { find, until };
      const { workspace: state, sent, sync } = window.codeSmoke;
      await until(() => find('下一步') && !find('下一步').disabled);
      if (ref().open || document.querySelector('.code-options').open) throw new Error('Secondary sections not collapsed');
      if (document.querySelector('.code-panel textarea, .code-panel input, .code-panel [contenteditable="true"], #import-code-file')) throw new Error('Editing/import controls remain');
      if (find('保存实际代码') || find('采用修改') || find('新建文件')) throw new Error('Editor/apply action remains');
      if (document.querySelectorAll('.code-file-tabs button').length !== 3 || document.querySelectorAll('.code-proposal-file').length !== 1) throw new Error('Expected three tabs and one selected patch');
      if (document.querySelectorAll('.primary-actions button').length !== 3) throw new Error('Primary toolbar should have three actions');
      if (state.files[0].code !== 'class Model: pass') throw new Error('Proposal changed actual code');
      find('service.py').click(); await until(() => state.document_id === 'service' && title() === 'service.py');
      ref().open = true; await until(() => document.querySelector('.code-actual')?.textContent === 'def serve(): pass'); ref().open = false;
      const count = sent.filter(event => event.type === 'code_action').length;
      find('test_service.py · 新文件').click(); await until(() => title()?.includes('test_service.py'));
      if (sent.filter(event => event.type === 'code_action').length !== count) throw new Error('Proposed new file sent real selection');
      ref().open = true;
      if (!ref().textContent.includes('尚未观察到实际内容') || document.querySelector('.code-actual')) throw new Error('Proposed file shown as actual');
      ref().open = false; find('下一步').click(); await until(() => sent.some(event => event.action === 'generate'));
      const first = sent.find(event => event.action === 'generate');
      if (first.document_id !== 'service' || first.base_revision !== 1) throw new Error('Proposed revision sent to next step');
      Object.assign(state.files[0], { revision: 3, code: 'class Model: observed = True', completeness: 'partial' }); state.proposal.code_changed = true; state.proposal.changes[0].code_changed = true; sync();
      find('models.py').click(); await until(() => state.document_id === 'model' && warning().includes('旧建议需重新核对'));
      if (document.querySelector('.code-old-proposal').open) throw new Error('Stale patch not collapsed');
      ref().open = true; await until(() => document.querySelector('.code-actual')?.textContent === 'class Model: observed = True');
      if (!ref().textContent.includes('部分代码')) throw new Error('Partial observation shown as complete'); ref().open = false;
      find('service.py').click(); await until(() => state.document_id === 'service' && title() === 'service.py');
      if (warning() || document.querySelector('.code-old-proposal')) throw new Error('Stale file contaminated valid patch');
      if (!document.querySelector('.code-diff')?.textContent.includes('return Model()')) throw new Error('Valid patch disappeared');
      Object.assign(state.files[0], { revision: 4, code: state.proposal.changes[0].code, completeness: 'complete' }); sync();
      find('models.py').click(); await until(() => state.document_id === 'model' && warning().includes('已观察到这段改动'));
      const requests = sent.filter(event => event.action === 'generate').length;
      find('下一步').click(); await until(() => sent.filter(event => event.action === 'generate').length > requests);
      const latest = sent.filter(event => event.action === 'generate').at(-1);
      if (latest.document_id !== 'model' || latest.base_revision !== 4) throw new Error('Next step ignored latest observed revision');
      if (sent.some(event => ['save', 'apply', 'create_file'].includes(event.action))) throw new Error('Read-only UI sent actual write');
      const options = document.querySelector('.code-options'); options.open = true;
      find('跟随代码窗口').click(); await until(() => state.screen_follow.enabled && options.textContent.includes('跟随已开')); options.open = false;
      find('service.py').click(); await until(() => state.document_id === 'service' && title() === 'service.py');
      window.codeSmoke.disconnect(); await until(() => find('下一步').disabled);
      const offlineActions = sent.filter(event => event.type === 'code_action').length;
      find('models.py').click(); await until(() => title() === 'models.py');
      if (sent.filter(event => event.type === 'code_action').length !== offlineActions) throw new Error('Offline browsing sent a file selection');
      await until(() => !find('下一步').disabled);
      const reconnectRequests = sent.filter(event => event.action === 'generate').length;
      find('下一步').click(); await until(() => sent.filter(event => event.action === 'generate').length > reconnectRequests);
      const recovered = sent.filter(event => event.action === 'generate').at(-1);
      if (recovered.document_id !== 'service' || recovered.base_revision !== 1) throw new Error('Offline tab replaced confirmed server base after reconnect');
      find('service.py').click(); await until(() => title() === 'service.py');
      document.querySelector('.code-region').scrollTop = 0;
      return { readOnlyCodePanel: true, minimalPrimaryButtons: true, actualCodeInitiallyCollapsed: true, fileTabsShowSinglePatch: true,
        provisionalFileNotActual: true, proposalNeverApplied: true, observedCodeUpdated: true, partialObservationLabeled: true,
        stalePatchCollapsed: true, perFileStaleIsolation: true, completedObservationRecognized: true, actualRevisionUsedForNextStep: true,
        followToggle: true, offlineBrowsingUsesConfirmedBaseAfterReconnect: true, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
    });
    if (result.horizontalOverflow) throw new Error('Desktop overflow');
    await new Promise(resolve => setTimeout(resolve, 150)); await screenshot('code-ui-smoke.png');
    const widths = [];
    for (const width of [390, 320]) {
      stage = 'phone layout ' + width; win.setSize(width, 780); await new Promise(resolve => setTimeout(resolve, 180));
      const narrow = await run(async () => {
        const { until } = window.codeTest;
        const visible = element => element && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().height > 0;
        const answer = () => document.querySelector('.answer-stage'), code = () => document.querySelector('.code-region');
        const toggle = () => document.querySelector('button[aria-controls="code-workspace"]');
        if (document.documentElement.scrollWidth > innerWidth || visible(answer()) || !visible(code())) throw new Error('Phone code pane not contained');
        if (toggle().querySelector('.mobile-code-label')?.textContent !== '回答') throw new Error('Missing answer switch');
        toggle().click(); await until(() => visible(answer()) && !visible(code()));
        if (document.documentElement.scrollWidth > innerWidth || toggle().querySelector('.mobile-code-label')?.textContent !== '代码') throw new Error('Phone answer pane not contained');
        toggle().click(); await until(() => !visible(answer()) && visible(code()));
        const sizes = [...document.querySelectorAll('.primary-actions button, .code-file-tabs button')].map(button => button.getBoundingClientRect().height);
        if (sizes.some(height => height < 43.5)) throw new Error('Phone targets too short: ' + sizes.join(','));
        return { width: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, singlePaneSwitch: true, touchTargets: true };
      });
      widths.push(narrow); await screenshot(width === 390 ? 'code-ui-smoke-narrow.png' : 'code-ui-smoke-320.png');
    }
    stage = 'phone reading position during code view';
    const reading = await run(async () => {
      const { until } = window.codeTest;
      const toggle = () => document.querySelector('button[aria-controls="code-workspace"]');
      const pane = () => document.querySelector('.answer-stage');
      window.codeSmoke.emit({ type: 'answer_snapshot', response_id: 'long-answer', status: 'streaming',
        text: Array.from({ length: 60 }, (_, index) => `第 ${index + 1} 段：先解释当前步骤，再核对实际进展。`).join('\n\n') });
      toggle().click();
      await until(() => pane().clientHeight > 0 && pane().scrollHeight > pane().clientHeight + 500);
      pane().scrollTop = 180;
      pane().dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 80));
      const previous = pane().scrollTop;
      toggle().click(); await until(() => pane().clientHeight === 0);
      // Browsers can dispatch scroll after hiding an element. That must not
      // overwrite the user's last visible reading position with zero.
      pane().dispatchEvent(new Event('scroll', { bubbles: true }));
      window.codeSmoke.emit({ type: 'answer_delta', response_id: 'long-answer', delta: '\n\n新内容在代码区打开期间继续追加。' });
      await until(() => pane().textContent.includes('新内容在代码区'));
      toggle().click(); await until(() => pane().clientHeight > 0);
      if (Math.abs(pane().scrollTop - previous) > 2) throw new Error('Hidden-pane update lost reading position: ' + previous + ' -> ' + pane().scrollTop);
      toggle().click(); await until(() => pane().clientHeight === 0);
      return { hiddenPaneAppendPreservesReadingOffset: true };
    });
    stage = 'mobile More menu';
    await run(async () => { document.querySelector('.more-button').click(); await window.codeTest.until(() => document.querySelector('[role="menu"]')); });
    const menu = await run(() => {
      const items = [...document.querySelectorAll('[role="menuitem"]')];
      for (const label of ['暂停自动回答', '实时转写', '回答记录', '设备与连接']) {
        const item = items.find(item => item.textContent.trim() === label);
        if (!item || item.getAttribute('aria-disabled') === 'true') throw new Error('Missing or disabled More action: ' + label);
      }
      const bounds = document.querySelector('[role="menu"]').getBoundingClientRect();
      if (bounds.left < -1 || bounds.right > innerWidth + 1) throw new Error('More menu exceeds phone viewport');
      return { moreMenuAccessible: true };
    });
    stage = 'mobile menu Escape';
    await run(async () => {
      const item = document.querySelector('[role="menuitem"]'); item.focus();
      item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
      await window.codeTest.until(() => !document.querySelector('[role="menu"]'));
    });
    stage = 'observed new file keeps one tab';
    const identity = await run(async () => {
      const { find, until } = window.codeTest;
      const state = window.codeSmoke.workspace;
      state.files.push({ document_id: 'observed-test-file', filename: 'test_service.py', revision: 1,
        code: 'assert serve().ready', language: 'python', completeness: 'complete', can_undo: true });
      state.proposal.changes[2].code_changed = true; window.codeSmoke.sync();
      await until(() => find('test_service.py'));
      if (document.querySelectorAll('.code-file-tabs button').length !== 3 || find('test_service.py · 新文件')) throw new Error('Observing a proposed filename duplicated its tab');
      find('test_service.py').click();
      await until(() => state.document_id === 'observed-test-file' && document.querySelector('.code-proposal-file > .code-warning')?.textContent.includes('已观察到这段改动'));
      const reference = document.querySelector('.code-reference'); reference.open = true;
      if (document.querySelector('.code-actual')?.textContent !== 'assert serve().ready') throw new Error('Observed proposed file remained provisional');
      reference.open = false;
      return { observedNewFileUsesSingleTab: true };
    });
    stage = 'new question resets transient state';
    const reset = await run(async () => {
      const { find, until } = window.codeTest;
      document.querySelector('.code-options').open = true; find('换一道题').click(); await until(() => find('开始新题'));
      const file = { document_id: 'new-problem-file', filename: 'main.py', code: '', revision: 0, language: 'python', can_undo: false, completeness: 'complete' };
      Object.assign(window.codeSmoke.workspace, file, { problem_id: 'question2', files: [file], proposal: null, reveal_id: '' }); window.codeSmoke.sync();
      await until(() => !find('开始新题') && !document.querySelector('.code-file-tabs'));
      if (document.querySelector('.code-options').open || document.querySelector('.code-proposal-file')) throw new Error('Old question state leaked');
      return { newProblemClearsFileSelection: true, resetConfirmationCleared: true, secondaryControlsCollapsed: true };
    });
    const report = { ...result, narrow: widths, ...reading, ...menu, menuEscape: true, ...identity, ...reset, fixtureOnly: true, providerOrAudioTested: false };
    fs.writeFileSync(path.join(artifacts, 'code-ui-smoke.json'), JSON.stringify(report, null, 2));
    console.log('CODE_UI_SMOKE_OK ' + JSON.stringify(report)); clearTimeout(timeout); win.destroy(); app.exit(0);
  } catch (error) {
    const diagnostics = await run(() => [...document.querySelectorAll('[role], .actions-popover')].map(element => ({ tag: element.tagName, role: element.getAttribute('role'), label: element.getAttribute('aria-label'), class: element.className, text: element.textContent.slice(0, 100) })));
    fs.writeFileSync(path.join(artifacts, 'code-ui-smoke-failure.json'), JSON.stringify({ stage, error: String(error), diagnostics }, null, 2));
    await screenshot('code-ui-smoke-failure.png');
    console.error('CODE_UI_SMOKE_FAILED', stage, error); clearTimeout(timeout); win.destroy(); app.exit(1);
  }
});
