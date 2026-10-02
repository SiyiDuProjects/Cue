// Real Electron React UI -> localhost FastAPI and runtime; only provider/capture data is deterministic.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '../../..');
const artifacts = path.join(root, 'artifacts/interview-audit-2026-09-26');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'electron-profile'));
app.disableHardwareAcceleration();
let child, window, stderr = '';
const timeout = setTimeout(() => finish(new Error('INTERVIEW_AUDIT_TIMEOUT')), 60000);
function finish(error) {
  clearTimeout(timeout);
  if (window && !window.isDestroyed()) window.destroy();
  if (child) child.kill();
  if (stderr) fs.writeFileSync(path.join(artifacts, 'fixture-server.log'), stderr);
  if (error) console.error(error);
  app.exit(error ? 1 : 0);
}
async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
app.whenReady().then(async () => {
  try {
    const port = await availablePort(), base = 'http://127.0.0.1:' + port;
    const python = path.join(root, 'apps/server/.venv/Scripts/python.exe');
    child = spawn(python, [path.join(__dirname, 'interview-audit-server.py')], {
      cwd: path.join(root, 'apps/server'), env: { ...process.env, AUDIT_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    child.stdout.on('data', bytes => { stderr += bytes.toString(); });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
      if (child.exitCode !== null) throw new Error('Fixture startup failed: ' + stderr);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!ready) throw new Error('Fixture did not start: ' + stderr);
    window = new BrowserWindow({ show: false, width: 1060, height: 800,
      webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
    window.webContents.setAudioMuted(true);
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel:
      !(details.url.startsWith(base + '/') || details.url.startsWith('ws://127.0.0.1:' + port + '/')) }));
    await window.loadURL(base + '/__audit/ui');
    const checkpoints = [];
    const run = async (name, code, screenshot) => {
      const result = await window.webContents.executeJavaScript(`(async () => {
        const find = text => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === text);
        const until = async predicate => { for (let i=0;i<220;i++) { if(predicate())return; await new Promise(resolve=>setTimeout(resolve,25)); } throw new Error('Timeout: '+document.body.innerText); };
        const more = async text => {
          document.querySelector('.more-button').click();
          const item = () => [...document.querySelectorAll('[role="menuitem"]')].find(element => element.textContent.trim() === text);
          await until(() => item());
          if(item().getAttribute('aria-disabled') === 'true')throw new Error('Disabled menu action: '+text);
          item().click();
          await until(() => !document.querySelector('[role="menu"]'));
        };
        const scene = async name => { const response = await fetch('/__audit/scene',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scene:name})}); if(!response.ok)throw new Error(name+': '+await response.text()); return response.json(); };
        const state = async () => (await fetch('/__audit/state')).json();
        const setInput = (selector, value) => { const element=document.querySelector(selector); const proto=element instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true})); };
        ${code}
      })()`, true);
      checkpoints.push({ name, ...result });
      if (screenshot) {
        await new Promise(resolve => setTimeout(resolve, 100));
        fs.writeFileSync(path.join(artifacts, screenshot), (await window.webContents.capturePage()).toPNG());
      }
      console.log('PASS', name);
    };
    await run('start_and_clarify', `
      await until(()=>find('开始面试')&&!find('开始面试').disabled);
      if(Object.keys((await state()).provider_connections).length)throw new Error('Provider connected before Start');
      find('开始面试').click(); await until(()=>document.querySelector('.stop-button'));
      await scene('clarify'); await until(()=>document.body.innerText.includes('未知参数如何处理'));
      if(document.body.innerText.includes('模型连接已恢复'))throw new Error('Initial model startup falsely shown as recovery');
      if(!window.auditEvents.some(event=>event.type==='model_status'&&event.status==='connecting'))throw new Error('Initial connecting state missing');
      if(!document.querySelector('#code-workspace').hidden)throw new Error('Clarification opened code without a patch');
      await scene('same_question_more'); await until(()=>document.querySelectorAll('.answer-stage .answer-segment').length===2);
      const stage=document.querySelector('.answer-stage');
      if(!stage.innerText.includes('未知参数如何处理')||!stage.innerText.includes('是否区分大小写'))throw new Error('Clarification continuation replaced earlier text');
      if(stage.querySelector('.answer-question')||find('上一条')||document.querySelector('.reading-navigation')?.textContent.includes('问题 '))throw new Error('Question paging leaked into continuous feed');
      return { realStartControl:true, initialConnectionHonest:true, noPrematureCode:true, continuousClarification:true, noQuestionPaging:true };
    `, '01-clarification.png');
    await run('two_audio_sources_transcript_status', `
      const count=(await state()).answers.length;
      await scene('candidate_partial'); await more('实时转写');
      await until(()=>document.body.innerText.includes('识别中')&&document.body.innerText.includes('我先确认未知'));
      await scene('candidate_final');
      await until(()=>document.body.innerText.includes('暂时不支持嵌套引用'));
      if((await state()).answers.length!==count)throw new Error('Candidate context triggered an answer');
      const turns=(await state()).turns;
      if(!turns.some(turn=>turn.speaker==='interviewer')||!turns.some(turn=>turn.speaker==='candidate'&&turn.status==='completed'))throw new Error('Speaker/status lost');
      const close=document.querySelector('[aria-label="Close"]')||document.querySelector('[aria-label="关闭"]');
      if(close)close.click();else document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      await until(()=>!document.querySelector('[role="dialog"]'));
      return { candidateNoAnswer:true, distinctSpeakers:true, partialThenFinal:true };
    `);
    await run('step_patch_partial_typing_and_renaming', `
      await scene('new_question');await until(()=>document.querySelectorAll('.code-proposal-file').length===1&&!document.querySelector('#code-workspace').hidden);
      let snapshot=await state();if(snapshot.workspace.code!=='')throw new Error('Proposal became actual code');
      await until(()=>document.querySelectorAll('.answer-stage .answer-segment').length===3);
      if(!document.querySelector('.answer-stage').innerText.includes('未知参数如何处理')||!document.querySelector('.answer-stage').innerText.includes('扫描位置和输出列表'))throw new Error('Next question replaced earlier live contents');
      await scene('partial_typing');await until(()=>document.body.innerText.includes('旧建议需重新核对'));
      snapshot=await state();if(snapshot.workspace.code!=='cursor = 0'||snapshot.workspace.completeness!=='partial')throw new Error('Partial observed state wrong');
      await scene('renamed_next');await until(()=>document.querySelector('.code-proposal').textContent.includes('segments'));
      await until(()=>document.querySelectorAll('.answer-stage .answer-segment').length===4&&document.querySelector('.answer-stage').innerText.includes('cursor'));
      if(!document.querySelector('.answer-stage').innerText.includes('未知参数如何处理'))throw new Error('Code followup removed earlier live contents');
      snapshot=await state();if(snapshot.workspace.proposal.base_code!=='cursor = 0'||snapshot.workspace.code.includes('segments'))throw new Error('Next step ignored actual renamed base');
      return { proposalNotActual:true, partialCodeObserved:true, renamedBaseRespected:true, earlierTopicsRetained:true, crossQuestionAppend:true };
    `, '02-stepwise-actual-base.png');
    await run('multi_file_partial_completion_from_observation', `
      await scene('multifile');await until(()=>document.querySelectorAll('.code-file-tabs button').length===2);
      let snapshot=await state();if(snapshot.workspace.files.length!==1)throw new Error('Proposed new file became actual');
      const selectCount=window.auditControls.filter(event=>event.action==='select_file').length;
      find('policy.py · 新文件').click();
      await until(()=>document.querySelector('.code-proposal-file h3')?.textContent.includes('policy.py'));
      if(document.querySelectorAll('.code-proposal-file').length!==1)throw new Error('Unselected patches should remain behind file tabs');
      if(window.auditControls.filter(event=>event.action==='select_file').length!==selectCount)throw new Error('Proposed-only file wrote actual selection');
      await scene('secondfile_actual');await until(()=>find('policy.py'));
      document.querySelector('.code-reference').open=true;find('policy.py').click();
      await until(()=>document.querySelector('.code-actual')?.textContent.includes('def missing_key'));
      await until(()=>window.auditEvents.some(event=>event.type==='code_state'&&event.workspace.document_id===snapshot.workspace.proposal.changes.find(file=>file.filename==='policy.py').document_id));
      find('main.py').click();await until(()=>document.querySelector('.code-actual')?.textContent==='cursor = 0');
      await until(()=>window.auditEvents.filter(event=>event.type==='code_state').at(-1)?.workspace.filename==='main.py');
      await scene('partial_progress');await until(()=>document.querySelector('.code-actual')?.textContent==='cursor = 1');
      snapshot=await state();if(snapshot.workspace.code!=='cursor = 1'||snapshot.workspace.completeness!=='partial')throw new Error('Partial observation became whole file');
      await scene('complete_file_observed');await until(()=>document.querySelector('.code-actual')?.textContent==='cursor = 1\\nsegments = []');
      if(document.querySelector('.code-panel textarea,.code-panel input')||find('保存实际代码'))throw new Error('Readonly code panel exposed edit/save controls');
      snapshot=await state();const expectedRevision=snapshot.workspace.revision;
      find('下一步').click();await until(()=>document.querySelector('.answer-stage').innerText.includes('已结合当前实际代码'));
      snapshot=await state();if(snapshot.workspace.completeness!=='complete')throw new Error('Full-file screenshot observation not recorded');
      if(window.auditControls.filter(event=>event.action==='generate').at(-1)?.base_revision!==expectedRevision)throw new Error('Next ignored observed revision');
      document.querySelector('.code-reference').open=false;document.querySelector('.code-region').scrollTop=0;
      return { realFileSelection:true, oneSelectedPatch:true, proposalOnlyUntilObserved:true, partialObservationPreserved:true, fullFileObservation:true, noEditor:true, nextHostedRequest:true, nextUsesObservedRevision:true };
    `, '03-multifile.png');
    await run('reconnect_snapshot_keeps_actual_code_and_proposal', `
      document.querySelector('.code-reference').open=true;
      const before=await state(), expectedAnswers=before.answers.map(answer=>answer.text);
      const expectedCode=document.querySelector('.code-actual').textContent;
      const readyCount=window.auditEvents.filter(event=>event.type==='session_ready').length;
      await scene('reconnect');
      await until(()=>window.auditEvents.filter(event=>event.type==='session_ready').length>readyCount&&window.auditEvents.filter(event=>event.type==='answer_snapshot_done').length>1);
      await until(()=>document.querySelector('.code-actual')?.textContent===expectedCode);
      const after=await state();if(JSON.stringify(after.answers.map(answer=>answer.text))!==JSON.stringify(expectedAnswers))throw new Error('Reconnect lost/replaced completed answers');
      await until(()=>document.querySelectorAll('.answer-stage .answer-segment').length===after.answers.filter(answer=>!answer.intermediate).length);
      if(!document.querySelector('.answer-stage').innerText.includes('未知参数如何处理')||!document.querySelector('.answer-stage').innerText.includes('已结合当前实际代码'))throw new Error('Reconnect did not restore continuous live contents');
      if(after.workspace.proposal.proposal_id!==before.workspace.proposal.proposal_id)throw new Error('Reconnect lost proposal');
      if(JSON.stringify(after.workspace.files)!==JSON.stringify(before.workspace.files))throw new Error('Reconnect changed observed files');
      if(after.workspace.code!==expectedCode)throw new Error('UI actual code did not match authoritative runtime');
      document.querySelector('.code-reference').open=false;
      return { realSocketReconnect:true, allAnswersRestored:true, continuousFeedRestored:true, workspaceProposalRestored:true, observedFilesRetained:true, readonlyActualPreserved:true };
    `);
    await run('real_ui_controls_rewrite_correction_capture_and_follow', `
      const initialAnswers=(await state()).answers.length;
      for(const label of ['先给一句','展开说明','换个说法','深入分析']) {
        await more(label);
        await until(()=>{const control=window.auditControls.filter(event=>event.type==='quick_answer').at(-1);return control&&window.auditEvents.some(event=>event.type==='operation_status'&&event.operation_id===control.operation_id&&event.status==='completed');});
      }
      if((await state()).answers.length!==initialAnswers+4)throw new Error('Rewrite controls failed to append one answer each');
      await more('纠正与补充');await until(()=>document.querySelector('#manual-question'));
      setInput('#manual-question','Implement a formatter; unknown parameters remain unchanged.');find('提交').click();
      await until(()=>!document.querySelector('[role="dialog"]'));
      await until(()=>{const control=window.auditControls.filter(event=>event.type==='manual_text').at(-1);return control&&window.auditEvents.some(event=>event.type==='operation_status'&&event.operation_id===control.operation_id&&event.status==='completed');});
      if(!(await state()).questions.some(question=>question.text.includes('unknown parameters remain unchanged')))throw new Error('Correction not in question state');
      find('截图').click();await until(()=>find('回答题目'));
      find('回答题目').click();await until(()=>{const control=window.auditControls.filter(event=>event.type==='answer_screens').at(-1);return control&&window.auditEvents.some(event=>event.type==='operation_status'&&event.operation_id===control.operation_id&&event.status==='completed');});
      document.querySelector('.code-options').open=true;
      find('跟随代码窗口').click();await until(()=>find('跟随代码窗口').getAttribute('aria-pressed')==='true');
      await more('暂停自动回答');await until(()=>document.querySelector('.more-button').textContent.includes('已暂停')&&find('跟随代码窗口').getAttribute('aria-pressed')==='false');
      await more('继续回答');await until(()=>!document.querySelector('.more-button').textContent.includes('已暂停'));
      document.querySelector('.code-options').open=false;
      await until(()=>{const pending=window.auditEvents.filter(event=>event.type==='operation_status');return pending.filter(event=>event.status==='running').every(event=>pending.some(done=>done.operation_id===event.operation_id&&['completed','cancelled','failed'].includes(done.status)));});
      return { fourRewriteControls:true, correctionRoundTrip:true, screenshotCollectionAndAnswer:true, followToggleRealRoute:true, pauseStopsFollow:true, resumeAnswer:true };
    `);
    await run('new_problem_rejects_late_old_results_and_resume_round', `
      await scene('pending_old');await until(()=>document.querySelector('.answer-stage').innerText.includes('正在分析上一题'));
      document.querySelector('.code-options').open=true;
      find('换一道题').click();await until(()=>find('开始新题'));find('开始新题').click();
      await until(()=>!document.querySelector('.code-proposal-file'));
      const result=await scene('late_old');if(!result.late_code_blocked||!result.late_text_blocked)throw new Error('Old task leaked into new problem');
      await scene('resume_round');await until(()=>document.querySelector('.answer-stage').innerText.includes('不要补造项目数据'));
      const snapshot=await state();if(snapshot.workspace.code!==''||snapshot.workspace.proposal)throw new Error('Old code entered resume discussion');
      if(!document.querySelector('.answer-stage').innerText.includes('未知参数如何处理'))throw new Error('Resume discussion replaced previous topic contents');
      if(document.querySelector('.answer-stage .answer-question')||find('上一条'))throw new Error('Resume transition introduced question pages');
      if(snapshot.answers.some(answer=>answer.text.includes('SHOULD_NOT_APPEAR')))throw new Error('Late text in history');
      if(snapshot.answers.some(answer=>answer.status==='streaming'))throw new Error('Prior problem left a permanently streaming answer');
      await until(()=>!document.querySelector('.status-button').innerText.includes('回答中'));
      return { explicitProblemReset:true, lateOldCodeRejected:true, lateOldTextRejected:true, oldStreamingClosed:true, resumeTextOnly:true, continuousTopics:true, retainedPreviousAnswers:snapshot.answers.length };
    `, '04-resume-after-code.png');
    await window.setSize(390, 800);await new Promise(resolve=>setTimeout(resolve,100));
    const narrow=await window.webContents.executeJavaScript(`(async()=>{
      if(document.querySelector('.app-shell').classList.contains('has-code'))document.querySelector('.mobile-code-label').closest('button').click();
      await new Promise(resolve=>setTimeout(resolve,50));
      return {horizontalOverflow:document.documentElement.scrollWidth>innerWidth,answerVisible:document.querySelector('.answer-stage').clientHeight>0,
        codeHidden:document.querySelector('#code-workspace').hidden,primaryActions:document.querySelectorAll('.primary-actions button').length};
    })()`);
    fs.writeFileSync(path.join(artifacts,'05-narrow.png'),(await window.webContents.capturePage()).toPNG());
    if(narrow.horizontalOverflow||!narrow.answerVisible||!narrow.codeHidden||narrow.primaryActions!==3)throw new Error('Narrow view failed: '+JSON.stringify(narrow));
    const result={ layers:{real:['Electron React UI','HTTP current-session bootstrap','authenticated client WebSocket','FastAPI registry/runtime','Live public-text event handling','Candidate transcript relay','code tool handlers','manual operations','disconnect snapshot restore'], synthetic:['audio capture host','provider output and decisions','external-editor screenshots']}, checkpoints,narrow };
    fs.writeFileSync(path.join(artifacts,'ui-fullstack-report.json'),JSON.stringify(result,null,2));
    console.log('INTERVIEW_UI_FULLSTACK_OK',JSON.stringify({checkpoints:checkpoints.length,narrow}));
    finish();
  } catch(error){finish(error);}
});
