const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { snapshotFromResult, readImage, capture, PREFIX } = require('../Support/native-appshot.cjs');

test('native text stays tied to the selected window and strips runtime guidance', () => {
  const result = title => ({ content: [{ type: 'text', text: PREFIX + JSON.stringify({
    app: '/Applications/Test.app', text: `<app_specific_instructions>runtime guidance</app_specific_instructions>\nWindow: "${title}", App: Test.\n0 window\n中文原文`,
  }) }] });
  assert.match(snapshotFromResult(result('Selected'), 'Selected').text, /^Window:/);
  assert.equal(snapshotFromResult(result('Focused')).window_title, 'Focused');
  assert.throws(() => snapshotFromResult(result('Other'), 'Selected'), /不一致/);
  assert.throws(() => snapshotFromResult({ ...result('Selected'), isError: true }, 'Selected'), /失败/);
  assert.throws(() => snapshotFromResult({ content: [] }, 'Selected'), /失败/);
});

test('original image reading rejects nonimages and paths outside the temporary directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-native-image-'));
  try {
    const image = path.join(root, 'image.png');
    await fs.writeFile(image, Buffer.from([137,80,78,71,13,10,26,10]));
    assert.match(await readImage(pathToFileURL(image).href, root), /^data:image\/png;base64,/);
    await fs.writeFile(image, 'private text');
    await assert.rejects(readImage(pathToFileURL(image).href, root), /格式/);
    await assert.rejects(readImage(pathToFileURL(__filename).href, root), /位置/);
    await assert.rejects(readImage('https://example.test/image.png', root), /本机/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('stdio capture accepts only the manual read approval and reaps the runtime', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sage-native-mcp-'));
  try {
    const app = path.join(root, 'Fixture.app'); await fs.mkdir(app);
    const image = path.join(root, 'capture.png'); await fs.writeFile(image, Buffer.from([137,80,78,71,13,10,26,10]));
    const script = path.join(root, 'mcp.cjs');
    await fs.writeFile(script, `
      const readline = require('node:readline');
      require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'pid'))},String(process.pid));
      const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
      let call;
      readline.createInterface({input:process.stdin}).on('line', line => {
        const m=JSON.parse(line);
        if(m.method==='initialize') send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'fixture',version:'1'}}});
        if(m.method==='tools/call') {
          call=m;
          send({jsonrpc:'2.0',id:99,method:'elicitation/create',params:{mode:'form',requestedSchema:{type:'object',properties:{}},_meta:{connector_id:'computer-use',tool_name:process.env.SCENARIO==='write'?'click':'get_app_state',tool_params:{app:process.env.SCENARIO==='other'?'other.app':'test.fixture'}}}});
        }
        if(m.id===99 && m.result) {
          require('node:fs').writeFileSync(${JSON.stringify(path.join(root, 'approval.json'))},JSON.stringify(m.result));
          if(m.result.action==='accept') send({jsonrpc:'2.0',id:call.id,result:{content:[{type:'text',text:${JSON.stringify(PREFIX)}+JSON.stringify({app:${JSON.stringify(app)},text:'Window: "Fixture", App: Fixture.\\n完整中文内容',screenshot:{url:${JSON.stringify(pathToFileURL(image).href)}}})}]}});
          else send({jsonrpc:'2.0',id:call.id,result:{isError:true,content:[]}});
        }
      });
    `);
    const request = { app, bundle_id: 'test.fixture', window_title: 'Fixture' };
    const config = scenario => ({ command: process.execPath, args: [script], env: { SCENARIO: scenario } });
    const result = await capture(request, config('read'));
    assert.equal(result.status, 'available'); assert.match(result.text, /完整中文/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'approval.json'))), { action: 'accept', content: {} });
    const pid = Number(await fs.readFile(path.join(root, 'pid'), 'utf8'));
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (let attempt = 0; attempt < 100 && alive(); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(), false, 'completed capture must stop its independent MCP process');
    await assert.rejects(capture(request, config('write')), /超出/);
    await assert.rejects(capture(request, config('other')), /超出/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
