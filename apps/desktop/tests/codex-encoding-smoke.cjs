// Native Codex tools + loopback scripted provider. No model or microphone calls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { findCodex, runtimeOptions } = require('../electron/codex-runtime.cjs');
const { CodexProcess } = require('../electron/codex-process.cjs');

if (process.platform !== 'win32') throw Error('Windows encoding check only.');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-encoding-'));
const home = path.join(temp, 'home');
fs.mkdirSync(home);
const sample = '中文简历与算法 → 状态 α β 😀 café';
const sampleFile = path.join(temp, '中文资料.txt');
fs.writeFileSync(sampleFile, sample, 'utf8');
const guideFiles = ['coding.md', 'algorithms.md', 'object-design.md'].map(name =>
  path.join(root, 'assistant-workspace/guides', name));
const files = [...guideFiles, sampleFile];
const q = text => `'${text.replaceAll("'", "''")}'`;
// Exercise the command actually supplied in baseInstructions, not a test-only workaround.
const instructions = fs.readFileSync(path.join(root, 'assistant-workspace/AGENTS.md'), 'utf8');
const reader = instructions.match(/`(node -e .*?) '文件路径'`/);
assert.ok(reader, 'UTF-8 reading rule missing from the assistant instructions');
const script = reader[1] + ' ' + files.map(q).join(' ');
const input = `text((await tools.exec_command(${JSON.stringify({ cmd: script, shell: 'powershell', max_output_tokens: 14000 })})).output);`;
let requests = 0, toolText = '', providerError, finish;
const result = new Promise(resolve => { finish = resolve; });
const server = http.createServer(async (req, res) => {
  try {
    assert.match(req.url, /\/responses$/);
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const number = ++requests;
    assert.ok(number <= 2, 'Unexpected extra provider call');
    const id = `resp_encoding_${number}`;
    let item;
    if (number === 1) {
      item = { id: 'tool_encoding', type: 'custom_tool_call', call_id: 'call_encoding', name: 'exec', input };
    } else {
      const outputs = body.input.filter(x => x.type === 'custom_tool_call_output' || x.type === 'function_call_output');
      toolText = outputs.map(x => typeof x.output === 'string' ? x.output :
        (x.output || []).map(c => c.text || '').join('\n')).join('\n');
      for (const file of files) {
        const expected = fs.readFileSync(file, 'utf8').trim();
        assert.ok(toolText.replaceAll('\r\n', '\n').includes(expected.replaceAll('\r\n', '\n')),
          `Native tool output changed ${path.basename(file)}`);
      }
      assert.ok(!toolText.includes('\uFFFD'), 'Replacement characters in tool output');
      item = { id: 'msg_encoding', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Encoding check passed.', annotations: [] }] };
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event('response.created', { response: { id, object: 'response', status: 'in_progress', output: [] } });
    event('response.output_item.added', { output_index: 0, item });
    event('response.output_item.done', { output_index: 0, item });
    event('response.completed', { response: { id, object: 'response', status: 'completed', output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    res.end();
  } catch (error) {
    providerError = error;
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: error.message } }));
    finish({ kind: 'error', detail: error.message });
  }
});
let cli;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const options = runtimeOptions();
  options.binary = findCodex(); options.env.CODEX_HOME = home; options.workspace = temp;
  options.instructions = instructions.replaceAll('{{REFERENCE_ROOT}}', path.join(root, 'assistant-workspace').replaceAll('\\', '/'));
  const providerConfig = [
    'model_provider="sage_encoding_test"',
    'model_providers.sage_encoding_test.name="Local encoding regression"',
    `model_providers.sage_encoding_test.base_url=${JSON.stringify(baseUrl)}`,
    'model_providers.sage_encoding_test.wire_api="responses"',
    'model_providers.sage_encoding_test.requires_openai_auth=false',
    'model_providers.sage_encoding_test.request_max_retries=0',
    'model_providers.sage_encoding_test.stream_max_retries=0',
    'web_search="disabled"',
  ].flatMap(v => ['-c', v]);
  cli = new CodexProcess(options, {
    spawnProcess: (binary, args, settings) => spawn(binary, [...providerConfig, ...args], settings),
    emit: event => { if (['completed', 'error', 'cancelled'].includes(event.kind)) finish(event); },
  });
  const timer = setTimeout(() => finish({ kind: 'timeout' }), 30000);
  await cli.run({ request_id: 'encoding-offline', model: 'gpt-6-luna', effort: 'low',
    input: [{ content: [{ type: 'input_text', text: 'Read the test files.' }] }] });
  const end = await result; clearTimeout(timer);
  if (providerError) throw providerError;
  assert.equal(end.kind, 'completed', end.detail);
  assert.equal(requests, 2);
  const report = { passed: true, nativeTool: 'exec_command', sandbox: 'readOnly', filesChecked: files.length,
    replacementCharacters: 0, provider: 'scripted loopback fixture', realModelCalls: 0 };
  const output = path.join(root, 'artifacts/encoding-fix'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'native-tool-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => {
  cli?.dispose(); server.closeAllConnections(); server.close();
  // Keep the temporary native trace for diagnosis; contains synthetic data and public guides only.
  console.log(JSON.stringify({ traceHome: home }));
});
