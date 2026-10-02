// Built React + real FastAPI/WebSocket/Agents tool runner. No OS media or external network.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '../../..');
const artifacts = path.join(root, 'artifacts/chat-only/ui');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'profile'));
app.disableHardwareAcceleration();
let server, win, log = '', errors = [];
const timeout = setTimeout(() => finish(new Error('Chat UI audit timed out')), 90000);
function finish(error) {
  clearTimeout(timeout);
  if (win && !win.isDestroyed()) win.destroy();
  if (server) server.kill();
  fs.writeFileSync(path.join(artifacts, 'server.log'), log);
  if (error) console.error(error.stack || error);
  app.exit(error ? 1 : 0);
}
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
app.whenReady().then(async () => {
  try {
    const base = 'http://127.0.0.1:' + await freePort();
    server = spawn(path.join(root, 'apps/server/.venv/Scripts/python.exe'), [path.join(__dirname, 'chat-audit-server.py')], {
      cwd: path.join(root, 'apps/server'), windowsHide: true, env: { ...process.env, AUDIT_PORT: new URL(base).port }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
    for (let i = 0; i < 180; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    win = new BrowserWindow({ show: false, width: 1240, height: 820, webPreferences: { sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith(base + '/') || d.url.startsWith(base.replace('http', 'ws') + '/') || d.url.startsWith('data:')) }));
    await win.loadURL(base + '/__audit/ui');
    const checks = [];
    async function run(name, code) {
      const result = await win.webContents.executeJavaScript(`(async()=>{
        const until=async f=>{for(let i=0;i<260;i++){if(await f())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timeout: '+f.toString()+' '+JSON.stringify((()=>{const s=document.querySelector('.preview-answer-scroll');return {top:s?.scrollTop,height:s?.scrollHeight,viewport:s?.clientHeight,button:document.querySelector('[aria-label=\"回到最新\"]')?.disabled}})()))};
        const button=t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
        const aria=t=>document.querySelector('[aria-label="'+t+'"]');
        const state=async()=> (await fetch('/__audit/state')).json();
        const type=text=>{const el=aria('消息');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));};
        const idle=()=>until(async()=>!(await state()).busy&&!aria('停止生成'));
        ${code}
      })()`, true);
      checks.push({ name, result }); console.log('PASS', name);
    }
    await run('speech_is_context_not_an_answer', `
      await until(()=>document.querySelector('[role="option"]'));document.querySelector('[role="option"]').click();
      await until(()=>button('开始转录')&&!button('开始转录').disabled&&aria('消息')&&!aria('消息').disabled);
      const provider=document.getElementById('sage-provider');
      if(provider.value!=='responses')throw Error('New chat must default to Responses');
      // The following legacy activity checks exercise the native Codex fixture.
      provider.value='codex';provider.dispatchEvent(new Event('change',{bubbles:true}));
      button('开始转录').click();await until(()=>button('停止转录'));
      button('停止转录').click();await until(()=>button('开始转录')&&!aria('消息').disabled);
      await fetch('/__audit/transcript',{method:'POST'});await until(()=>window.auditEvents.some(e=>e.type==='transcript_final'));
      if((await state()).requests||document.querySelector('.sage-chat-turn'))throw Error('Speech auto-answered');
      return true;
    `);
    await run('ime_and_empty_enter_do_not_send', `
      const el=aria('消息');el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      type('中文输入');el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));
      await new Promise(r=>setTimeout(r,100));
      if((await state()).requests||document.querySelector('.sage-chat-turn'))throw Error('IME/empty Enter submitted');
      if(el.value!=='中文输入')throw Error('IME confirmation cleared draft');return true;
    `);
    await run('unaccepted_send_keeps_draft_after_reconnect', `
      const original=WebSocket.prototype.send;let dropped=false;
      WebSocket.prototype.send=function(data){let p;try{p=JSON.parse(data)}catch{};
        if(p?.type==='chat_send'&&!dropped){dropped=true;this.close();return;}return original.call(this,data);};
      const count=window.auditEvents.filter(e=>e.type==='operation_snapshot').length;
      type('网络断开前的草稿');await until(()=>!aria('发送消息').disabled);aria('发送消息').click();
      await until(()=>window.auditEvents.filter(e=>e.type==='operation_snapshot').length>count);
      WebSocket.prototype.send=original;
      await until(()=>!aria('发送消息').disabled);
      if(!dropped||aria('消息').value!=='网络断开前的草稿')throw Error('Unaccepted draft lost or composer locked');
      if((await state()).requests)throw Error('Unexpected automatic retry');return true;
    `);
    await run('message_attachments_and_readable_answer', `
      aria('截图').click();await until(()=>aria('移除截图 1'));if((await state()).requests)throw Error('Capture ran model');
      type('先分析一下思路');await until(()=>!aria('发送消息').disabled);aria('发送消息').click();
      await until(()=>document.querySelector('.sage-assistant-message')?.innerText.includes('先明确需求'));await idle();
      if(aria('消息').value)throw Error('Accepted draft not cleared');
      if(aria('移除截图 1'))throw Error('Sent attachment stayed in composer');
      if(!document.querySelector('.sage-chat-turn img'))throw Error('Message lost image');
      if(!(await state()).messages[0].screens.length)throw Error('Image was not sent');
      if(document.querySelector('.preview-analysis-scroll'))throw Error('Legacy analysis pane remains');return true;
    `);
    await run('implementation_is_explained_and_rendered_in_chat', `
      type('请实现这个函数，解释关键逻辑');await until(()=>aria('发送消息'));aria('发送消息').click();
      await until(()=>document.querySelector('.sage-chat-turn:last-of-type pre')?.innerText.includes('total'));await idle();
      const s=await state();if(s.workspace.current)throw Error('Implementation created a code workspace');
      if(aria('代码区')||aria('代码历史')||document.querySelector('.preview-workspace'))throw Error('Code panel remains');
      const answer=document.querySelector('.sage-chat-turn:last-of-type');
      if(!answer.innerText.includes('O(n)')||!answer.innerText.includes('复制代码'))throw Error('Explanation or code copy missing');
      return {messages:s.messages.length,requests:s.requests};
    `);
    await run('native_activity_is_collapsed_and_readable', `
      const activity=[...document.querySelectorAll('.sage-chat-activity')].at(-1);
      const trigger=activity?.querySelector('button');
      if(!trigger||trigger.getAttribute('aria-expanded')!=='false')throw Error('Activity must start collapsed');
      trigger.click();await until(()=>activity.innerText.includes('读取 coding.md'));
      if(activity.querySelectorAll('li').length!==1||!activity.innerText.includes('已完成'))throw Error('Activity duplicated or status lost');
      trigger.click();return true;
    `);
    await run('responses_entry_preserves_profile_and_followup', `
      const select=(id,value)=>{const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));};
      if ([...document.getElementById('sage-profile').options].map(o=>o.value).join(',') !== 'default,brief,ood')throw Error('Duplicate profile remains');
      select('sage-provider','responses');select('sage-profile','default');
      await new Promise(r=>setTimeout(r,60));
      type('实现 LC 示例');await until(()=>aria('发送消息'));aria('发送消息').click();await idle();
      await until(()=>document.querySelector('.sage-chat-turn:last-of-type pre'));
      const sent=(await state()).messages.at(-1);
      if(sent.provider!=='responses'||sent.profile!=='default'||!document.querySelector('.sage-answer-origin'))throw Error('API selection not sent/displayed');
      type('解释 OOD 对象职责');select('sage-profile','ood');await new Promise(r=>setTimeout(r,60));
      aria('发送消息').click();await idle();
      if((await state()).messages.at(-1).profile!=='ood')throw Error('OOD profile not selected');
      const count=window.auditEvents.filter(e=>e.type==='session_ready').length;
      window.auditSockets.filter(s=>s.readyState===1).forEach(s=>s.close());
      await until(()=>window.auditEvents.filter(e=>e.type==='session_ready').length>count&&!aria('消息').disabled);
      if(document.getElementById('sage-provider').value!=='responses'||document.getElementById('sage-profile').value!=='ood')throw Error('Choices lost on reconnect');
      return true;
    `);
    await run('legacy_lc_history_restores_as_general', `
      const identity=crypto.randomUUID();
      window.auditSockets.find(s=>s.readyState===1).send(JSON.stringify({type:'chat_send',operation_id:identity,
        conversation_id:(await state()).conversation_id,action:'send',text:'旧客户端的代码题',provider:'responses',profile:'lc',request_ids:[]}));
      await until(async()=>(await state()).messages.at(-1)?.message_id===identity);await idle();
      const count=window.auditEvents.filter(e=>e.type==='session_ready').length;
      window.auditSockets.filter(s=>s.readyState===1).forEach(s=>s.close());
      await until(()=>window.auditEvents.filter(e=>e.type==='session_ready').length>count&&!aria('消息').disabled);
      if(document.getElementById('sage-profile').value!=='default')throw Error('Legacy LC did not normalize to General');
      if([...document.querySelectorAll('.sage-answer-origin')].at(-1).textContent.trim()!=='Responses API · 通用')throw Error('Legacy LC label remains');
      type('继续解释');await until(()=>!aria('发送消息').disabled);aria('发送消息').click();await idle();
      if((await state()).messages.at(-1).profile!=='default')throw Error('Followup sent retired profile');
      return true;
    `);
    await run('chatgpt_setup_is_available_in_more', `
      aria('更多').click();await until(()=>document.querySelector('[role="menu"]'));
      [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('连接 ChatGPT')).click();
      await until(()=>aria('复制插件地址')&&aria('复制本场开场语'));
      await until(()=>document.querySelector('[role="dialog"][aria-label="连接 ChatGPT"]')?.textContent.includes('/mcp'));
      aria('关闭 ChatGPT 设置').click();await until(()=>!document.querySelector('[role="dialog"]'));
      for(const [id,value] of [['sage-provider','codex'],['sage-profile','default']]){const e=document.getElementById(id);e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}));}
      await new Promise(r=>setTimeout(r,80));return true;
    `);
    await new Promise(r=>setTimeout(r,400));
    fs.writeFileSync(path.join(artifacts, 'desktop.png'), (await win.webContents.capturePage()).toPNG());
    await run('stop_preserves_draft_for_next_message', `
      button('开始转录').click();await until(()=>button('停止转录'));
      type('慢回答');await until(()=>!aria('发送消息').disabled);aria('发送消息').click();await until(()=>aria('停止生成'));
      button('停止转录').click();await until(()=>button('开始转录'));
      if(!(await state()).busy||!aria('停止生成'))throw Error('Stopping transcription cancelled chat');
      type('下一条还没发');aria('停止生成').click();await idle();
      if(aria('消息').value!=='下一条还没发')throw Error('Next draft lost');
      if(!document.querySelector('.sage-chat-turn:last-of-type')?.innerText.includes('已停止'))throw Error('Stopped request is invisible');
      return true;
    `);
    await run('reconnect_restores_chat_attachments_and_inline_code', `
      const count=window.auditEvents.filter(e=>e.type==='session_ready').length;
      window.auditSockets.filter(s=>s.readyState===1).forEach(s=>s.close());
      await until(()=>window.auditEvents.filter(e=>e.type==='session_ready').length>count);await until(()=>!aria('消息').disabled);
      if(document.querySelectorAll('.sage-chat-turn').length!==(await state()).messages.length||!document.querySelector('.sage-chat-turn img'))throw Error('Chat snapshot lost');
      if(aria('消息').value!=='下一条还没发')throw Error('Reconnect lost draft');
      if(![...document.querySelectorAll('.sage-chat-turn pre')].some(e=>e.innerText.includes('total')))throw Error('Inline code lost');return true;
    `);
    await run('long_answer_preserves_reading_position', `
      type('长回答');aria('发送消息').click();
      const scroll=document.querySelector('.preview-answer-scroll');
      await until(()=>scroll.innerText.includes('观察 5'));
      await new Promise(r=>setTimeout(r,100));
      if(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop>4)throw Error('Streaming did not follow');
      scroll.scrollTop=100;await until(()=>!aria('回到最新').disabled);
      const before=scroll.scrollHeight;
      await fetch('/__audit/transcript',{method:'POST'});await new Promise(r=>setTimeout(r,600));
      if(scroll.scrollHeight<=before||!(await state()).busy)throw Error('Test did not stream during reading');
      if(Math.abs(scroll.scrollTop-100)>2)throw Error('Streaming/transcript moved reading position');
      aria('回到最新').click();await until(()=>aria('回到最新').disabled);
      await new Promise(r=>setTimeout(r,300));
      if(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop>4)throw Error('Button did not resume following');
      await idle();return true;
    `);
    await run('manual_bottom_and_content_resize_resume_following', `
      const scroll=document.querySelector('.preview-answer-scroll');
      scroll.scrollTop=100;await until(()=>!aria('回到最新').disabled);
      scroll.scrollTop=scroll.scrollHeight;await until(()=>aria('回到最新').disabled);
      const block=document.createElement('div');block.style.height='240px';
      document.querySelector('.preview-answer-content').append(block);
      await until(()=>scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop<=4);
      block.style.height='480px';await new Promise(r=>setTimeout(r,100));
      if(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop>4)throw Error('Late content resize lost bottom');
      block.remove();await new Promise(r=>setTimeout(r,150));return true;
    `);
    await run('reconnect_does_not_remount_scrolled_conversation', `
      const scroll=document.querySelector('.preview-answer-scroll');scroll.scrollTop=100;
      await until(()=>!aria('回到最新').disabled);
      const count=window.auditEvents.filter(e=>e.type==='session_ready').length;
      window.auditSockets.filter(s=>s.readyState===1).forEach(s=>s.close());
      await until(()=>window.auditEvents.filter(e=>e.type==='session_ready').length>count);
      await until(()=>!aria('消息').disabled);
      if(scroll!==document.querySelector('.preview-answer-scroll')||Math.abs(scroll.scrollTop-100)>2)throw Error('Reconnect lost reading position');
      aria('回到最新').click();await until(()=>aria('回到最新').disabled);return true;
    `);
    await run('code_examples_and_topic_changes_remain_in_chat', `
      const before=JSON.stringify((await state()).workspace.current);
      type('下一题，给一个代码示例');aria('发送消息').click();await until(()=>document.querySelector('.sage-chat-turn:last-of-type pre'));await idle();
      if(JSON.stringify((await state()).workspace.current)!==before)throw Error('Chat changed legacy code');
      aria('更多').click();await until(()=>document.querySelector('[role="menu"]'));
      if([...document.querySelectorAll('[role="menuitem"]')].some(e=>/换题|上一题/.test(e.textContent)))throw Error('Topic state remains');
      return true;
    `);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await run('code_followup_updates_chat_and_preserves_earlier_answer', `
      await until(()=>!document.querySelector('[role="menu"]'));
      const count=document.querySelectorAll('.sage-chat-turn pre').length;
      type('修改代码，用sum简化');await until(()=>aria('发送消息'));aria('发送消息').click();
      await until(()=>document.querySelector('.sage-chat-turn:last-of-type pre')?.innerText.includes('sum'));await idle();
      if(document.querySelectorAll('.sage-chat-turn pre').length!==count+1)throw Error('Previous code changed');
      if((await state()).workspace.current||aria('代码区'))throw Error('Followup reopened code workspace');return true;
    `);
    await run('empty_answer_button_uses_context_without_a_second_action', `
      const old=(await state()).requests;type('');await until(()=>aria('回答'));
      if(aria('更新代码区'))throw Error('Legacy action still present');
      aria('回答').click();await until(async()=> (await state()).requests===old+1);await idle();return true;
    `);
    await run('new_topic_answers_inline_without_erasing_history', `
      type('实现另一题');await until(()=>aria('发送消息'));aria('发送消息').click();await idle();
      await until(()=>document.querySelector('.sage-chat-turn:last-of-type pre')?.innerText.includes('return 42'));
      if(![...document.querySelectorAll('.sage-chat-turn pre')].some(e=>e.innerText.includes('total')))throw Error('Previous topic erased');
      if((await state()).workspace.current||aria('代码区'))throw Error('New topic created workspace');return true;
    `);
    await new Promise(r=>setTimeout(r,400));
    fs.writeFileSync(path.join(artifacts, 'desktop.png'), (await win.webContents.capturePage()).toPNG());
    win.setSize(430, 900);await new Promise(r=>setTimeout(r,180));
    await run('portrait_composer_fits', `
      const bounds=aria('消息').getBoundingClientRect();
      if(bounds.left<0||bounds.right>innerWidth+1||bounds.bottom>innerHeight)throw Error('Composer outside screen');
      if(document.documentElement.scrollWidth>innerWidth+1)throw Error('Page horizontal overflow');return true;
    `);
    fs.writeFileSync(path.join(artifacts, 'portrait.png'), (await win.webContents.capturePage()).toPNG());
    if(errors.length)throw Error(errors.join('\n'));
    fs.writeFileSync(path.join(artifacts,'checks.json'),JSON.stringify(checks,null,2));finish();
  } catch(error) { if(win&&!win.isDestroyed())fs.writeFileSync(path.join(artifacts,'failure.png'),(await win.webContents.capturePage()).toPNG());finish(error); }
});
