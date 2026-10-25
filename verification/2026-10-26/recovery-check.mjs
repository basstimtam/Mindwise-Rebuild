// Read model, recovery preview and actual fixture bytes; never applies recovery.
import {readFileSync,writeFileSync,existsSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),file=path.join(root,'verification/2026-10-26/recovery-workflow.json'),base='http://127.0.0.1:4316',stage=process.argv[2];
assert.ok(['before','connected','restart'].includes(stage));
const fixtures=JSON.parse(readFileSync(path.join(root,'verification/2026-10-26/recovery-fixture.json'),'utf8'));
const get=async p=>{const r=await fetch(base+p);assert.equal(r.status,200,p);return r.json();};
const {token}=await get('/api/session'),state=await get('/api/state'),analysis=await get('/api/analysis'),catalog=await get('/api/contracts');
const record=existsSync(file)?JSON.parse(readFileSync(file,'utf8')):{fixture:true,realCodexCalls:0,expectations:{completeFiles:'Connect saved result once, without rewriting bytes',missingFiles:'Hold without file creation or model change',acceptance:'No passed owner acceptance'},stages:[]},cases=[];
for(const fixture of fixtures.cases) {
 const response=await fetch(base+'/api/ai/recovery-preview',{method:'POST',headers:{'Content-Type':'application/json','X-Mindwise-Token':token},body:JSON.stringify({runId:fixture.runId})});assert.equal(response.status,200);
 const preview=await response.json(),node=state.nodes.find(n=>n.id===fixture.targetId),run=state.runs.find(r=>r.id===fixture.runId),children=state.nodes.filter(n=>n.parentId===fixture.targetId),receipts=state.history.filter(h=>h.operationId===`ai-${fixture.runId}`);
 assert.ok(run.fixture);assert.ok(!run.threadId);assert.equal(node.verified,false);assert.notEqual(analysis.verificationById[node.id].status,'verified');
 const observations=fixture.expectedArtifacts.map(a=>{const full=path.join(root,a.path);return {path:a.path,exists:existsSync(full),sha256:existsSync(full)?createHash('sha256').update(readFileSync(full)).digest('hex'):null,mtimeMs:existsSync(full)?statSync(full).mtimeMs:null};});
 assert.equal(observations[0].sha256,fixture.expectedArtifacts[0].sha256);
 if(fixture.kind==='missing') {assert.equal(preview.status,'held');assert.equal(preview.files[1].status,'missing');assert.equal(observations[1].exists,false);assert.equal(node.artifact,'');assert.equal(children.length,0);assert.equal(receipts.length,0);}
 else if(stage==='before'){assert.equal(preview.status,'connect');assert.equal(node.artifact,'');assert.equal(children.length,0);assert.equal(receipts.length,0);}
 else {assert.equal(run.status,'completed');assert.equal(run.resultRecovery.kind,'connect');assert.equal(preview.status,'done');assert.equal(node.artifact,fixture.expectedArtifacts[0].path);assert.equal(children.length,1);assert.equal(children[0].id,fixture.expectedChildId);assert.equal(receipts.length,1);const artifact=await get('/api/artifact?nodeId='+fixture.targetId);assert.equal(artifact.sha256,fixture.expectedArtifacts[0].sha256);assert.ok(artifact.text.includes('実Codexの制作ではありません'));}
 if(record.stages.length)for(const observed of observations){const initial=record.stages[0].cases.find(c=>c.kind===fixture.kind).observations.find(o=>o.path===observed.path);assert.deepEqual(observed,initial,'Recovery must not rewrite or create any fixture file');}
 cases.push({kind:fixture.kind,target:{id:node.id,version:node.version,title:node.title,artifact:node.artifact,verified:node.verified},run:{id:run.id,status:run.status,fixture:run.fixture,recovery:run.recovery,resultRecovery:run.resultRecovery},preview,children,receipts,observations});
}
assert.equal(analysis.numbers.byId['fa2f7bcf-ef72-4b39-af97-9c68b0c25e84'].value,4800);assert.equal(catalog.status,'approved');
record.stages.push({stage,at:new Date().toISOString(),revision:state.revision,cases,contractStatus:catalog.status,sourceHashes:Object.fromEntries(['src/codex.mjs','src/server.mjs','public/app.js','public/recovery.js','public/index.html','public/style.css'].map(name=>[name,createHash('sha256').update(readFileSync(path.join(root,name))).digest('hex')]))});
writeFileSync(file,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({stage,revision:state.revision,cases:cases.map(c=>({kind:c.kind,status:c.preview.status,children:c.children.length,receipts:c.receipts.length})),assertions:'passed',realCodexCalls:0}));
