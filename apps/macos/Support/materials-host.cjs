const core=require('./electron/materials-host.cjs');
if(require.main===module)core.runStdin();
module.exports=core;
