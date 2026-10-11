import test from 'node:test';
import assert from 'node:assert/strict';
import {UploadQueue} from '../../../packages/chat-ui/upload-queue.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
test('three captures queue sequentially and answer waits for every upload',async()=>{
 const pending=[],saved=[],changes=[];
 const q=new UploadQueue(shot=>new Promise(resolve=>pending.push(()=>resolve({id:shot.id}))),image=>saved.push(image.id),(n,e)=>changes.push([n,e]));
 q.add({id:'one'});q.add({id:'two'});q.add({id:'three'});
 let answered=false;const answer=q.wait().then(()=>{answered=true});assert.equal(pending.length,1);assert(!answered);
 pending.shift()();await tick();assert.equal(pending.length,1);assert(!answered);
 pending.shift()();await tick();assert(!answered);pending.shift()();await answer;
 assert.deepEqual(saved,['one','two','three']);assert.deepEqual(changes.at(-1),[0,'']);
});
test('failed upload retains the original and stable id, blocks answer, retries explicitly',async()=>{
 let fail=true;const seen=[];const original={request_id:'fixed',image_data:'original'};
 const q=new UploadQueue(async shot=>{seen.push(shot);if(fail)throw Error('offline');return {id:shot.request_id}},()=>{},()=>{});
 q.add(original);await assert.rejects(q.wait(),/原图已保留/);assert.equal(q.items[0],original);
 await tick();assert.equal(seen.length,1);fail=false;q.retry();await q.wait();assert.equal(seen[1],original);assert.equal(q.items.length,0);
});
