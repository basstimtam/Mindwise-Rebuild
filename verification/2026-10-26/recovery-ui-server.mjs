// Fault-only loopback launcher. No real AI start, no normal 4316 data.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createStore} from '../../src/store.mjs';
import {createCodexService} from '../../src/codex.mjs';
import {createServer} from '../../src/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');assert.equal(process.cwd(),root);
const fixture=JSON.parse(readFileSync(path.join(root,'verification/2026-10-26/recovery-ui-fixture.json'),'utf8')),file=path.join(root,'verification/2026-10-26/recovery-ui-faults.json');
const records=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):[],store=createStore({root,dataDir:path.join(root,fixture.dataDir)});
const kindFor=id=>fixture.cases.find(c=>c.runId===id)?.kind;
const record=(kind,payload)=>{records.push({at:new Date().toISOString(),kind,request:payload,revision:store.getState().revision,realCodexCalls:0});writeFileSync(file,JSON.stringify(records,null,2)+'\n');};
const once=kind=>!records.some(r=>r.kind===kind);
const injected={...store,recordRun(run){if(kindFor(run.id)==='loss-record'&&run.resultRecovery?.kind==='connect'&&once('terminal-record-failure')){record('terminal-record-failure',{runId:run.id,signature:run.resultRecovery.signature});throw new Error('架空試験：接続受領後、回復記録の保存に失敗');}return store.recordRun(run);}};
const ai=createCodexService({root,store:injected,spawnProcess:()=>{throw new Error('故障専用serverから実Codexを起動しません');}});
const fixtureAi={...ai,start(){throw new Error('架空の回復試験専用画面です。実Codexは呼び出しません');},recoverResult(payload){const result=ai.recoverResult(payload);if(kindFor(payload.runId)==='loss-done'&&once('http500-after-recovery-record')){record('http500-after-recovery-record',payload);throw new Error('架空試験：回復記録の保存後にHTTP500');}return result;}};
const app=await createServer({root,store,ai:fixtureAi,port:4317});console.log(`Recovery UI fault fixture only: ${app.url}`);
let closing=false;const stop=async()=>{if(closing)return;closing=true;await app.close();store.close();process.exit(0);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
