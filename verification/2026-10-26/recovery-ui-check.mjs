// Independent HTTP/model/byte checks; preview only, never applies recovery.
import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),stage=process.argv[2],file=path.join(root,'verification/2026-10-26/recovery-ui-workflow.json');
assert.equal(process.cwd(),root);
const stages=['before','connected','record-only','loss-record','record-repaired','loss-done','restarted','final'],index=stages.indexOf(stage);assert.ok(index>=0);
const fixture=JSON.parse(readFileSync(path.join(root,'verification/2026-10-26/recovery-ui-fixture.json'),'utf8')),base='http://127.0.0.1:4317';
const get=async(url)=>{const r=await fetch(url);assert.equal(r.status,200,url);return r.json();},state=await get(base+'/api/state'),{token}=await get(base+'/api/session'),analysis=await get(base+'/api/analysis'),cases=[];
assert.equal(state.revision,[4,5,5,6,6,7,7,7][index]);assert.equal(state.nodes.length,[4,5,5,6,6,7,7,7][index]);assert.equal(state.runs.length,4);
for(const c of fixture.cases) {
 const run=state.runs.find(r=>r.id===c.runId),node=state.nodes.find(n=>n.id===c.targetId),children=state.nodes.filter(n=>n.parentId===c.targetId),receipts=state.history.filter(h=>h.operationId===`ai-${c.runId}`);
 const response=await fetch(base+'/api/ai/recovery-preview',{method:'POST',headers:{'Content-Type':'application/json','X-Mindwise-Token':token},body:JSON.stringify({runId:c.runId})});assert.equal(response.status,200);const preview=await response.json();
 assert.ok(run.fixture);assert.ok(!run.threadId&&!run.turnId);assert.equal(node.verified,false);assert.notEqual(analysis.verificationById[node.id].status,'verified');assert.ok(preview.files.every(f=>f.status==='matched'));
 const observations=c.files.map(a=>{const actual=path.join(root,a.path),bytes=readFileSync(actual),observed={path:a.path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mtimeMs:statSync(actual).mtimeMs};assert.equal(observed.bytes,a.bytes);assert.equal(observed.sha256,a.sha256);assert.equal(observed.mtimeMs,a.mtimeMs);return observed;});
 if(c.kind==='record-only') {
  assert.deepEqual(node,fixture.initialNodes.find(n=>n.id===c.targetId),'Record-only recovery must preserve the whole later-edited target');assert.equal(children.length,0);assert.equal(receipts.length,1);assert.equal(Boolean(receipts[0].undone),true);assert.equal(preview.modelReceipt.revision,c.originalReceiptRevision);assert.equal(preview.modelReceipt.undone,true);assert.equal(preview.modelReceipt.laterChanges,true);
  assert.equal(preview.status,index>=2?'done':'record-only');assert.equal(run.status,index>=2?'reconciled':'interrupted');
 }else {
  const connected=index>=(c.kind==='connect'?1:c.kind==='loss-record'?3:5),finished=index>=(c.kind==='connect'?1:c.kind==='loss-record'?4:5);
  assert.equal(children.length,connected?1:0);assert.equal(receipts.length,connected?1:0);assert.equal(node.artifact,connected?c.files[0].path:'');assert.equal(node.body,connected?c.expectedBody:fixture.initialNodes.find(n=>n.id===c.targetId).body);
  if(connected)assert.equal(children[0].id,c.expectedChildId);
  assert.equal(preview.status,finished?'done':connected?'record-only':'connect');assert.equal(run.status,finished?(c.kind==='loss-record'?'reconciled':'completed'):'interrupted');
 }
 cases.push({kind:c.kind,node,children,run,receipts,preview,observations});
}
const main=await get('http://127.0.0.1:4316/api/state'),mainAnalysis=await get('http://127.0.0.1:4316/api/analysis'),contracts=await get('http://127.0.0.1:4316/api/contracts');
assert.equal(main.revision,48);assert.equal(main.nodes.length,14);assert.equal(mainAnalysis.numbers.byId['fa2f7bcf-ef72-4b39-af97-9c68b0c25e84'].value,4800);assert.equal(contracts.status,'approved');
const artifact='artifacts/3fcbed02-3e29-47de-b396-b5a2252ecb1d/numbers-check.md',mainHash=createHash('sha256').update(readFileSync(path.join(root,artifact))).digest('hex');assert.equal(mainHash,'8cd9650051d851cb3f8c3fd270fa78c5a0b6269bd895b3daee37608ae8869edf');assert.ok(!existsSync(path.join(root,'artifacts/42125fa8-e54c-4138-967e-700448d74153/missing-check.md')));
const record=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{fixture:true,realCodexCalls:0,stages:[]};
if(record.stages.length)for(const c of cases)assert.equal(c.run.error,record.stages[0].cases.find(initial=>initial.kind===c.kind).run.error,'Previous error remains in durable history');
record.stages.push({stage,at:new Date().toISOString(),revision:state.revision,history:state.history,cases,main:{revision:main.revision,nodes:main.nodes.length,value:4800,artifact,sha256:mainHash,contracts:contracts.status},sourceHashes:Object.fromEntries(['src/codex.mjs','src/server.mjs','public/recovery.js','public/app.js'].map(name=>[name,createHash('sha256').update(readFileSync(path.join(root,name))).digest('hex')]))});
writeFileSync(file,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({stage,revision:state.revision,cases:cases.map(c=>({kind:c.kind,status:c.preview.status,children:c.children.length,receipts:c.receipts.length})),assertions:'passed',realCodexCalls:0}));
