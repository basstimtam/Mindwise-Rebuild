// Actual local API exercise of the explicitly fictional fixture, not a UI test.
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),base='http://127.0.0.1:4316',fixtures=JSON.parse(readFileSync(path.join(root,'verification/2026-10-26/recovery-fixture.json'),'utf8'));
const {token}=await fetch(base+'/api/session').then(r=>r.json());
const send=async(route,payload)=>{const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Mindwise-Token':token},body:JSON.stringify(payload)});return {status:response.status,body:await response.json()};};
const ready=fixtures.cases.find(c=>c.kind==='ready'),missing=fixtures.cases.find(c=>c.kind==='missing'),observed=await send('/api/ai/recovery-preview',{runId:ready.runId});
assert.equal(observed.status,200);
let received;
if(observed.body.status==='done')received={status:200,body:{state:await fetch(base+'/api/state').then(r=>r.json()),run:null},retained:true};
else {
 assert.equal(observed.body.status,'connect');assert.ok(observed.body.files.every(f=>f.status==='matched'));assert.equal(observed.body.fixture,true);
 const payload={runId:ready.runId,baseRevision:observed.body.baseRevision,signature:observed.body.signature};
 received=await send('/api/ai/recover',payload);assert.equal(received.status,200);assert.equal(received.body.run.status,'completed');
 const retry=await send('/api/ai/recover',payload);assert.equal(retry.status,200);assert.equal(retry.body.state.revision,received.body.state.revision);
}
assert.equal(received.body.state.nodes.filter(n=>n.id===ready.expectedChildId).length,1);
const held=await send('/api/ai/recovery-preview',{runId:missing.runId});assert.equal(held.body.status,'held');
const refused=await send('/api/ai/recover',{runId:missing.runId,baseRevision:held.body.baseRevision,signature:held.body.signature});assert.equal(refused.status,409);
const final=await fetch(base+'/api/state').then(r=>r.json());assert.equal(final.revision,received.body.state.revision);
writeFileSync(path.join(root,'verification/2026-10-26/recovery-api.json'),JSON.stringify({at:new Date().toISOString(),method:'actual local HTTP API; browser disabled in Work settings',fixture:true,realCodexCalls:0,ready:{runId:ready.runId,preview:observed.body,receivedStatus:received.status,retained:received.retained||false,revision:final.revision,receiptCount:final.history.filter(h=>h.operationId===`ai-${ready.runId}`).length,children:final.nodes.filter(n=>n.parentId===ready.targetId)},missing:{runId:missing.runId,preview:held.body,refusedStatus:refused.status,error:refused.body},uiVerified:false},null,2)+'\n');
console.log(JSON.stringify({revision:final.revision,ready:'connected once',missing:'held; HTTP 409',realCodexCalls:0,uiVerified:false}));
