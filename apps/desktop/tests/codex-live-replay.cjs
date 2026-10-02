// Explicit opt-in only: independent Luna thread using the already logged-in CLI.
const fs = require("node:fs");
const path = require("node:path");
const { runtimeOptions } = require("../electron/codex-runtime.cjs");
const { CodexProcess } = require("../electron/codex-process.cjs");
const { CodeFiles } = require("../electron/code-files.cjs");
if (process.env.SAGE_ALLOW_LIVE_TEST !== "1") throw new Error("Real model test requires explicit opt-in.");
const root = path.resolve(__dirname, "../../..");
const output = path.join(root, "artifacts/interview-replay", new Date().toISOString().replace(/[:.]/g,"-"));
fs.mkdirSync(output, {recursive:true});
const options = runtimeOptions({conversationId: "qa-" + Date.now()});
if (process.argv.includes('--synthetic')) {
  // Public guides plus invented fixture facts only. Do not copy personal materials.
  const fixtureRoot=path.join(output,'synthetic-workspace');
  fs.mkdirSync(path.join(fixtureRoot,'materials'),{recursive:true});
  fs.cpSync(path.join(root,'assistant-workspace/guides'),path.join(fixtureRoot,'guides'),{recursive:true});
  fs.writeFileSync(path.join(fixtureRoot,'materials/profile.md'),
    '# Invented test profile, not the user\nAlex built a toy log parser. It processed 100 fixture records; this was not a user count. No conflict or leadership story has been supplied.\n');
  options.instructions=fs.readFileSync(path.join(root,'assistant-workspace/AGENTS.md'),'utf8').replaceAll('{{REFERENCE_ROOT}}',fixtureRoot.replaceAll('\\','/'));
  options.workspace=path.join(fixtureRoot,'code');
}
options.codeFiles = new CodeFiles(options.workspace, options.env);
const cases = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], "utf8")) : [
  {id:"ood-clarify", text:"面试官口述：Design a parking lot. 先帮我判断需要澄清什么，不要写代码。"},
  {id:"ood-implement", text:"已确认：一个停车场，固定车位数，不区分车型、不计费。park(vehicle_id) 返回 bool，重复车牌或满位返回 False；leave(vehicle_id) 返回 bool，不存在返回 False。请解释对象状态和实现，给完整 Python 类 ParkingLot。"},
];
let resolveTurn, entries=[], started=0, first=0;
const cli = new CodexProcess(options, {emit:event=>{
  entries.push(event);
  if(event.kind==="delta" && !first)first=Date.now()-started;
  if(["completed","error","cancelled"].includes(event.kind))resolveTurn?.(event);
}});
(async()=>{
  console.log(JSON.stringify({output,workspace:options.workspace,model:"gpt-6-luna"}));
  for(const c of cases){
    entries=[]; started=Date.now(); first=0;
    const result = new Promise(resolve=>{resolveTurn=resolve;});
    const content=[{type:"input_text",text:c.text}];
    if(c.image)content.push({type:"input_image", image_url:"data:image/png;base64,"+fs.readFileSync(c.image).toString("base64")});
    await cli.run({request_id:c.id,model:"gpt-6-luna",effort:"high",expected_thread_id:cli.threadId,
      input:[{role:"user",content}],code_seed:[]});
    const timer=setTimeout(()=>{void cli.cancel(c.id).then(()=>resolveTurn({kind:"timeout"}));},120000);
    const end=await result;clearTimeout(timer);
    const record={...c,first_text_ms:first,elapsed_ms:Date.now()-started,end,events:entries};
    fs.writeFileSync(path.join(output,c.id+".json"),JSON.stringify(record,null,2));
    const text=entries.filter(e=>e.kind==="text_done").map(e=>e.text).join("\n\n");
    fs.writeFileSync(path.join(output,c.id+".md"),text);
    console.log(JSON.stringify({id:c.id,status:end.kind,elapsed_ms:record.elapsed_ms,first_text_ms:first,
      characters:text.length,files:cli.lastFiles?.files.map(f=>f.filename),detail:end.detail}));
    if(end.kind!=="completed")break;
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>cli.dispose());
