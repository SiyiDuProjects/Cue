// Browser -> real server -> real CaptureAdapter + React approval; synthetic media.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const root = path.resolve(__dirname, '../../..');
const artifacts = path.join(root, 'artifacts/device-connection');
fs.mkdirSync(artifacts, { recursive: true });
app.setPath('userData', path.join(artifacts, 'electron-profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let child, host, phone, log = '', errors = [];
const deadline = setTimeout(() => finish(new Error('Device flow timeout')), 60000);
function finish(error) {
  clearTimeout(deadline);
  for (const win of [host, phone]) if (win && !win.isDestroyed()) win.destroy();
  if (child) child.kill();
  fs.writeFileSync(path.join(artifacts, 'server.log'), log);
  if (error) console.error(error.stack);
  app.exit(error ? 1 : 0);
}
async function freePort() { return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
async function until(win, expression) {
  return win.webContents.executeJavaScript(`(async()=>{for(let i=0;i<200;i++){if(${expression})return true;await new Promise(r=>setTimeout(r,40));}throw Error(document.body.innerText)})()`);
}
async function click(win, text) {
  await until(win, `[...document.querySelectorAll('button,[role="option"]')].some(e=>e.textContent.trim()==='${text}'||e.getAttribute('data-key')==='${text}')`);
  return win.webContents.executeJavaScript(`[...document.querySelectorAll('button,[role="option"]')].find(e=>e.textContent.trim()==='${text}'||e.getAttribute('data-key')==='${text}').click()`);
}
app.whenReady().then(async () => {
  try {
    const base = 'http://127.0.0.1:' + await freePort();
    child = spawn(path.join(root, 'apps/server/.venv/Scripts/python.exe'), [path.join(__dirname, 'device-audit-server.py')], {
      cwd: path.join(root, 'apps/server'), windowsHide: true, env: { ...process.env, AUDIT_PORT: new URL(base).port }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', value => log += value); child.stderr.on('data', value => log += value);
    for (let i=0;i<150;i++) { try { if ((await fetch(base+'/health')).ok) break; } catch {} await new Promise(r=>setTimeout(r,40)); }
    function window(partition, width, height) {
      const win = new BrowserWindow({ show: false, width, height, webPreferences: { partition, sandbox: true, contextIsolation: true, offscreen: true, backgroundThrottling: false } });
      win.webContents.setAudioMuted(true);
      win.webContents.session.setPermissionRequestHandler((_w,_p,cb)=>cb(false));
      win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel: !(d.url.startsWith(base+'/')||d.url.startsWith(base.replace('http','ws')+'/'))}));
      win.webContents.on('console-message', (_e,level,message)=>{if(level>=3&&!message.includes('404'))errors.push(message);});
      return win;
    }
    phone = window('phone-device-audit', 844, 390);
    await phone.loadURL(base);
    await until(phone, `document.body.innerText.includes('请在电脑上打开 Sage')`);
    const checks = ['empty_device_list'];
    if (await phone.webContents.executeJavaScript(`!!document.querySelector('input[type=password]')`)) throw Error('Password UI remains');
    host = window('host-device-audit', 860, 600);
    await host.loadURL(base+'/__device/host');
    await until(phone, `[...document.querySelectorAll('[role=option]')].some(e=>e.getBoundingClientRect().height>=48)`);
    await new Promise(resolve=>setTimeout(resolve,350));
    fs.writeFileSync(path.join(artifacts,'device-list.png'), (await phone.webContents.capturePage()).toPNG());
    async function select() { await phone.webContents.executeJavaScript(`document.querySelector('[role=option]').click()`); await until(phone, `document.body.innerText.includes('在电脑上确认')`); await until(host, `document.body.innerText.includes('允许连接？')`); }
    await select();
    await new Promise(resolve=>setTimeout(resolve,350));
    fs.writeFileSync(path.join(artifacts,'desktop-approval.png'), (await host.webContents.capturePage()).toPNG());
    await click(host,'拒绝');
    await until(phone, `document.body.innerText.includes('电脑未允许连接')`);
    checks.push('desktop_denial');
    await select();
    await click(host,'允许');
    await until(phone, `!!document.querySelector('.preview-answer-scroll')`);
    checks.push('desktop_approval_real_ws');
    const cookies = await phone.webContents.session.cookies.get({url:base});
    const trusted = cookies.find(cookie=>cookie.name==='interview_trusted_browser');
    if (!trusted?.httpOnly) throw Error('Trusted cookie missing HttpOnly');
    await phone.loadURL(base);
    await until(phone, `!!document.querySelector('[role=option]')`);
    await phone.webContents.executeJavaScript(`document.querySelector('[role=option]').click()`);
    await until(phone, `!!document.querySelector('.preview-answer-scroll')`);
    if (await host.webContents.executeJavaScript(`document.body.innerText.includes('允许连接？')`)) throw Error('Repeated approval');
    checks.push('remembered_browser_after_reload');
    await click(phone,'开始面试');
    await until(phone, `!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='结束面试')`);
    if (!(await (await fetch(base+'/__device/state')).json()).active) throw Error('Remote start did not reach server');
    checks.push('browser_controls_start');
    await click(phone,'结束面试');
    await click(phone,'确认结束');
    await until(phone, `!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='开始面试'&&!e.disabled)`);
    if (await host.webContents.executeJavaScript(`document.body.innerText.includes('允许连接？')`)) throw Error('New interview repeated approval');
    if (await phone.webContents.executeJavaScript(`document.body.innerText.includes('选择设备')`)) throw Error('Lost device control after ending');
    checks.push('browser_controls_end_and_stays_connected');
    await click(phone,'开始面试');
    await until(phone, `!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='结束面试')`);
    checks.push('next_interview_without_reauthorization');
    await click(phone,'结束面试');
    await click(phone,'确认结束');
    await until(phone, `!![...document.querySelectorAll('button')].find(e=>e.textContent.trim()==='开始面试'&&!e.disabled)`);
    const state = await (await fetch(base+'/__device/state')).json();
    if (state.model_connections || state.active) throw Error('Pairing started model or interview');
    if (errors.length) throw Error(errors.join('\n'));
    fs.writeFileSync(path.join(artifacts,'report.json'), JSON.stringify({checks,state,model_calls:0,real_media:false},null,2));
    console.log(JSON.stringify({checks,state,model_calls:0,real_media:false}));
    finish();
  } catch(error) { finish(error); }
});
