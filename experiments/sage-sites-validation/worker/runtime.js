// Isolated capability probe. All data is synthetic; private Sites dispatch is the access boundary.
let instance;
const encoder = new TextEncoder();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (condition, message, status = 400) => { if (!condition) throw Object.assign(new Error(message), {status}); };
const valid = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const json = (value, status = 200) => Response.json(value, {status, headers:{'Cache-Control':'no-store','X-Probe-Instance':instance}});
async function hash(bytes) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join(''); }
function base64(bytes) { let result=''; for(let i=0;i<bytes.length;i+=16384) result += String.fromCharCode(...bytes.subarray(i,i+16384)); return btoa(result); }
async function ingest(env, row) {
  check(valid(row.scope) && valid(row.id), 'invalid scope or id');
  check(Number.isInteger(row.revision) && row.revision > 0, 'invalid revision');
  check(typeof row.body === 'string' && row.body.length <= 8000, 'invalid body');
  check(['transcript','answer'].includes(row.kind), 'invalid kind');
  check([null,undefined,'interviewer','candidate'].includes(row.speaker), 'invalid speaker');
  return env.DB.prepare(`INSERT INTO probe_events(scope,id,seq,revision,kind,speaker,body,created)
    VALUES(?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM probe_events WHERE scope=?),?,?,?,?,?)
    ON CONFLICT(scope,id) DO UPDATE SET seq=(SELECT COALESCE(MAX(seq),0)+1 FROM probe_events WHERE scope=?),
    revision=excluded.revision,body=excluded.body,created=excluded.created WHERE excluded.revision>probe_events.revision`)
    .bind(row.scope,row.id,row.scope,row.revision,row.kind,row.speaker||null,row.body,Date.now(),row.scope).run();
}
async function timeline(env, scope, cursor) {
  check(valid(scope), 'invalid scope');
  let after=0;
  if(cursor){ const parts=cursor.split(':'); check(parts.length===2 && parts[0]===scope,'cursor belongs to a different timeline',409); after=Number(parts[1]); check(Number.isSafeInteger(after)&&after>=0,'invalid cursor'); }
  const result=await env.DB.prepare('SELECT * FROM probe_events WHERE scope=? AND seq>? ORDER BY seq LIMIT 200').bind(scope,after).all();
  return {scope,records:result.results,next_cursor:scope+':'+(result.results.at(-1)?.seq??after),read_at:Date.now()};
}
async function getJob(env,id) { return env.DB.prepare('SELECT * FROM probe_jobs WHERE id=?').bind(id).first(); }
async function runJob(env,id,scope,steps,interval,controller) {
  let connected=Boolean(controller);
  const send = value => { if(connected) try {controller.enqueue(encoder.encode('data: '+JSON.stringify(value)+'\n\n'));} catch {connected=false;} };
  const close = () => {if(connected) try {controller.close();} catch {connected=false;}};
  try {
    for(let i=1;i<=steps;i++) {
      await sleep(interval);
      const job=await getJob(env,id);
      if(job.cancelled) {await env.DB.prepare("UPDATE probe_jobs SET status='cancelled',updated=? WHERE id=?").bind(Date.now(),id).run();send({id,cancelled:true});close();return;}
      await ingest(env,{scope,id:id+'_'+i,revision:1,kind:'answer',body:JSON.stringify({job_id:id,index:i,text:'测试片段 '+i})});
      await env.DB.prepare("UPDATE probe_jobs SET status='running',count=?,updated=? WHERE id=?").bind(i,Date.now(),id).run();
      send({id,index:i,server_at:Date.now()});
    }
    await env.DB.prepare("UPDATE probe_jobs SET status='completed',updated=? WHERE id=?").bind(Date.now(),id).run();send({id,done:true});close();
  } catch(error) {
    console.error('probe job failed',error.name,error.message);
    await env.DB.prepare("UPDATE probe_jobs SET status='failed',updated=? WHERE id=?").bind(Date.now(),id).run();send({id,error:true});close();
  }
}
const toolNames=['list_interviews','read_interview','list_materials','read_material'];
async function mcp(request,env) {
  const rpc=await request.json();
  if(!('id' in rpc)) return new Response(null,{status:202});
  let result;
  if(rpc.method==='initialize') result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'sage-validation',version:'0.0.1'}};
  else if(rpc.method==='tools/list') result={tools:toolNames.map(name=>({name,description:'Synthetic validation only: '+name,inputSchema:{type:'object',properties:{interview_id:{type:'string'},cursor:{type:'string'},path:{type:'string'}}},annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}}))};
  else if(rpc.method==='tools/call') {
    const {name,arguments:args={}}=rpc.params; check(toolNames.includes(name),'unknown tool');
    let data,images=[];
    if(name==='list_interviews') data=(await env.DB.prepare('SELECT DISTINCT scope FROM probe_events').all()).results;
    if(name==='list_materials') data=[{path:'synthetic-reference.txt',revision:1}];
    if(name==='read_material'){check(args.path==='synthetic-reference.txt','unknown material',404);data={text:'合成资料：蓝鸟项目使用 SQLite 保存任务。这不是个人资料。'};}
    if(name==='read_interview') {
      data=await timeline(env,args.interview_id,args.cursor);
      const files=(await env.DB.prepare('SELECT * FROM probe_files WHERE scope=? AND removed=0 ORDER BY id LIMIT 2').bind(args.interview_id).all()).results;
      data.images=files;
      for(const file of files){const item=await env.BUCKET.get(file.hash);check(item,'missing image',500);images.push({type:'image',mimeType:file.mime,data:base64(new Uint8Array(await item.arrayBuffer()))});}
    }
    result={content:[{type:'text',text:JSON.stringify(data)},...images]};
  } else return json({jsonrpc:'2.0',id:rpc.id,error:{code:-32601,message:'Unknown method'}});
  return json({jsonrpc:'2.0',id:rpc.id,result});
}
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sage 架构验证</title><style>body{font:17px system-ui;max-width:800px;margin:48px auto;padding:20px;background:#f6f7f8;color:#1e2827}button{font:inherit;padding:12px;margin:4px;border:1px solid #ccd2d0;border-radius:10px;background:white}pre{white-space:pre-wrap;background:white;padding:20px;border-radius:16px;min-height:180px}</style><h1>Sage 架构验证</h1><p>独立私有测试站。仅使用合成内容，不采集麦克风，不接触正式 Sage。</p><button id="status">连接检查</button><button id="start">开始合成回答</button><button id="disconnect">断开显示</button><button id="cancel">取消任务</button><button id="resume">读取保存进度</button><pre id="out" aria-live="polite">准备就绪</pre><script>
let id,controller;const out=document.querySelector('#out');const show=x=>out.textContent=typeof x==='string'?x:JSON.stringify(x,null,2);const req=async(p,o)=>{const r=await fetch(p,o);if(!r.ok)throw Error(await r.text());return r.json()};
document.querySelector('#status').onclick=()=>req('/api/status').then(show).catch(e=>show(e.message));
document.querySelector('#start').onclick=async()=>{id='browser_'+crypto.randomUUID();controller=new AbortController();show('任务 '+id);try{const r=await fetch('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,scope:'browser',steps:90,interval:1000}),signal:controller.signal});if(!r.ok)throw Error(await r.text());const reader=r.body.getReader(),decoder=new TextDecoder();while(true){const {value,done}=await reader.read();if(done)break;out.textContent+=decoder.decode(value)}}catch(e){out.textContent+='\\n显示连接已断开：'+e.message}};
document.querySelector('#disconnect').onclick=()=>controller?.abort();document.querySelector('#cancel').onclick=()=>id&&req('/api/jobs/'+id+'/cancel',{method:'POST'}).then(show);document.querySelector('#resume').onclick=()=>id&&req('/api/jobs/'+id).then(show);
</script></html>`;
export default {async fetch(request,env,ctx){try{
  instance ??= crypto.randomUUID();
  const url=new URL(request.url),path=url.pathname;
  if(request.method!=='GET'&&request.headers.has('Origin')) check(request.headers.get('Origin')===url.origin,'cross-origin mutation rejected',403);
  if(path==='/') return new Response(page,{headers:{'Content-Type':'text/html;charset=utf-8','Cache-Control':'no-store'}});
  if(path==='/api/status') return json({synthetic_only:true,instance,d1:Boolean(env.DB),r2:Boolean(env.BUCKET),version:1});
  if(path==='/mcp'&&request.method==='POST') return mcp(request,env);
  if(path==='/api/events'&&request.method==='POST'){const rows=await request.json();check(Array.isArray(rows)&&rows.length<=10,'invalid rows');for(const row of rows)await ingest(env,row);return json({accepted:rows.length});}
  if(path==='/api/timeline')return json(await timeline(env,url.searchParams.get('scope'),url.searchParams.get('cursor')));
  if(path==='/api/jobs'&&request.method==='POST'){
    const {id,scope,steps=30,interval=1000,detached=false}=await request.json();check(valid(id)&&id.length<80&&valid(scope),'invalid job');check(Number.isInteger(steps)&&steps>0&&steps<=120&&Number.isInteger(interval)&&interval>=100&&interval<=2000,'invalid duration');
    const insert=await env.DB.prepare("INSERT OR IGNORE INTO probe_jobs(id,scope,kind,status,created,updated) VALUES(?,?,'synthetic','accepted',?,?)").bind(id,scope,Date.now(),Date.now()).run();
    if(insert.meta.changes===0)return json({replayed:true,job:await getJob(env,id)});
    if(detached){ctx.waitUntil(runJob(env,id,scope,steps,interval));return json({id,detached:true},202);}
    let controller;const stream=new ReadableStream({start(c){controller=c;c.enqueue(encoder.encode('data: '+JSON.stringify({id,accepted:true})+'\n\n'));},cancel(){}});
    ctx.waitUntil(runJob(env,id,scope,steps,interval,controller));return new Response(stream,{headers:{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'}});
  }
  const jobRoute=path.match(/^\/api\/jobs\/([a-zA-Z0-9_-]+)(\/cancel)?$/);
  if(jobRoute){const id=jobRoute[1];if(jobRoute[2]){check(request.method==='POST','POST required',405);await env.DB.prepare("UPDATE probe_jobs SET cancelled=1 WHERE id=? AND status NOT IN ('completed','cancelled','failed')").bind(id).run();}const job=await getJob(env,id);check(job,'unknown job',404);return json(job);}
  if(path==='/api/image'){
    const scope=url.searchParams.get('scope'),id=url.searchParams.get('id');check(valid(scope)&&valid(id),'invalid image reference');
    if(request.method==='POST'){
      const mime=request.headers.get('Content-Type');check(['image/png','image/jpeg'].includes(mime),'image required');const bytes=await request.arrayBuffer();check(bytes.byteLength<=6*1024*1024,'image too large',413);const digest=await hash(bytes);
      await env.BUCKET.put(digest,bytes,{httpMetadata:{contentType:mime}});await env.DB.prepare('INSERT OR IGNORE INTO probe_files(scope,id,hash,size,mime) VALUES(?,?,?,?,?)').bind(scope,id,digest,bytes.byteLength,mime).run();return json({hash:digest,size:bytes.byteLength});
    }
    const file=await env.DB.prepare('SELECT * FROM probe_files WHERE scope=? AND id=? AND removed=0').bind(scope,id).first();check(file,'unknown image',404);const object=await env.BUCKET.get(file.hash);check(object,'missing image',500);return new Response(object.body,{headers:{'Content-Type':file.mime,'Cache-Control':'no-store'}});
  }
  if(path==='/api/image/state'&&request.method==='POST'){const {scope,id,sent,removed}=await request.json();check(valid(scope)&&valid(id)&&typeof sent==='boolean'&&typeof removed==='boolean','invalid state');await env.DB.prepare('UPDATE probe_files SET sent=?,removed=? WHERE scope=? AND id=?').bind(Number(sent),Number(removed),scope,id).run();return json({ok:true});}
  if(path==='/api/response-context'){const scope=url.searchParams.get('scope');check(valid(scope),'invalid scope');return json((await env.DB.prepare('SELECT id FROM probe_files WHERE scope=? AND sent=1 AND removed=0').bind(scope).all()).results);}
  if(path==='/ws'){
    check(request.headers.get('Upgrade')==='websocket','websocket required',426);const speaker=url.searchParams.get('speaker');check(['interviewer','candidate'].includes(speaker),'invalid speaker');const pair=new WebSocketPair(),[client,server]=Object.values(pair);server.accept();server.binaryType='arraybuffer';server.send(JSON.stringify({ready:true,speaker,instance}));server.addEventListener('message',event=>server.send(event.data));server.addEventListener('close',()=>{try{server.close(1000,'done')}catch{}});return new Response(null,{status:101,webSocket:client});
  }
  return json({error:'not found'},404);
}catch(error){console.error('probe request failed',error.name,error.message);return json({error:error.message},error.status||500);}}};
