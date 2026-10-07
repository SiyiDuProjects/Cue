// Only reads a document after a verified Sites MCP request; no local model runtime.
const path = require('node:path');
const fs = require('node:fs');
const { Materials } = require('./materials.cjs');
class MaterialsHost {
  constructor(config, { fetcher = fetch, interval = 800 } = {}) {
    const origin = new URL(config.apiBaseUrl);
    if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash ||
        !(origin.protocol === 'https:' || origin.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(origin.hostname)) ||
        [config.siteToken,config.captureToken].some(x=>typeof x!=='string'||!x||/[\r\n]/.test(x)) || typeof config.dataRoot!=='string' || !path.isAbsolute(config.dataRoot)) throw Error('Invalid materials connection');
    this.origin = origin.origin; this.fetch = fetcher; this.interval = interval; this.closed = false;
    this.headers = { 'OAI-Sites-Authorization': 'Bearer '+config.siteToken, Authorization: 'Bearer '+config.captureToken, 'Content-Type':'application/json' };
    const workspace=config.workspace||path.join(config.dataRoot,'assistant-workspace');
    if(!path.isAbsolute(workspace))throw Error('Invalid materials directory');
    fs.mkdirSync(path.join(workspace,'materials'),{recursive:true,mode:0o700});
    this.materials = new Materials(workspace); this.controller = new AbortController();
    void this.run();
  }
  async request(endpoint, body) {
    const response = await this.fetch(this.origin+endpoint, { method:body?'POST':'GET',headers:this.headers,
      ...(body?{body:JSON.stringify(body)}:{}), redirect:'error',signal:AbortSignal.any([this.controller.signal,AbortSignal.timeout(8000)]) });
    if (!response.ok) throw Error('Materials service unavailable');
    return response.json();
  }
  async run() {
    while (!this.closed) {
      try {
        const {jobs=[]}=await this.request('/capture/materials');
        if (this.closed) return;
        await Promise.all(jobs.slice(0,8).map(async job=>{
          if (typeof job.id!=='string' || !/^[\w-]{1,100}$/.test(job.id)) return;
          let result;
          try {
            const request=JSON.parse(job.request);
            if (!['list_materials','read_material'].includes(request.name)) throw Error('Unsupported request');
            result=await this.materials.call(request.name,request.arguments??{});
          } catch { result={error:'资料读取失败，请检查目录、路径、版本和 UTF-8 格式。'}; }
          if (!this.closed) await this.request('/capture/materials/'+job.id,result);
        }));
      } catch { /* Reconnect transport only; never invent or replay a model request. */ }
      if (!this.closed) await new Promise(resolve=>{this.wake=resolve;this.timer=setTimeout(resolve,this.interval);});
    }
  }
  close(){this.closed=true;this.controller.abort();clearTimeout(this.timer);this.wake?.();}
}
function runStdin(){
  const input=require('node:readline').createInterface({input:process.stdin});let host;
  input.once('line',line=>{try{host=new MaterialsHost(JSON.parse(line));}catch{process.exitCode=1;input.close();}});
  const close=()=>{host?.close();process.exit(process.exitCode||0);};input.on('close',close);process.on('SIGTERM',close);process.on('SIGINT',close);
}
if(require.main===module)runStdin();
module.exports={MaterialsHost,runStdin};
