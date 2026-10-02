const {test} = require('node:test');
const assert = require('node:assert/strict');
const {activityFor} = require('./codex-activity.cjs');
test('operation display excludes commands, arguments, outputs and reasoning', () => {
  const item={id:'read',type:'commandExecution',command:'SECRET_COMMAND',aggregatedOutput:'PRIVATE_OUTPUT',
    commandActions:[{type:'read',path:'C:/private/materials/resume.txt'}]};
  assert.deepEqual(activityFor(item,false),{id:'read',kind:'command',label:'读取 resume.txt',status:'running'});
  assert.equal(activityFor({...item,exitCode:1},true).status,'failed');
  assert.equal(activityFor({id:'reasoning',type:'reasoning',summary:['SECRET']},true),null);
  assert.equal(activityFor({id:'old',type:'dynamicToolCall',tool:'update_code'},true),null);
});
