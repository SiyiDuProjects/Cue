// Offline end-to-end: built product UI -> real FastAPI/WS/runtime/tools.
// Provider decisions, editor screenshots and audio host are synthetic.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '../../..');
const artifacts = path.join(root, 'artifacts/plan-acceptance-2026-09-27');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'electron-profile'));
app.disableHardwareAcceleration();
let child, win, log = '', errors = [];
const deadline = setTimeout(() => finish(new Error('Full-stack timeout')), 90000);
function finish(error) {
  clearTimeout(deadline);
  if (win && !win.isDestroyed()) win.destroy();
  if (child) child.kill();
  fs.writeFileSync(path.join(artifacts, 'server.log'), log);
  if (error) console.error(error.message);
  app.exit(error ? 1 : 0);
}
async function port() { return await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
app.whenReady().then(async () => {
  try {
    const base = 'http://127.0.0.1:' + await port();
    child = spawn(path.join(root, 'apps/server/.venv/Scripts/python.exe'), [path.join(__dirname, 'interview-audit-server.py')], {
      cwd: path.join(root, 'apps/server'), windowsHide: true, env: { ...process.env, PLAN_AUDIT: '1', AUDIT_PORT: new URL(base).port }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', b => log += b); child.stderr.on('data', b => log += b);
    for (let n = 0; n < 150; n++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    win = new BrowserWindow({ show: false, width: 1200, height: 780, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith(base + '/') || d.url.startsWith(base.replace('http', 'ws') + '/')) }));
    await win.loadURL(base + '/__audit/ui');
    const checks = [];
    async function run(name, code) {
      const result = await win.webContents.executeJavaScript(`(async()=>{
        const until = async f => { for(let n=0;n<240;n++){if(await f())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timeout: '+document.body.innerText); };
        const button = text => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);
        const aria = label => document.querySelector('[aria-label="'+label+'"]');
        const tab = key => document.querySelector('[role="tab"][data-key="'+key+'"]');
        const scene = async name => {const r=await fetch('/__audit/scene',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scene:name})});if(!r.ok)throw Error(await r.text());return r.json();};
        const state = async()=> (await fetch('/__audit/state')).json();
        ${code}
      })()`, true);
      checks.push({name, result}); console.log('PASS', name);
    }
    await run('oral_clarification_then_plan', `
      await until(()=>document.querySelector('[role="option"]'));document.querySelector('[role="option"]').click();
      await until(()=>button('开始面试')&&!button('开始面试').disabled);button('开始面试').click();
      await until(()=>button('结束面试'));await scene('clarify');
      await until(()=>document.querySelector('.preview-analysis-scroll')?.innerText.includes('未知参数'));
      if((await state()).workspace.proposal.steps.length)throw Error('Clarification has code');
      (button('更新代码')||button('更新分析')).click();
      await until(async()=> (await state()).workspace.proposal.steps.length===2);
      await until(()=>!button('停止'));tab('code').click();
      await until(()=>document.querySelector('.preview-step-heading')?.innerText==='建立扫描状态');
      if(!document.querySelectorAll('.preview-code-line.is-added').length)throw Error('First modification has no diff');
      if(!aria('上一步').disabled)throw Error('Baseline is still a separate step');
      const before=await state(), count=window.auditControls.length;
      aria('下一步').click();await until(()=>document.querySelector('.preview-step-heading').innerText==='定义缺失参数规则');
      if(window.auditControls.length!==count)throw Error('Paging called backend');
      if((await state()).workspace.code!=='')throw Error('Paging applied code');
      if(!document.querySelector('[role="tab"][aria-label="policy.py，本步修改"]'))throw Error('Affected file missing');
      aria('上一步').click();await until(()=>document.querySelector('.preview-step-heading').innerText==='建立扫描状态');
      return {steps:before.workspace.proposal.steps.length,localPaging:true,actualUnchanged:true};
    `);
    fs.writeFileSync(path.join(artifacts,'desktop.png'),(await win.webContents.capturePage()).toPNG());
    await run('observe_replan_and_screenshot_batch', `
      await scene('partial_typing');await until(()=>document.querySelector('.plan-notice')?.innerText.includes('代码已变化'));
      (button('更新代码')||button('更新分析')).click();await until(()=>!button('停止')&&tab('code').getAttribute('aria-selected')==='true');
      const updated=await state();if(updated.workspace.code!=='cursor = 0')throw Error('Observation lost');
      if(updated.workspace.proposal.steps[0].changes[0].base_code!=='cursor = 0')throw Error('Replan ignored observed code');
      button('截图').click();await until(()=>button('截图 · 1'));button('截图 · 1').click();await until(()=>button('截图 · 2'));
      (button('更新代码')||button('更新分析')).click();await until(()=>button('截图')&&!button('停止'));
      const action=window.auditControls.filter(e=>e.type==='code_action'&&e.action==='generate').at(-1);
      if(action.request_ids.length!==2)throw Error('Screenshot batch lost');
      return {observedBase:true,screens:action.request_ids.length};
    `);
    await run('reconnect_and_continuous_answers', `
      const before=await state(), ready=window.auditEvents.filter(e=>e.type==='session_ready').length;
      await scene('reconnect');await until(()=>window.auditEvents.filter(e=>e.type==='session_ready').length>ready);
      await until(()=>(button('更新代码')||button('更新分析'))&&!(button('更新代码')||button('更新分析')).disabled);
      if((await state()).workspace.proposal.proposal_id!==before.workspace.proposal.proposal_id)throw Error('Plan lost');
      await scene('resume_round');await until(()=>document.querySelector('.preview-answer-scroll').innerText.includes('不要补造项目数据'));
      if(!document.querySelector('.preview-answer-scroll').innerText.includes('未知参数如何处理'))throw Error('Answers overwritten');
      return {snapshot:true,appendOnly:true};
    `);
    await run('reset_rejects_late_results', `
      await scene('pending_old');button('换题').click();await until(async()=> !(await state()).workspace.proposal);
      const late=await scene('late_old');if(!late.late_code_blocked||!late.late_text_blocked)throw Error('Stale result accepted');
      await until(()=>button('分析这题'));return {lateRejected:true};
    `);
    await run('reopen_workspace_for_phone', `button('分析这题').click();await until(()=>(button('更新代码')||button('更新分析')));tab('code').click();return true;`);
    win.setSize(844, 390); await new Promise(r=>setTimeout(r,300));
    await run('phone_landscape_keeps_both_panes', `
      const a=document.querySelector('.preview-answer-scroll').getBoundingClientRect(), c=document.querySelector('.preview-code-scroll').getBoundingClientRect();
      if(a.height<50||c.height<50||c.x<a.right-2||document.documentElement.scrollWidth>innerWidth)throw Error('Landscape layout failed '+JSON.stringify({a:a.toJSON(),c:c.toJSON(),width:innerWidth}));
      return {answerHeight:a.height,codeHeight:c.height};
    `);
    fs.writeFileSync(path.join(artifacts,'phone.png'),(await win.webContents.capturePage()).toPNG());
    await run('theme_pause_and_end_controls', `
      aria('更多').click();await until(()=>document.querySelector('[role="menu"]'));
      const item=text=>[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.trim()===text);
      item('夜间模式').click();await until(()=>document.documentElement.classList.contains('dark')||document.documentElement.dataset.theme==='dark');
      aria('更多').click();await until(()=>item('暂停回答'));item('暂停回答').click();await until(()=>document.querySelector('.preview-paused'));
      button('结束面试').click();await until(()=>document.querySelector('[role="alertdialog"]'));button('继续面试').click();await until(()=>!document.querySelector('[role="alertdialog"]'));
      return {theme:true,hold:true,visibleEnd:true,cancelEnd:true};
    `);
    fs.writeFileSync(path.join(artifacts,'ui-report.json'),JSON.stringify({checks,errors,synthetic:['provider','capture'],real:['built React','HTTP','WebSocket','runtime','tools']},null,2));
    if(errors.length)throw Error('Browser errors: '+errors.join('; '));
    console.log('PLAN_UI_FULLSTACK_OK',checks.length);finish();
  } catch(e){ if(win&&!win.isDestroyed())fs.writeFileSync(path.join(artifacts,'failure.png'),(await win.webContents.capturePage()).toPNG());finish(e); }
});
