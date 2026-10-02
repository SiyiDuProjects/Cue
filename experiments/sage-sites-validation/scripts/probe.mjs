import {writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import WebSocket from 'ws';
const input=await new Promise(resolve=>{let s='';const onData=b=>{s+=b;if(/[\r\n]/.test(s)){process.stdin.off('data',onData);if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();resolve(JSON.parse(s.trim()));}};if(process.stdin.isTTY)process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');process.stdin.on('data',onData);process.stdin.resume();console.log('Ready for private probe credentials on stdin (input is hidden).');});
const base=input.url,headers={'OAI-Sites-Authorization':'Bearer '+input.token};
const results=[],scope='run_'+Date.now(),started=Date.now();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const digest=b=>createHash('sha256').update(b).digest('hex');
const log=(name,value)=>{const result={name,at_ms:Date.now()-started,...value};results.push(result);console.log(JSON.stringify(result));};
async function request(path,options={}){const r=await fetch(base+path,{...options,headers:{...headers,...options.headers},signal:options.signal||AbortSignal.timeout(30000)});if(!r.ok)throw Error('HTTP '+r.status+' '+(await r.text()).slice(0,250));return r;}
async function get(path){return(await request(path)).json();}
async function post(path,body){return(await request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)})).json();}
async function run(name,fn){if(input.only?.length&&!input.only.includes(name))return;try{log(name,{pass:true,...await fn()});}catch(e){log(name,{pass:false,error:e.message});}}
function assert(ok,message){if(!ok)throw Error(message);}
function png(){
 const crc=data=>{let c=0xffffffff;for(const b of data){c^=b;for(let k=0;k<8;k++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const n=Buffer.from(name),len=Buffer.alloc(4),sum=Buffer.alloc(4);len.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([n,data])));return Buffer.concat([len,n,data,sum]);};
 const width=1400,height=1124,row=width*3+1,raw=randomBytes(row*height);for(let y=0;y<height;y++)raw[y*row]=0;
 const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
async function audio(speaker){return new Promise((resolve,reject)=>{
 const ws=new WebSocket(base.replace('https:','wss:')+'/ws?speaker='+speaker,{headers,handshakeTimeout:15000});let sent=0,received=0,maxLatency=0,interval;const sentTimes=new Map(),timer=setTimeout(()=>{ws.terminate();reject(Error('WebSocket timeout '+speaker));},15000);
 ws.on('error',e=>{clearTimeout(timer);clearInterval(interval);reject(e)});ws.on('message',(data,binary)=>{if(!binary){const hello=JSON.parse(data.toString());if(hello.ready)interval=setInterval(()=>{const packet=Buffer.alloc(960);packet.writeUInt32LE(sent);sentTimes.set(sent,Date.now());ws.send(packet);sent++;if(sent===250)clearInterval(interval);},20);return;}const index=data.readUInt32LE(0);maxLatency=Math.max(maxLatency,Date.now()-sentTimes.get(index));received++;if(received===250){clearTimeout(timer);ws.close();resolve({speaker,frames:received,max_round_trip_ms:maxLatency,bytes:received*960});}});
 });}
async function job(name,{steps,interval=1000,disconnectAfter,detached=false,cancelAfter}){
 const id=scope+'_'+name,controller=new AbortController(),begin=Date.now();
 if(detached){await post('/api/jobs',{id,scope,steps,interval,detached:true});await sleep(steps*interval+5000);return {job:await get('/api/jobs/'+id),elapsed_ms:Date.now()-begin};}
 const r=await request('/api/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,scope,steps,interval}),signal:controller.signal});
 const firstHeaders=Date.now()-begin;let chunks=0,last=Date.now(),maxGap=0,firstDelta=null,cancelRequest;
 const timer=disconnectAfter?setTimeout(()=>controller.abort(),disconnectAfter):null;
 const cancelTimer=cancelAfter?setTimeout(()=>{cancelRequest=post('/api/jobs/'+id+'/cancel').catch(e=>({error:e.message}));},cancelAfter):null;
 try{for await(const bytes of r.body){const now=Date.now();maxGap=Math.max(maxGap,now-last);last=now;chunks++;if(firstDelta===null&&Buffer.from(bytes).toString().includes('index'))firstDelta=now-begin;}}catch(e){if(!controller.signal.aborted)throw e;}
 if(timer)clearTimeout(timer);if(cancelTimer)clearTimeout(cancelTimer);if(cancelRequest)await cancelRequest;
 if(disconnectAfter)await sleep(Math.max(0,steps*interval+8000-(Date.now()-begin)));
 const saved=await get('/api/jobs/'+id);const replay=await post('/api/jobs',{id,scope,steps,interval});assert(replay.replayed===true,'duplicate submission restarted job');
 return {job:saved,elapsed_ms:Date.now()-begin,first_headers_ms:firstHeaders,first_delta_ms:firstDelta,chunks,max_chunk_gap_ms:maxGap};
}
await run('private_access',async()=>{const r=await fetch(base+'/api/status',{redirect:'manual'});assert(r.status!==200,'unauthenticated access unexpectedly allowed');return {unauthenticated_status:r.status};});
await run('bindings',()=>get('/api/status'));
await Promise.all([
 run('two_audio_channels',async()=>({channels:await Promise.all([audio('interviewer'),audio('candidate')])})),
 run('transcript_revisions_and_timeline_boundary',async()=>{
  await Promise.all(['interviewer','candidate'].map(speaker=>post('/api/events',Array.from({length:10},(_,i)=>({scope,id:speaker+'_'+i,revision:1,kind:'transcript',speaker,body:'合成语音 '+speaker+' '+i})))));
  const initial=await get('/api/timeline?scope='+scope);const only=initial.records.filter(x=>x.kind==='transcript');assert(only.length===20,'missing transcript rows');assert(new Set(only.map(x=>x.seq)).size===20,'duplicate sequence');
  const row={scope,id:'interviewer_0',revision:2,kind:'transcript',speaker:'interviewer',body:'人工修正后的最新问题'};await post('/api/events',[row]);await post('/api/events',[{...row,revision:1,body:'迟到的旧文本'}]);
  const update=await get('/api/timeline?scope='+scope+'&cursor='+initial.next_cursor);assert(update.records.filter(x=>x.kind==='transcript').length===1&&update.records.find(x=>x.kind==='transcript').body===row.body,'revision or dedup failed');
  const wrong=await fetch(base+'/api/timeline?scope=another&cursor='+initial.next_cursor,{headers});assert(wrong.status===409,'old timeline cursor accepted');return {transcripts:20,corrections:1,cross_timeline_status:wrong.status};
 }),
 run('image_integrity_and_visibility',async()=>{
  const bytes=png(),sha=digest(bytes);let start=Date.now();const uploads=await Promise.all(['first','second'].map(id=>request('/api/image?scope='+scope+'&id='+id,{method:'POST',headers:{'Content-Type':'image/png'},body:bytes}).then(r=>r.json())));const uploadMs=Date.now()-start;assert(uploads.every(x=>x.hash===sha),'upload hash mismatch');
  const downloaded=Buffer.from(await(await request('/api/image?scope='+scope+'&id=first')).arrayBuffer());assert(digest(downloaded)===sha,'original image changed');assert((await get('/api/response-context?scope='+scope)).length===0,'unsent image entered answer context');
  log('image_original_storage',{pass:true,images:2,bytes_each:bytes.length,sha256:sha,upload_ms:uploadMs,unsent_excluded:true});
  start=Date.now();const rpc=await post('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_interview',arguments:{interview_id:scope}}});const mcpMs=Date.now()-start,images=rpc.result.content.filter(c=>c.type==='image');assert(images.length===2&&images.every(i=>digest(Buffer.from(i.data,'base64'))===sha),'MCP original image mismatch');
  await post('/api/image/state',{scope,id:'first',sent:true,removed:false});assert((await get('/api/response-context?scope='+scope)).length===1,'sent image not exposed');await post('/api/image/state',{scope,id:'second',sent:false,removed:true});const rpc2=await post('/mcp',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'read_interview',arguments:{interview_id:scope}}});assert(rpc2.result.content.filter(c=>c.type==='image').length===1,'removed image exposed');
  return {images:2,bytes_each:bytes.length,sha256:sha,upload_ms:uploadMs,mcp_two_images_ms:mcpMs,mcp_json_bytes:Buffer.byteLength(JSON.stringify(rpc))};
 }),
 run('connected_stream_90s',async()=>{const result=await job('connected',{steps:90});assert(result.job.status==='completed'&&result.job.count===90,'connected stream did not finish');return result;}),
 run('cross_client_cancel',async()=>{const result=await job('cancel',{steps:90,cancelAfter:3000});assert(result.job.status==='cancelled','cancel not effective');return result;}),
 run('disconnected_stream_90s',async()=>{const result=await job('disconnected',{steps:90,disconnectAfter:4000});return {...result,pass:result.job.status==='completed'&&result.job.count===90};}),
 run('detached_task_90s',async()=>{const result=await job('detached',{steps:90,detached:true});return {...result,pass:result.job.status==='completed'&&result.job.count===90};}),
]);
await mkdir('evidence',{recursive:true});const resultFile=input.only?.length?'evidence/storage-results.json':'evidence/results.json';await writeFile(resultFile,JSON.stringify({url:base,scope,started_at:new Date(started).toISOString(),results},null,2));console.log('RESULT_FILE '+resultFile);
process.exit(results.every(x=>x.pass)?0:2);
