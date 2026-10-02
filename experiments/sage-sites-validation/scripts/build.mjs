import {mkdir,copyFile,cp,readFile} from 'node:fs/promises';
await mkdir('dist/server',{recursive:true});
await mkdir('dist/.openai',{recursive:true});
await copyFile('worker/runtime.js','dist/server/index.js');
await copyFile('.openai/hosting.json','dist/.openai/hosting.json');
await cp('drizzle','dist/drizzle',{recursive:true});
console.log('Built Worker + reviewed schema migrations');
