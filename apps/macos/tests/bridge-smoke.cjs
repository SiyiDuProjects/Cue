// Exercises the packaged read-only Sites bridge with an in-memory HTTP service.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const app = path.resolve(__dirname, '../output/Sage.app/Contents');
const bridge = path.join(app, 'Resources/bridge');
const { MaterialsHost } = require(path.join(bridge, 'materials-host.cjs'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-mac-materials-'));
async function eventually(predicate) {
  for (let i=0;i<200;i++) { if(predicate()) return; await new Promise(r=>setTimeout(r,5)); }
  throw Error('Timed out waiting for fixture');
}
(async()=>{
 let host;
 try {
  const config={apiBaseUrl:'https://fixture.invalid',siteToken:'synthetic-site',captureToken:'synthetic-device',dataRoot:root};
  const workspace=path.join(root,'assistant-workspace');
  let jobs=[],requests=0; const results=new Map();
  const fetcher=async(url,options)=>{
   requests++;
   assert.equal(options.headers['OAI-Sites-Authorization'],'Bearer synthetic-site');
   assert.equal(options.headers.Authorization,'Bearer synthetic-device');
   assert.equal(options.redirect,'error');
   assert(url.startsWith(config.apiBaseUrl+'/capture/materials'));
   if(options.method==='POST')results.set(url.split('/').at(-1),JSON.parse(options.body));
   return Response.json(options.method==='GET'?{jobs:jobs.splice(0)}:{saved:true});
  };
  host=new MaterialsHost(config,{fetcher,interval:5});
  assert.deepEqual(fs.readdirSync(workspace),['materials']);
  fs.writeFileSync(path.join(workspace,'materials/resume.md'),'简历原文\n经验');
  await eventually(()=>requests>1);
  assert.equal(results.size,0,'connection does not upload documents proactively');
  const job=(id,name,args={})=>({id,request:JSON.stringify({name,arguments:args})});
  jobs=[job('list','list_materials'),job('read','read_material',{path:'resume.md'}),job('escape','read_material',{path:'../private.txt'}),job('generate','codex_request')];
  await eventually(()=>results.size===4);
  assert.equal(results.get('list').files[0].path,'resume.md');
  assert.equal(results.get('read').text,'简历原文\n经验');
  assert(results.get('escape').error); assert(results.get('generate').error);
  assert(!results.get('generate').text);
  console.log('PASS authenticated on-demand catalog and original UTF-8; traversal and generation rejected');
  fs.writeFileSync(path.join(root,'private.txt'),'never expose');
  fs.symlinkSync(path.join(root,'private.txt'),path.join(workspace,'materials/link.txt'));
  jobs=[job('symlink','read_material',{path:'link.txt'}),job('stale','read_material',{path:'resume.md',revision:'obsolete'})];
  await eventually(()=>results.has('symlink')&&results.has('stale'));
  assert(results.get('symlink').error); assert(results.get('stale').error);
  console.log('PASS document symlinks and stale revisions fail without disclosing content');
  const pending=[]; host.materials.call=()=>new Promise(resolve=>pending.push(resolve));
  jobs=Array.from({length:9},(_,i)=>job('slow-'+i,'list_materials'));
  await eventually(()=>pending.length===8);
  host.close(); pending.forEach(resolve=>resolve({files:[]}));
  await new Promise(r=>setImmediate(r));
  assert.equal([...results.keys()].filter(k=>k.startsWith('slow-')).length,0);
  console.log('PASS eight-read bound and shutdown cancels stale uploads');
  for(const override of [{siteToken:''},{siteToken:'x\r\nInjected: y'},{captureToken:{}},{apiBaseUrl:'http://example.com'},{apiBaseUrl:'https://user:secret@example.com'},{apiBaseUrl:'https://fixture.invalid/path'}]){
   assert.throws(()=>new MaterialsHost({...config,...override},{fetcher}));
  }
  assert.deepEqual(fs.readdirSync(bridge).sort(),['electron','materials-host.cjs','native-appshot.cjs']);
  assert.deepEqual(fs.readdirSync(path.join(bridge,'electron')),['materials-host.cjs','materials.cjs']);
  const child=spawn(path.join(app,'MacOS/sage-node'),[path.join(bridge,'materials-host.cjs')],{stdio:['pipe','ignore','ignore']});
  const ended=once(child,'exit'),guard=setTimeout(()=>child.kill('SIGKILL'),5000);
  child.stdin.end(JSON.stringify({...config,apiBaseUrl:'http://127.0.0.1:1'})+'\n');
  const [code]=await ended; clearTimeout(guard); assert.equal(code,0);
  console.log('PASS packaged Node closes with parent; no model host, credentials in argv or agent templates');
 } finally {host?.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
