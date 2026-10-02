// Offline end-to-end: built product UI -> real FastAPI/WS/runtime/tools.
// Provider decisions, editor screenshots and audio host are synthetic.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '../../..');
const artifacts = path.join(root, 'artifacts/answer-quality-2026-09-28/ui');
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
      if(!aria('上一步').disabled||!aria('步骤目录').innerText.includes('1 / 2'))throw Error('Baseline counted as a step');
      const before=await state(), count=window.auditControls.length;
      aria('下一步').click();await until(()=>document.querySelector('.preview-step-heading').innerText==='定义缺失参数规则');
      if(window.auditControls.length!==count)throw Error('Paging called backend');
      if((await state()).workspace.code!=='')throw Error('Paging applied code');
      if(!document.querySelector('[role="tab"][aria-label="policy.py，本步修改"]'))throw Error('Affected file missing');
      aria('上一步').click();await until(()=>document.querySelector('.preview-step-heading').innerText==='建立扫描状态');
      return {steps:before.workspace.proposal.steps.length,localPaging:true,actualUnchanged:true};
    `);
    fs.writeFileSync(path.join(artifacts,'desktop.png'),(await win.webContents.capturePage()).toPNG());
    await run('same_problem_history_has_short_titles', `
      aria('方案历史').click(); await until(()=>document.querySelector('[aria-label="本题方案历史"]'));
      const dialog=document.querySelector('[aria-label="本题方案历史"]');
      if(!dialog.innerText.includes('遍历扫描')||dialog.innerText.includes('往场题目'))throw Error('History scope/title incorrect');
      aria('关闭历史').click(); return true;
    `);
    await run('local_directory_and_complete_code', `
      const count=window.auditControls.length;aria('步骤目录').click();await until(()=>document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('完整代码')).click();
      await until(()=>document.querySelector('.preview-step-heading').innerText.includes('完整代码'));
      if(document.querySelectorAll('.preview-code-line.is-added').length)throw Error('Complete code includes patch markers');
      if(window.auditControls.length!==count)throw Error('Directory invoked model');
      if(!aria('复杂度说明').innerText.includes('O(n)'))throw Error('Complexity missing');
      aria('复杂度说明').click();await until(()=>document.body.innerText.includes('n 是模板长度'));
      document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      aria('步骤目录').click();await until(()=>document.querySelector('[role="menu"]'));
      if([...document.querySelectorAll('[role="menuitem"]')].some(e=>e.textContent.includes('当前代码')))throw Error('Baseline remains in directory');
      [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.startsWith('1.')).click();return true;
    `);
    await run('analysis_update_preserves_live_code_scroll', `
      await scene('long_plan');await until(()=>document.querySelectorAll('.preview-code-line').length>75);
      const scroll=document.querySelector('.preview-code-scroll');scroll.scrollTop=520;scroll.dispatchEvent(new Event('scroll',{bubbles:true}));
      const saved=scroll.scrollTop; if(saved<100)throw Error('Fixture not scrollable');
      const before=(await state()).workspace.proposal.proposal_id;await scene('analysis_only');
      await until(async()=> (await state()).workspace.proposal.proposal_id!==before);
      await until(()=>document.querySelector('.preview-analysis-scroll').innerText.includes('补充扫描依据'));
      if(tab('code').getAttribute('aria-selected')!=='true'||document.querySelector('.preview-code-scroll')!==scroll||Math.abs(scroll.scrollTop-saved)>2)throw Error('Metadata update lost reading position');
      return {sameNode:true,scroll:saved};
    `);
    await run('split_step_preserves_solution_and_stays_at_children', `
      const before=(await state()).workspace, terminal=before.proposal.changes.map(c=>c.code);
      aria('步骤操作').click();await until(()=>document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='拆分此步').click();
      await until(async()=> (await state()).workspace.proposal.steps.length===3);
      await until(()=>!button('停止')&&document.querySelector('.preview-step-heading').innerText==='初始化位置');
      const after=(await state()).workspace;
      if(JSON.stringify(after.proposal.changes.map(c=>c.code))!==JSON.stringify(terminal))throw Error('Split changed final result');
      if(after.code!==before.code)throw Error('Split changed actual code');
      if(after.proposal.steps[2].step_id!==before.proposal.steps[1].step_id)throw Error('Suffix identity lost');
      return {children:2,terminalUnchanged:true};
    `);
    await run('targeted_revision_stays_at_target', `
      aria('下一步').click();await until(()=>document.querySelector('.preview-step-heading').innerText==='完成原步骤');
      aria('步骤操作').click();await until(()=>document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='修改此步').click();
      await until(()=>aria('修改此步'));button('更新工作区').click();
      await until(()=>!button('停止')&&document.querySelector('.preview-step-heading').innerText==='完成原步骤（调整）');
      return true;
    `);
    await run('failed_target_update_keeps_requirement_draft', `
      aria('步骤操作').click();await until(()=>document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='修改此步').click();
      await until(()=>document.querySelector('#workspace-instruction'));
      const input=document.querySelector('#workspace-instruction');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'核对末尾空值');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      await scene('analysis_only');
      button('更新工作区').click();
      await until(()=>window.auditEvents.some(e=>e.type==='operation_status'&&e.status==='failed'&&e.detail?.includes('版本已改变')));
      aria('步骤操作').click();await until(()=>document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='修改此步').click();
      await until(()=>document.querySelector('#workspace-instruction'));
      if(document.querySelector('#workspace-instruction').value!=='核对末尾空值')throw Error('Failed request lost draft');
      button('取消').click();return true;
    `);
    await run('historical_read_is_local_and_reuse_is_current_basis', `
      const original=(await state()).workspace;
      aria('方案历史').click();await until(()=>aria('本题方案历史'));
      [...document.querySelectorAll('.workspace-version-list button')].find(e=>e.textContent.includes('拆分扫描步骤')).click();
      await until(()=>document.querySelector('.workspace-history-notice'));
      if((await state()).workspace.proposal.proposal_id!==original.proposal.proposal_id)throw Error('Reading changed plan');
      if(!aria('步骤操作').disabled)throw Error('History mutable');
      button('沿用此方案').click();await until(()=>aria('沿用此方案'));button('更新工作区').click();
      await until(async()=> (await state()).workspace.proposal.proposal_id!==original.proposal.proposal_id);
      await until(()=>!button('停止')&&!document.querySelector('.workspace-history-notice'));
      if(!aria('上一步').disabled||!document.querySelectorAll('.preview-code-line.is-added').length)throw Error('Reuse did not open first modification');
      if((await state()).workspace.code!==original.code)throw Error('Reuse overwrote actual');return true;
    `);
    await run('new_plan_starts_with_diff_against_actual_code', `
      aria('下一步').click();await scene('partial_typing');await until(()=>document.querySelector('.plan-notice')?.innerText.includes('代码已变化'));
      const previous=(await state()).workspace.proposal.proposal_id;
      (button('更新代码')||button('更新分析')).click();await until(async()=> (await state()).workspace.proposal.proposal_id!==previous);
      await until(()=>!button('停止')&&tab('code').getAttribute('aria-selected')==='true'&&document.querySelector('.preview-step-heading').innerText==='建立扫描状态');
      const updated=await state();if(updated.workspace.proposal.steps[0].changes[0].base_code!=='cursor = 0')throw Error('Replan ignored observed code');
      if(!document.querySelector('.preview-code').innerText.includes('segments')||!document.querySelectorAll('.preview-code-line.is-added').length)throw Error('First diff missing');
      if(!aria('上一步').disabled)throw Error('Baseline is still a separate page');
      button('已观察代码').click();await until(()=>document.querySelector('.actual-code pre'));
      if(document.querySelector('.actual-code pre').innerText!=='cursor = 0')throw Error('Observed code disclosure not actual');
      button('已观察代码').click();
      return {actualBase:true,firstStep:true};
    `);
    await run('alternative_revises_same_workspace', `
      const before=(await state()).workspace;aria('更多').click();await until(()=>document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='换种解法').click();
      await until(()=>aria('换种解法'));button('更新工作区').click();
      await until(async()=> (await state()).workspace.proposal.summary==='使用哈希表代替遍历');
      await until(()=>!button('停止')&&document.querySelector('.preview-code').innerText.includes('lookup'));
      if(!aria('上一步').disabled)throw Error('Alternative did not open first modification');
      const after=(await state()).workspace;if(after.problem_id!==before.problem_id||after.code!==before.code)throw Error('Alternative reset workspace or actual code');return true;
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
    await run('return_previous_is_separate_from_revision_history', `
      aria('更多').click();await until(()=>document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='回到上一题').click();
      await until(async()=> (await state()).workspace.proposal?.summary==='使用哈希表代替遍历');
      if((await state()).workspace.code!=='cursor = 0')throw Error('Previous problem actual lost');
      await until(()=>tab('code'));tab('code').click();
      return true;
    `);
    await run('persistent_archives_have_separate_readonly_entry', `
      await scene('seed_archive');const before=(await state()).workspace;
      aria('更多').click();await until(()=>document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent==='往场题目').click();
      await until(()=>aria('往场题目记录'));[...document.querySelectorAll('.workspace-version-list button')].find(e=>e.textContent.includes('往场模板解析题')).click();
      await until(()=>document.querySelector('.workspace-history-notice')?.innerText.includes('往场记录'));
      if(button('沿用此方案'))throw Error('Archived interview is writable');
      if((await state()).workspace.problem_id!==before.problem_id)throw Error('Archive read changed current problem');
      aria('方案历史').click();await until(()=>aria('本题方案历史'));
      if(aria('本题方案历史').innerText.includes('往场题目记录'))throw Error('Mixed history scopes');
      aria('关闭历史').click();button('回到当前版').click();return true;
    `);
    win.setSize(844, 390); await new Promise(r=>setTimeout(r,300));
    await run('phone_landscape_keeps_both_panes', `
      const a=document.querySelector('.preview-answer-scroll').getBoundingClientRect(), c=document.querySelector('.preview-code-scroll').getBoundingClientRect();
      if(a.height<50||c.height<50||c.x<a.right-2||document.documentElement.scrollWidth>innerWidth)throw Error('Landscape layout failed '+JSON.stringify({a:a.toJSON(),c:c.toJSON(),width:innerWidth}));
      return {answerHeight:a.height,codeHeight:c.height};
    `);
    fs.writeFileSync(path.join(artifacts,'phone.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(390, 844); await new Promise(r=>setTimeout(r,300));
    await run('portrait_layout_and_same_problem_history', `
      const a=document.querySelector('.preview-answer-scroll').getBoundingClientRect(), c=document.querySelector('.preview-code-scroll').getBoundingClientRect();
      if(a.height<50||c.height<50||c.y<a.bottom-2||document.documentElement.scrollWidth>innerWidth)throw Error('Portrait overflow '+JSON.stringify({a:a.toJSON(),c:c.toJSON()}));
      aria('方案历史').click();await until(()=>aria('本题方案历史'));
      if(!aria('本题方案历史').innerText.includes('使用哈希表代替遍历'))throw Error('Summary missing');
      await new Promise(r=>setTimeout(r,400));
      const dialog=aria('本题方案历史');return {opacity:getComputedStyle(dialog).opacity,background:getComputedStyle(dialog).backgroundColor,rect:dialog.getBoundingClientRect().toJSON()};
    `);
    fs.writeFileSync(path.join(artifacts,'history-portrait.png'),(await win.webContents.capturePage()).toPNG());
    await run('close_history', `aria('关闭历史').click();return true;`);
    win.setSize(844,390); await new Promise(r=>setTimeout(r,300));
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
    console.log('WORKSPACE_UI_FULLSTACK_OK',checks.length);finish();
  } catch(e){ if(win&&!win.isDestroyed())fs.writeFileSync(path.join(artifacts,'failure.png'),(await win.webContents.capturePage()).toPNG());finish(e); }
});
