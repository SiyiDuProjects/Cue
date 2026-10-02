// Built React + real FastAPI/WebSocket/Codex tool runner. No OS media or external network.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { DESKTOP_WINDOW_OPTIONS } = require('../electron/desktop-window.cjs');
const root = path.resolve(__dirname, '../../..');
const artifacts = path.join(root, 'artifacts/chat-controls/ui');
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
    const python = path.join(root, 'apps/server/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    server = spawn(python, [path.join(__dirname, 'chat-audit-server.py')], {
      cwd: path.join(root, 'apps/server'), windowsHide: true, env: { ...process.env, AUDIT_PORT: new URL(base).port }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.on('error', finish);
    server.stdout.on('data', b => log += b); server.stderr.on('data', b => log += b);
    for (let i = 0; i < 180; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
    win = new BrowserWindow({ ...DESKTOP_WINDOW_OPTIONS, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    win.webContents.setAudioMuted(true);
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message); });
    win.webContents.session.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(d.url.startsWith(base + '/') || d.url.startsWith(base.replace('http', 'ws') + '/') || d.url.startsWith('data:')) }));
    await win.loadURL(base + '/__audit/ui?desktop=1');
    const checks = [];
    const frame = win.getBounds(), content = win.getContentBounds();
    if (!win.isResizable() || !win.isMinimizable() || !win.isMaximizable() || win.isAlwaysOnTop()
        || content.height >= frame.height) throw Error('Missing native title bar or normal window controls');
    checks.push({ name: 'native_window_frame_and_controls', result: { frame, content } });
    async function run(name, code) {
      const result = await win.webContents.executeJavaScript(`(async()=>{
        const until=async f=>{for(let i=0;i<260;i++){if(await f())return;await new Promise(r=>setTimeout(r,25));}throw Error('Timeout: '+f.toString()+' '+JSON.stringify({buttons:[...document.querySelectorAll('button')].filter(b=>b.textContent.includes('新对话')).map(b=>b.outerHTML),dialogs:[...document.querySelectorAll('[role=dialog]')].map(x=>x.getAttribute('aria-label')),error:[...document.querySelectorAll('[role=alert]')].map(x=>x.textContent)})+' '+JSON.stringify((()=>{const s=document.querySelector('.preview-answer-scroll');return {top:s?.scrollTop,height:s?.scrollHeight,viewport:s?.clientHeight,button:document.querySelector('[aria-label=\"回到最新\"]')?.disabled}})()))};
        const button=t=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===t);
        const aria=t=>document.querySelector('[aria-label="'+t+'"]');
        const state=async()=> (await fetch('/__audit/state')).json();
        const type=text=>{const el=aria('消息');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,text);el.dispatchEvent(new Event('input',{bubbles:true}));};
        const idle=()=>until(async()=>!(await state()).busy&&!aria('停止生成'));
        ${code}
      })()`, true);
      checks.push({ name, result }); console.log('PASS', name);
    }
    await run('desktop_initial_connection_has_one_conversation', `
      await until(()=>aria('消息')&&!aria('消息').disabled&&window.auditEvents.some(e=>e.type==='session_ready'));
      await new Promise(r=>setTimeout(r,250));
      const counts={scrolls:document.querySelectorAll('.preview-answer-scroll').length,empty:document.querySelectorAll('.sage-chat-empty').length,composers:document.querySelectorAll('.sage-composer').length};
      if(Object.values(counts).some(n=>n!==1))throw Error('Duplicate desktop startup: '+JSON.stringify(counts));
      if((await state()).requests)throw Error('Startup ran model');return counts;
    `);
    fs.writeFileSync(path.join(artifacts,'initial.png'),(await win.webContents.capturePage()).toPNG());
    await run('secondary_mode_menu_does_not_start_audio', `
      if(button('普通聊天')||button('模拟面试 · 带提示'))throw Error('Low-frequency mode controls still take up chat space');
      const item=text=>[...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes(text));
      aria('更多').click();await until(()=>item('切换到模拟面试'));item('切换到模拟面试').click();
      await until(()=>button('开始模拟'));
      if((await state()).requests||window.auditControls.some(c=>c.type==='start_transcription'))throw Error('Selecting mode started work');
      aria('更多').click();await until(()=>item('切回普通聊天'));item('切回普通聊天').click();
      await until(()=>button('开始转录'));return true;
    `);
    await run('chat_only_has_no_workspace_controls', `
      if(aria('代码区')||aria('代码历史')||document.querySelector('.preview-workspace'))throw Error('Workspace controls remain');
      const socket=window.auditSockets.find(s=>s.readyState===1);
      socket.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'code_state',workspace:{revision:1,run_id:'old',reveal_id:'legacy',current:{id:'old',files:[]}}})}));
      await new Promise(r=>setTimeout(r,50));
      if(aria('代码区')||aria('停止生成')||aria('回答').disabled)throw Error('Old code state affected chat');return true;
    `);
    await run('desktop_reconnect_keeps_one_conversation', `
      const old=document.querySelector('.preview-answer-scroll');
      const count=window.auditEvents.filter(e=>e.type==='session_ready').length;
      window.auditSockets.filter(s=>s.readyState===1).forEach(s=>s.close());
      await until(()=>window.auditEvents.filter(e=>e.type==='session_ready').length>count&&!aria('消息').disabled);
      if(document.querySelectorAll('.preview-answer-scroll').length!==1||old!==document.querySelector('.preview-answer-scroll'))throw Error('Reconnect duplicated/remounted chat');return true;
    `);
    await run('desktop_send_and_new_conversations_do_not_leave_orphan_panels', `
      for(let i=0;i<2;i++){
        type('普通回答 '+i);await until(()=>!aria('发送消息').disabled);aria('发送消息').click();await idle();
        await until(()=>document.querySelector('.sage-assistant-message'));
        if(document.querySelector('.sage-chat-empty'))throw Error('Empty state survived first reply');
        aria('更多').click();await until(()=>document.querySelector('[role="menu"]'));
        [...document.querySelectorAll('[role="menuitem"]')].find(e=>e.textContent.includes('新对话')).click();
        await until(()=>!document.querySelector('[role="alertdialog"]')&&!aria('消息').disabled&&!document.querySelector('.sage-chat-turn'));
        if(document.querySelectorAll('.preview-answer-scroll').length!==1||document.querySelectorAll('.sage-chat-empty').length!==1||document.querySelectorAll('.sage-composer').length!==1)throw Error('New conversation left orphan nodes');
      }
      return true;
    `);
    await run('history_switch_restores_messages_and_rename_without_model_work', `
      const requests=(await state()).requests;
      aria('打开会话列表').click();await until(()=>aria('历史会话'));
      await until(()=>[...document.querySelectorAll('[role="row"]')].some(r=>r.textContent.includes('普通回答 0')));
      [...document.querySelectorAll('[role="row"]')].find(r=>r.textContent.includes('普通回答 0')).click();
      await until(()=>!aria('会话列表')&&!aria('消息').disabled&&document.querySelector('.sage-chat-turn')?.textContent.includes('普通回答 0'));
      if((await state()).requests!==requests)throw Error('Reading history generated an answer');
      aria('打开会话列表').click();await until(()=>button('重命名当前会话'));button('重命名当前会话').click();
      await until(()=>aria('会话名称'));
      const name=aria('会话名称');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(name,'Whatnot · 算法');name.dispatchEvent(new Event('input',{bubbles:true}));
      await until(()=>!button('保存名称').disabled);button('保存名称').click();await until(()=>!aria('会话名称'));
      aria('关闭会话列表').click();await until(()=>aria('打开会话列表').textContent.includes('Whatnot'));
      type('未发送的后续问题');await new Promise(r=>setTimeout(r,80));
      aria('打开会话列表').click();await until(()=>button('新对话')&&!button('新对话').disabled);button('新对话').click();
      await until(()=>!aria('会话列表')&&!aria('消息').disabled&&!document.querySelector('.sage-chat-turn'));
      if(aria('消息').value)throw Error('Draft leaked into new conversation');
      aria('打开会话列表').click();await until(()=>[...document.querySelectorAll('[role="row"]')].some(r=>r.textContent.includes('Whatnot')));
      [...document.querySelectorAll('[role="row"]')].find(r=>r.textContent.includes('Whatnot')).click();
      await until(()=>!aria('会话列表')&&!aria('消息').disabled&&aria('消息').value==='未发送的后续问题');
      return true;
    `);
    await run('resumed_thread_can_receive_a_followup', `
      aria('发送消息').click();await idle();await until(()=>document.querySelectorAll('.sage-chat-turn').length===2);
      if([...(await state()).operations].some(op=>op.status==='failed'))throw Error('Resumed thread failed');
      aria('打开会话列表').click();await until(()=>aria('历史会话'));return true;
    `);
    fs.writeFileSync(path.join(artifacts,'conversation-list.png'),(await win.webContents.capturePage()).toPNG());
    await run('new_conversation_from_drawer', `
      await until(()=>!button('新对话').disabled);button('新对话').click();await until(()=>!aria('会话列表')&&!aria('消息').disabled&&!document.querySelector('.sage-chat-turn'));return true;
    `);
    await run('switch_during_generation_requires_confirmation', `
      type('慢回答');await until(()=>!aria('发送消息').disabled);aria('发送消息').click();
      await until(()=>aria('停止生成'));
      aria('打开会话列表').click();await until(()=>button('新对话'));button('新对话').click();
      await until(()=>button('停止并切换'));
      button('取消').click();await until(()=>!button('停止并切换'));
      if(!aria('停止生成'))throw Error('Cancelling switch interrupted generation');
      aria('打开会话列表').click();await until(()=>button('新对话'));button('新对话').click();
      await until(()=>button('停止并切换'));button('停止并切换').click();
      await until(()=>!button('停止并切换')&&!aria('消息').disabled&&!document.querySelector('.sage-chat-turn'));
      if((await state()).busy)throw Error('Old generation survived switch');return true;
    `);
    await run('chat_switch_keeps_transcription_and_capture_sockets', `
      await fetch('/__audit/transcript',{method:'POST'});
      await fetch('/__audit/active',{method:'POST'});
      await until(()=>button('停止转录'));
      if(!button('查看转录')?.closest('[aria-label="转录控制"]'))throw Error('Transcript view is not beside capture button');
      button('查看转录').click();await until(()=>aria('实时转写')?.textContent.includes('先用一次遍历'));
      aria('实时转写').querySelector('[aria-label="关闭"]').click();
      const sockets=window.auditSockets.filter(s=>s.readyState===1);
      const previous=(await state()).conversation_id;
      aria('打开会话列表').click();await until(()=>aria('会话列表'));[...aria('会话列表').querySelectorAll('button')].find(b=>b.textContent.trim()==='新对话').click();
      await until(async()=>!aria('会话列表')&&!aria('消息').disabled&&(await state()).conversation_id!==previous);
      if(document.querySelector('[role="alertdialog"]')||!button('停止转录'))throw Error('Switch interrupted recording');
      if(sockets.some(s=>s.readyState!==1))throw Error('Switch closed an existing capture/UI socket');
      if(!(await state()).active)throw Error('Transcription stopped');
      button('查看转录').click();await until(()=>aria('实时转写')?.textContent.includes('先用一次遍历'));
      aria('实时转写').querySelector('[aria-label="关闭"]').click();await until(()=>!aria('实时转写'));
      button('停止转录').click();await until(()=>button('开始转录'));return true;
    `);
    await new Promise(r=>setTimeout(r,500));
    fs.writeFileSync(path.join(artifacts,'transcription-controls.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(620,440);await new Promise(r=>setTimeout(r,200));
    await run('small_desktop_empty_layout_has_one_scroll_area', `
      if(document.querySelectorAll('.preview-answer-scroll').length!==1||document.querySelectorAll('.sage-chat-empty').length!==1)throw Error('Duplicate compact layout');
      if(aria('消息').getBoundingClientRect().bottom>innerHeight)throw Error('Composer clipped');return true;
    `);
    fs.writeFileSync(path.join(artifacts,'compact.png'),(await win.webContents.capturePage()).toPNG());
    await run('server_restart_refreshes_credentials_preserves_history_and_draft', `
      type('服务器重启后仍保留的草稿');
      const old=(await state());
      const ready=window.auditEvents.filter(e=>e.type==='session_ready').length;
      const requestsBefore=old.requests;
      await fetch('/__audit/restart',{method:'POST'});
      await until(()=>window.auditEvents.filter(e=>e.type==='session_ready').length>ready&&!aria('消息').disabled);
      const restored=await state();
      if(restored.conversation_id!==old.conversation_id)throw Error('Restart changed conversation');
      if(restored.requests!==requestsBefore)throw Error('Restart replayed a model request');
      if(restored.active)throw Error('Restart unexpectedly started transcription');
      if(aria('消息').value!=='服务器重启后仍保留的草稿')throw Error('Restart lost unsent draft');
      if(JSON.stringify(restored.transcripts)!==JSON.stringify(old.transcripts))throw Error('Restart lost transcription');
      aria('打开会话列表').click();await until(()=>aria('历史会话'));
      if(aria('会话列表').querySelector('[role="alert"]'))throw Error('Conversation authorization did not recover');
      aria('关闭会话列表').click();return true;
    `);
    if(errors.length)throw Error(errors.join('\n'));
    fs.writeFileSync(path.join(artifacts,'checks.json'),JSON.stringify(checks,null,2));finish();
  } catch(error) { if(win&&!win.isDestroyed())fs.writeFileSync(path.join(artifacts,'failure.png'),(await win.webContents.capturePage()).toPNG());finish(error); }
});
