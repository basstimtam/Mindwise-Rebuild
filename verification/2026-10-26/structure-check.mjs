// Read-only assertions after actual UI actions. This script never submits mutations.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const base='http://127.0.0.1:4316', targetId='fa2f7bcf-ef72-4b39-af97-9c68b0c25e84';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const output=resolve(root,'verification/2026-10-26/structure-workflow.json');
const stage=process.argv[2];
assert.ok(stage,'A named observed stage is required');
const get=async path=>{const r=await fetch(base+path);assert.equal(r.status,200,path);return r.json();};
const state=await get('/api/state'),analysis=await get('/api/analysis');
const target=state.nodes.find(n=>n.id===targetId),note=state.nodes.find(n=>n.title==='構造試験：資料メモ');
assert.ok(note,'The UI-created note must retain its identity');
const record=existsSync(output)?JSON.parse(readFileSync(output,'utf8')):{checkpoint:'e53e0c9',fictional:true,expected:{value:4800,unit:'円',formula:'hours * rate',taskStatus:'active',taskProgress:40,artifactHash:'8cd9650051d851cb3f8c3fd270fa78c5a0b6269bd895b3daee37608ae8869edf'},stages:[]};
const baseline=record.stages[0];
if(baseline)assert.equal(note.id,baseline.note.id,'Do not replace a removed/restored object with a new ID');
const links=state.links.filter(l=>[targetId,note.id].includes(l.from)||[targetId,note.id].includes(l.to));
const provenance=target?await get('/api/provenance?targetId='+targetId):null;
if(target){
  for(const key of ['body','formula','kind','status','progress','artifact','metricInputs','metricSource','sourceRefs'])
    if(baseline)assert.deepEqual(target[key],key==='body'&&stage==='draft-saved'?baseline.target.body+'\n削除と取消を越えて保持する未保存入力。':baseline.target[key],key+' must survive structural edits');
  assert.equal(target.kind,'task');assert.equal(target.status,'active');assert.equal(target.progress,40);
  assert.equal(analysis.numbers.byId[targetId].value,4800);
  assert.equal(analysis.numbers.byId[targetId].status,'calculated');
  const targetAnalysis=await get('/api/analysis?targetId='+targetId);
  assert.deepEqual(targetAnalysis.specification.effective,[],'Display hierarchy must not inherit shared clothing settings');
  const artifact=await get('/api/artifact?nodeId='+targetId);
  assert.equal(artifact.sha256,record.expected.artifactHash);
  assert.equal(createHash('sha256').update(readFileSync(resolve(root,target.artifact))).digest('hex'),artifact.sha256);
  assert.ok(provenance.runs.some(r=>r.id==='3fcbed02-3e29-47de-b396-b5a2252ecb1d'&&r.status==='completed'));
}
assert.equal(note.body,'架空短編の構造試験資料。親の数値タスクと結び直しても、この本文とIDを保持する。');
if(stage==='detached')assert.equal(target.parentId,null);
if(['reparented','linked','unlinked'].includes(stage))assert.equal(target.parentId,'shared');
if(stage==='linked')assert.ok(links.some(l=>l.from===targetId&&l.to===note.id&&l.type==='relates_to'));
if(stage==='unlinked')assert.equal(links.length,0);
if(stage==='deleted'){assert.equal(target,undefined);assert.equal(note.parentId,null);assert.equal(links.length,0);}
if(['restored','restart','completed'].includes(stage)){
  assert.equal(target.parentId,'shared');assert.equal(note.parentId,targetId);
  assert.ok(links.some(l=>l.from===targetId&&l.to===note.id&&l.type==='relates_to'));
}
const preservedRun=state.runs.find(r=>r.id==='3fcbed02-3e29-47de-b396-b5a2252ecb1d');
assert.equal(preservedRun.status,'completed');assert.equal(preservedRun.targetId,targetId);
if(['completed','restart'].includes(stage)) {
 const contracts=await get('/api/contracts');assert.equal(contracts.status,'approved');
 record.completion={at:new Date().toISOString(),stage,revision:state.revision,scope:'Actual UI deletion, retained orphan, undo with original ID and draft, draft save and trial text undo, source note and provenance and artifact navigation',uiEvidence:'verification/2026-10-26/structure-completion-ui.json',contractStatus:contracts.status,value:analysis.numbers.byId[targetId].value,artifactHash:record.expected.artifactHash,sourceHashes:Object.fromEntries(['public/app.js','public/editing.js','public/index.html','public/style.css','src/store.mjs','src/semantics.mjs','src/numbers.mjs','src/number-links.mjs'].map(path=>[path,createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')]))};
}
if(stage==='checkpoint-restart') {
 const contracts=await get('/api/contracts');assert.equal(contracts.status,'approved');
 record.checkpointCheck={at:new Date().toISOString(),revision:state.revision,contractStatus:contracts.status,sourceHashes:Object.fromEntries(['public/app.js','public/editing.js','public/index.html','public/style.css','src/store.mjs','src/semantics.mjs','src/numbers.mjs','src/number-links.mjs'].map(path=>[path,createHash('sha256').update(readFileSync(resolve(root,path))).digest('hex')])),uiRemaining:['Delete and undo with retained draft','Final artifact and history navigation after restoration'],note:'The saved model survived final server restart. This is not an actual UI deletion/undo observation.'};
}
record.stages.push({stage,at:new Date().toISOString(),revision:state.revision,target:target||null,note,links,numbers:target?analysis.numbers.byId[targetId]:null,history:state.history,provenance,preservedRun:{id:preservedRun.id,targetId:preservedRun.targetId,targetVersion:preservedRun.targetVersion,status:preservedRun.status,artifacts:preservedRun.artifacts}});
writeFileSync(output,JSON.stringify(record,null,2)+'\n');
console.log(JSON.stringify({stage,revision:state.revision,target:target?.id||'deleted',note:note.id,value:analysis.numbers.byId[targetId]?.value,assertions:'passed'}));
