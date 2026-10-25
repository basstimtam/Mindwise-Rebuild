import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';
import { readNodeArtifact, evaluateVerification } from '../src/artifacts.mjs';
import { resolveSpecifications } from '../src/semantics.mjs';

function fixture(t,{deferCleanup=false}={}) {
  const container=mkdtempSync(join(tmpdir(),'mindwise-review-')), root=join(container,'project');
  mkdirSync(join(root,'work'),{recursive:true});
  writeFileSync(join(root,'work','main.md'),'ユイの緑の灯台');
  if(!deferCleanup)t.after(()=>rmSync(container,{recursive:true,force:true}));
  return {root,container};
}
function proof(root,state,node) {
  return {artifact:node.artifact,artifactHash:readNodeArtifact(root,node).sha256,criteria:node.criteria,specHash:resolveSpecifications(state,node.id).fingerprint,method:'owner-review',result:'passed',at:new Date().toISOString(),targetVersion:node.version};
}
test('verification follows live artifact, acceptance criteria and effective specs, independent of layout/version changes',t=>{
  const {root}=fixture(t), node={id:'a',version:1,artifact:'work/main.md',criteria:'ユイが登場する',specs:[{key:'名前',value:'ユイ'}]}, state={nodes:[node],links:[]};
  assert.equal(evaluateVerification(root,state,node).status,'unverified');
  node.verified=proof(root,state,node);
  assert.equal(evaluateVerification(root,state,node).status,'verified');
  node.version=7;node.x=123;assert.equal(evaluateVerification(root,state,node).status,'verified');
  node.criteria='緑の灯台が登場する';assert.equal(evaluateVerification(root,state,node).status,'stale');node.criteria='ユイが登場する';
  node.specs[0].value='ミナ';assert.equal(evaluateVerification(root,state,node).status,'stale');node.specs[0].value='ユイ';
  writeFileSync(join(root,'work','main.md'),'保存後の変更');assert.equal(evaluateVerification(root,state,node).status,'stale');
  node.artifact='work/missing.md';assert.equal(evaluateVerification(root,state,node).status,'missing');
});

test('declared artifact reads refuse outside roots, escaping links, binary types and excessive data',t=>{
  const {root,container}=fixture(t), outside=join(container,'outside');mkdirSync(outside);
  writeFileSync(join(outside,'secret.md'),'outside fixture');
  assert.throws(()=>readNodeArtifact(root,{artifact:join(outside,'secret.md')}),/範囲外/);
  assert.throws(()=>readNodeArtifact(root,{artifact:'../outside/secret.md'}),/範囲外/);
  symlinkSync(outside,join(root,'linked'),'junction');
  assert.throws(()=>readNodeArtifact(root,{artifact:'linked/secret.md'}),/リンク先/);
  writeFileSync(join(root,'work','binary.sqlite'),'not a text artifact');
  assert.throws(()=>readNodeArtifact(root,{artifact:'work/binary.sqlite'}),/テキスト/);
  writeFileSync(join(root,'work','large.md'),Buffer.alloc(2*1024*1024+1));
  assert.throws(()=>readNodeArtifact(root,{artifact:'work/large.md'}),/2MiB/);
});

async function httpFixture(t) {
  const {root,container}=fixture(t,{deferCleanup:true}), store=createStore({root,dataDir:join(root,'data')});
  const ai={status:()=>({}),events:()=>({}),close:()=>{}};
  const app=await createServer({root,store,ai,port:0});
  t.after(async()=>{try{await app.close();}finally{store.close();rmSync(container,{recursive:true,force:true});}});
  const get=async endpoint=>{const r=await fetch(app.url+endpoint);return {status:r.status,body:await r.json()};};
  const {body:session}=await get('/api/session');
  const post=async(endpoint,payload)=>{
    const r=await fetch(app.url+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Mindwise-Token':session.token},body:JSON.stringify(payload)});
    return {status:r.status,body:await r.json()};
  };
  const seed=await post('/api/change',{baseRevision:0,operationId:'seed',ops:[
    {type:'add',node:{id:'common',title:'共通設定',specs:[{key:'名前',value:'ユイ'}]}},
    {type:'add',node:{id:'a',title:'主人公紹介',domain:'物語',required:true,weight:2,artifact:'work/main.md',criteria:'ユイが登場する'}},
    {type:'add',node:{id:'alias',title:'UI側の同じ成果',domain:'UI',required:true,weight:2,artifact:join(root,'work','main.md'),criteria:'ユイが登場する'}},
    {type:'add',node:{id:'unexplored',title:'未具体化',domain:'未探索'}},
    {type:'link',link:{id:'common-a',from:'common',to:'a',type:'applies_to'}},
    {type:'link',link:{id:'common-alias',from:'common',to:'alias',type:'applies_to'}}
  ]});
  assert.equal(seed.status,200);
  const confirmation=(view,operationId)=>({baseRevision:view.revision,operationId,targetId:view.targetId,targetVersion:view.targetVersion,artifactHash:view.sha256,criteria:view.criteria,method:'owner-review',result:'passed'});
  return {root,store,app,get,post,confirmation};
}

test('HTTP review binds viewed version/hash/criteria, persists once on retry, and counts shared artifacts once',async t=>{
  const f=await httpFixture(t);
  const preview=await f.post('/api/preview',{baseRevision:1,operationId:'preview-only',ops:[{type:'update',id:'common',patch:{specs:[{key:'名前',value:'ミナ'}]}}]});
  assert.equal(preview.status,200);assert.ok(preview.body.impact.affected.includes('a'));assert.equal(f.store.getState().revision,1);
  const {body:view}=await f.get('/api/artifact?nodeId=a');
  assert.equal(view.targetVersion,1);assert.equal(view.revision,1);assert.equal(view.text,'ユイの緑の灯台');
  assert.equal((await f.post('/api/verify',{...f.confirmation(view,'bad-hash'),artifactHash:'0'.repeat(64)})).status,409);
  assert.equal((await f.post('/api/verify',{...f.confirmation(view,'old-version'),targetVersion:2})).status,409);
  assert.equal((await f.post('/api/verify',{...f.confirmation(view,'old-criteria'),criteria:'別条件'})).status,409);
  const input=f.confirmation(view,'review-a'), first=await f.post('/api/verify',input);
  assert.equal(first.status,200);assert.equal(first.body.revision,2);
  assert.equal((await f.post('/api/verify',input)).body.revision,2);
  assert.equal((await f.post('/api/verify',{...input,note:'異なる再送'})).status,409);
  const {body:aliasView}=await f.get('/api/artifact?nodeId=alias');
  assert.equal((await f.post('/api/verify',f.confirmation(aliasView,'review-alias'))).status,200);
  const {body:analysis}=await f.get('/api/analysis?targetId=a');
  assert.equal(analysis.verificationById.a.status,'verified');assert.equal(analysis.verificationById.alias.status,'verified');
  assert.equal(analysis.progress.groups.length,1);assert.equal(analysis.progress.knownWeight,2);assert.equal(analysis.progress.verifiedWeight,2);
  assert.ok(analysis.progress.unestimatedDomains.includes('未探索'));
  const beforeLayout=f.store.getState();
  assert.equal((await f.post('/api/change',{baseRevision:beforeLayout.revision,operationId:'layout-only',ops:[{type:'update',id:'a',patch:{x:250}}]})).status,200);
  assert.equal((await f.post('/api/change',{baseRevision:beforeLayout.revision+1,operationId:'undo-layout',ops:[{type:'undo'}]})).status,200);
  const afterUndo=(await f.get('/api/analysis?targetId=a')).body;
  assert.equal(afterUndo.verificationById.a.status,'verified');assert.equal(afterUndo.verificationById.alias.status,'verified');assert.equal(afterUndo.progress.verifiedWeight,2);
  writeFileSync(join(f.root,'work','main.md'),'保存後に変わった現物');
  const {body:changed}=await f.get('/api/analysis?targetId=a');
  assert.equal(changed.verificationById.a.status,'stale');assert.equal(changed.progress.verifiedWeight,0);
  const revision=f.store.getState().revision;assert.equal((await f.post('/api/verify',input)).body.revision,revision);
  assert.equal((await f.get('/api/analysis?targetId=a')).body.verificationById.a.status,'stale');
  rmSync(join(f.root,'work','main.md'));
  const {body:missing}=await f.get('/api/analysis?targetId=a');
  assert.equal(missing.verificationById.a.status,'missing');assert.equal(missing.progress.groups.length,1);assert.equal(missing.progress.knownWeight,2);
});

test('HTTP review refuses unresolved specifications and does not affect unrelated targets',async t=>{
  const f=await httpFixture(t), before=f.store.getState();
  assert.equal((await f.post('/api/change',{baseRevision:before.revision,operationId:'conflict',ops:[
    {type:'add',node:{id:'other',title:'競合する設定',specs:[{key:'名前',value:'ミナ'}]}},
    {type:'link',link:{id:'other-a',from:'other',to:'a',type:'applies_to'}}
  ]})).status,200);
  const {body:view}=await f.get('/api/artifact?nodeId=a');assert.equal(view.specificationStatus,'conflict');
  assert.equal((await f.post('/api/verify',f.confirmation(view,'must-not-verify'))).status,409);
  const {body:analysis}=await f.get('/api/analysis?targetId=alias');
  assert.equal(analysis.specification.status,'resolved');assert.equal(analysis.verificationById.a.status,'conflict');
  assert.equal(f.store.getState().nodes.find(n=>n.id==='a').verified,false);
});
