// Offline test of the packaged helper's login/runtime isolation; no real CLI or login.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-mac-bridge-'));
(async () => {
  try {
    const app = path.resolve(__dirname, '../output/Sage.app/Contents');
    const fake = path.join(root, 'fake-codex');
    const marker = path.join(root, 'verified.json');
    fs.writeFileSync(fake, `#!${process.execPath}\nconst fs = require('node:fs');
const assert = require('node:assert/strict');
assert.equal(process.argv.at(-1), 'login');
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.CODEX_HOME, ${JSON.stringify(path.join(root, 'data/assistant-workspace/.runtime/codex'))});
assert(process.argv.includes('features.multi_agent=false'));
assert(process.argv.includes('features.plugins=false'));
fs.appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ok:true}) + "\\n");
`, { mode: 0o700 });
    const child = spawn(path.join(app, 'MacOS/sage-node'), [path.join(app, 'Resources/bridge/host.cjs')], {
      stdio: ['pipe', 'ignore', 'pipe'], env: { ...process.env, OPENAI_API_KEY: 'synthetic-must-not-inherit' },
    });
    child.stderr.resume();
    const deadline = setTimeout(() => child.kill(), 5000);
    const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
    const config = JSON.stringify({ action: 'login', dataRoot: path.join(root, 'data'), codexBin: fake });
    child.stdin.write(config + '\n' + config + '\n');
    const code = await ended; clearTimeout(deadline);
    assert.equal(code, 0, 'packaged bridge exits successfully after synthetic login');
    assert.equal(fs.readFileSync(marker, "utf8").trim(), JSON.stringify({ok:true}), "one private stdin session launches exactly one login");
    assert(fs.existsSync(path.join(root, 'data/assistant-workspace/AGENTS.md')));
    assert.deepEqual(fs.readdirSync(path.join(root, 'data/assistant-workspace/materials')), []);
    console.log('PASS packaged Node bridge, dedicated login home, secret filtering, public-template whitelist, one-shot stdin session');
    const stuck = path.join(root, 'stuck-cli'), pidFile = path.join(root, 'stuck-pid');
    fs.writeFileSync(stuck, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`, {mode:0o700});
    let stuckPID;
    const closing = spawn(path.join(app, 'MacOS/sage-node'), [path.join(app, 'Resources/bridge/host.cjs')], {stdio:['pipe','ignore','ignore']});
    const closed = new Promise(resolve => closing.once('exit', code => resolve(code)));
    const guard = setTimeout(() => closing.kill('SIGKILL'), 6000);
    try {
      closing.stdin.write(JSON.stringify({action:'login', dataRoot:path.join(root,'data'), codexBin:stuck})+'\n');
      for(let i=0;i<200&&!fs.existsSync(pidFile);i++) await new Promise(resolve=>setTimeout(resolve,10));
      stuckPID=Number(fs.readFileSync(pidFile,'utf8'));
      closing.stdin.end();
      assert.equal(await closed, 1, 'cancelled login cannot report success');
      assert.throws(()=>process.kill(stuckPID,0), {code:'ESRCH'}, 'cancelled login process must not remain alive');
      console.log('PASS parent pipe closure cancels and reaps a login that ignores SIGTERM');
    } finally {
      clearTimeout(guard);
      if(stuckPID) try{process.kill(stuckPID,'SIGKILL')}catch{}
      if(closing.exitCode===null&&closing.signalCode===null) closing.kill('SIGKILL');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
