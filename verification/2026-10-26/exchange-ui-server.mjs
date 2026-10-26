// One response-loss fault in an isolated fictional model, after durable commit.
// Never use this launcher for the normal 4316 model. No Codex call is made.
import {createStore} from '../../src/store.mjs';
import {createServer} from '../../src/server.mjs';
import {resolve} from 'node:path';
import {writeFileSync,readFileSync} from 'node:fs';
const root=process.cwd(),store=createStore({root,dataDir:resolve(root,'.runtime/exchange-workflow')}),original=store.importState;
let failOnce=true;
store.importState=payload=>{const result=original(payload);if(failOnce){failOnce=false;const path=resolve(root,'verification/2026-10-26/exchange-response-loss.json');let records=[];try{const previous=JSON.parse(readFileSync(path,'utf8'));records=Array.isArray(previous)?previous:[previous];}catch{}records.push({at:new Date().toISOString(),kind:'fictional-http500-after-import-commit',revision:result.revision,operationId:payload.operationId,actualCodexCalls:0});writeFileSync(path,JSON.stringify(records,null,2));throw new Error('架空の応答途絶試験：保存後にHTTP500');}return result;};
const app=await createServer({root,store,port:4317});console.log(`Fault fixture only: ${app.url}`);
process.once('SIGINT',async()=>{await app.close();store.close();process.exit(0);});
