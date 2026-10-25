import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';

function fixture(t) { const root=mkdtempSync(join(tmpdir(),'mindwise-test-')); const dataDir=join(root,'data'); const store=createStore({root,dataDir}); t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});}); return {root,dataDir,store}; }
function apply(store,ops,operationId=crypto.randomUUID()) { return store.change({baseRevision:store.getState().revision,operationId,ops}); }
test('atomic batch, version conflict and payload-bound idempotency',t=>{
  const {store}=fixture(t);
  const payload={baseRevision:0,operationId:'one',ops:[{type:'add',node:{id:'a',title:'A'}}]};
  store.change(payload); store.change(payload); assert.equal(store.getState().revision,1);
  assert.throws(()=>store.change({...payload,ops:[{type:'add',node:{id:'b'}}]}),/同じ操作ID/);
  assert.throws(()=>store.change({...payload,operationId:'stale'}),/別の変更/);
  assert.throws(()=>apply(store,[{type:'add',node:{id:'b'}},{type:'update',id:'missing',patch:{title:'bad'}}]),/枝がありません/);
  assert.deepEqual(store.getState().nodes.map(n=>n.id),['a']); assert.equal(store.getState().revision,1);
});
test('detach/delete preserves children and undo restores graph without undoing runs',t=>{
  const {store}=fixture(t); apply(store,[{type:'add',node:{id:'a'}},{type:'add',node:{id:'b',parentId:'a'}},{type:'link',link:{id:'l',from:'a',to:'b',type:'related'}}]);
  apply(store,[{type:'delete',id:'a'}]); assert.equal(store.getState().nodes[0].parentId,null); assert.equal(store.getState().links.length,0);
  store.recordRun({id:'r',nodeId:'b',status:'completed'});
  apply(store,[{type:'undo'}]); assert.equal(store.getState().nodes.length,2); assert.equal(store.getState().links.length,1); assert.equal(store.getState().runs[0].status,'completed');
  assert.throws(()=>apply(store,[{type:'update',id:'a',patch:{parentId:'b'}}]),/循環/);
});
test('explicit dependencies invalidate verified evidence, display changes do not',t=>{
  const {store}=fixture(t); apply(store,[{type:'add',node:{id:'a'}},{type:'add',node:{id:'b',artifact:'work/a.txt',criteria:'exists'}},{type:'link',link:{id:'l',from:'a',to:'b',type:'depends'}}]);
  assert.throws(()=>apply(store,[{type:'update',id:'b',patch:{verified:true}}]),/確認済み/);
  const proof={artifactHash:'a'.repeat(64),criteria:'exists',method:'test',result:'passed',at:new Date().toISOString()};
  apply(store,[{type:'update',id:'b',patch:{verified:proof}}]); apply(store,[{type:'update',id:'b',patch:{x:80}}]); assert.ok(store.getState().nodes.find(n=>n.id==='b').verified);
  apply(store,[{type:'update',id:'a',patch:{body:'new spec'}}]);assert.equal(store.getState().nodes.find(n=>n.id==='b').verified,false);
});
test('backup restores dedup/history and interrupted run is not rerun',t=>{
  const {store,root}=fixture(t); const payload={baseRevision:0,operationId:'one',ops:[{type:'add',node:{id:'a'}}]};store.change(payload);store.recordRun({id:'r',nodeId:'a',targetVersion:1,status:'running'});
  store.recordRun({id:'connecting',status:'connecting'});store.recordRun({id:'applying',status:'applying',artifacts:[{path:'already-written.md'}]});
  const backup=store.backup();const restoreDir=join(root,'restore');mkdirSync(restoreDir);copyFileSync(backup.path,join(restoreDir,'mindwise.sqlite'));
  const restored=createStore({root,dataDir:restoreDir});try{assert.ok(restored.getState().runs.every(r=>r.status==='interrupted'));assert.equal(restored.getState().runs[2].artifacts[0].path,'already-written.md');assert.equal(restored.getState().history.length,1);restored.change(payload);assert.equal(restored.getState().revision,1);}finally{restored.close();}
});
test('import rejects unknown shape, duplicate IDs, and strips foreign verification',t=>{
  const {store}=fixture(t);const state={schemaVersion:1,nodes:[{id:'a'}],links:[]};
  assert.throws(()=>store.importState({baseRevision:0,operationId:'i',state:{...state,bogus:3}}),/未対応/);
  assert.throws(()=>store.importState({baseRevision:0,operationId:'j',state:{...state,nodes:[{id:'a'},{id:'a'}]}}),/重複/);
  store.importState({baseRevision:0,operationId:'k',state});assert.equal(store.getState().nodes.length,1);
});
test('loopback API rejects cross-origin and missing token writes',async t=>{
  const {store,root}=fixture(t);const ai={status:()=>({connected:false}),events:()=>[],start:()=>({}),interrupt:()=>({}),close:()=>{}};
  const app=await createServer({root,store,ai,port:0});t.after(()=>app.close());
  const session=await fetch(app.url+'/api/session').then(r=>r.json());assert.ok(session.token);
  const payload={baseRevision:0,operationId:'http',ops:[{type:'add',node:{id:'a'}}]};
  const options={method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)};
  assert.equal((await fetch(app.url+'/api/change',options)).status,403);
  assert.equal((await fetch(app.url+'/api/change',{...options,headers:{...options.headers,'X-Mindwise-Token':session.token,Origin:'https://evil.example'}})).status,403);
  assert.equal((await fetch(app.url+'/api/change',{...options,headers:{...options.headers,'X-Mindwise-Token':session.token}})).status,200);
  const exported=await fetch(app.url+'/api/export').then(r=>r.json());
  const imported=await fetch(app.url+'/api/import',{...options,headers:{...options.headers,'X-Mindwise-Token':session.token},body:JSON.stringify({baseRevision:1,operationId:'round-trip',state:exported})});
  assert.equal(imported.status,200);assert.equal((await imported.json()).nodes[0].id,'a');
});

test('UI relation semantics invalidate the dependent and explicitly applied work, not unrelated branches',t=>{
  const {store}=fixture(t);
  apply(store,['spec','dependent','applied','unrelated'].map(id=>({type:'add',node:{id,artifact:`work/${id}.txt`,criteria:'content'}})));
  apply(store,[{type:'link',link:{id:'dependency',from:'dependent',to:'spec',type:'depends_on'}},{type:'link',link:{id:'application',from:'spec',to:'applied',type:'applies_to'}}]);
  const proof={artifactHash:'a'.repeat(64),criteria:'content',method:'test',result:'passed',at:new Date().toISOString()};
  apply(store,['spec','dependent','applied','unrelated'].map(id=>({type:'update',id,patch:{verified:proof}})));
  apply(store,[{type:'update',id:'spec',patch:{body:'changed'}}]);
  const state=store.getState();
  for(const id of ['spec','dependent','applied'])assert.equal(state.nodes.find(n=>n.id===id).verified,false,id);
  assert.ok(state.nodes.find(n=>n.id==='unrelated').verified);
});

test('artifact preview returns text and actual fingerprints, detects changes, and rejects registered path escape',async t=>{
  const {store,root}=fixture(t), dir=join(root,'artifacts','run-preview');mkdirSync(dir,{recursive:true});
  const text='<script>untrusted()</script>', sha256=createHash('sha256').update(text).digest('hex');
  writeFileSync(join(dir,'test.html'),text);
  store.recordRun({id:'run-preview',status:'completed',artifacts:[{path:'artifacts/run-preview/test.html',sha256},{path:'data/mindwise.sqlite',sha256}]});
  const ai={status:()=>({}),events:()=>({}),close:()=>{}};
  const app=await createServer({root,store,ai,port:0});t.after(()=>app.close());
  const response=await fetch(app.url+'/api/artifact?runId=run-preview&index=0');assert.match(response.headers.get('content-type'),/application\/json/);
  const preview=await response.json();assert.equal(preview.text,text);assert.equal(preview.matches,true);
  writeFileSync(join(dir,'test.html'),'changed');assert.equal((await fetch(app.url+'/api/artifact?runId=run-preview&index=0').then(r=>r.json())).matches,false);
  assert.equal((await fetch(app.url+'/api/artifact?runId=run-preview&index=1')).status,403);
  assert.equal((await fetch(app.url+'/api/artifact?runId=unregistered&index=0')).status,404);
});

test('preview and save share the same impact while preserving verified local exceptions',t=>{
  const {store}=fixture(t);
  apply(store,[
    {type:'add',node:{id:'common',specs:[{key:'色',value:'青'}]}},
    {type:'add',node:{id:'regular',artifact:'regular.md',criteria:'有効な色で制作'}},
    {type:'add',node:{id:'local',specs:[{key:'色',value:'赤'}],artifact:'local.md',criteria:'有効な色で制作'}},
    {type:'link',link:{id:'common-regular',from:'common',to:'regular',type:'applies_to'}},
    {type:'link',link:{id:'common-local',from:'common',to:'local',type:'applies_to'}},
    {type:'link',link:{id:'local-exception',from:'local',to:'common',type:'exception_to',reason:'この対象だけ赤を使う'}}
  ]);
  const proof={artifactHash:'a'.repeat(64),criteria:'有効な色で制作',method:'test',result:'passed',at:new Date().toISOString()};
  apply(store,['regular','local'].map(id=>({type:'update',id,patch:{verified:proof}})));
  const before=store.getState(),payload={baseRevision:before.revision,operationId:'change-common',ops:[{type:'update',id:'common',patch:{specs:[{key:'色',value:'緑'}]}}]};
  const preview=store.preview(payload);
  assert.deepEqual(store.getState(),before);
  assert.ok(preview.impact.affected.includes('regular'));assert.ok(preview.impact.exempt.includes('local'));
  store.change(payload);
  assert.equal(store.getState().nodes.find(n=>n.id==='regular').verified,false);
  assert.deepEqual(store.getState().nodes.find(n=>n.id==='local').verified,proof);
  assert.throws(()=>store.preview(payload),/別の変更/);
  const stable=store.getState();
  assert.throws(()=>store.preview({baseRevision:stable.revision,operationId:'invalid',ops:[{type:'update',id:'common',patch:{specs:[{key:'色',value:'青'},{key:'色',value:'赤'}]}}]}),/重複/);
  assert.deepEqual(store.getState(),stable);
});
