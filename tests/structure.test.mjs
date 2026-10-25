import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createStore} from '../src/store.mjs';
import {calculateNumbers,assessNumbers} from '../src/numbers.mjs';
import {resolveSpecifications} from '../src/semantics.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
function fixture(t){const root=mkdtempSync(join(tmpdir(),'mindwise-structure-')),dataDir=join(root,'data'),store=createStore({root,dataDir});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});return {root,store};}
const request=(store,ops)=>({baseRevision:store.getState().revision,operationId:crypto.randomUUID(),ops,meta:{actor:'owner',reason:null}});
const change=(store,ops)=>store.change(request(store,ops));

test('task, artifact, note, numeric reference and production history survive structure roundtrip',t=>{
 const {root,store}=fixture(t),artifact='artifacts/run/check.md';
 mkdirSync(join(root,'artifacts/run'),{recursive:true});writeFileSync(join(root,artifact),'fictional check');
 change(store,[
  {type:'add',node:{id:'a',specs:[{key:'色',value:'青'}]}},
  {type:'add',node:{id:'b',specs:[{key:'色',value:'赤'}]}},
  {type:'add',node:{id:'input',value:4,unit:'時間',metricSource:'fictional observation',metricFreshness:'current'}},
  {type:'add',node:{id:'task',parentId:'a',kind:'task',status:'active',progress:40,body:'task with source notes',artifact,criteria:'fictional check',unit:'時間',formula:'hours * 2',metricInputs:[{name:'hours',nodeId:'input'}]}},
  {type:'add',node:{id:'note',parentId:'task',body:'source notes retained'}},
  {type:'add',node:{id:'consumer',formula:'total / 2',unit:'時間',metricInputs:[{name:'total',nodeId:'task'}]}}
 ]);
 store.recordRun({id:'run',targetId:'task',targetVersion:1,status:'completed',artifacts:[{path:artifact,sha256:hash('fictional check')}]});
 const original=store.getState().nodes.find(n=>n.id==='task'),number=calculateNumbers(store.getState()).byId.task;
 for(const parentId of [null,'b']) {
  const payload=request(store,[{type:'update',id:'task',patch:{parentId}}]);
  const preview=store.preview(payload);assert.deepEqual(preview.impact.changed,[]);assert.deepEqual(preview.impact.unknown,[]);
  store.change(payload);
  assert.equal(calculateNumbers(store.getState()).byId.task.fingerprint,number.fingerprint);
  assert.deepEqual(resolveSpecifications(store.getState(),'task').effective,[],'Display parent must not apply blue or red');
 }
 const beforeInvalid=store.getState();
 assert.throws(()=>change(store,[{type:'update',id:'task',patch:{parentId:'note'}}]),/循環/);
 assert.deepEqual(store.getState(),beforeInvalid,'Invalid reparent cannot partially save');
 change(store,[{type:'link',link:{id:'related',from:'task',to:'note',type:'relates_to'}}]);
 change(store,[{type:'unlink',id:'related'}]);assert.equal(store.getState().links.length,0);
 change(store,[{type:'link',link:{id:'related',from:'task',to:'note',type:'relates_to'}}]);
 change(store,[{type:'delete',id:'task'}]);
 const deleted=store.getState();assert.equal(deleted.nodes.find(n=>n.id==='note').parentId,null);assert.equal(deleted.links.length,0);
 assert.equal(calculateNumbers(deleted).byId.consumer.status,'unresolved');
 assert.equal(deleted.nodes.find(n=>n.id==='consumer').metricInputs[0].nodeId,'task','Broken reference must stay identifiable');
 change(store,[{type:'undo'}]);const restored=store.getState(),task=restored.nodes.find(n=>n.id==='task');
 for(const key of ['id','body','kind','status','progress','artifact','criteria','metricInputs','formula','unit'])assert.deepEqual(task[key],original[key],key);
 assert.equal(task.parentId,'b');assert.equal(restored.nodes.find(n=>n.id==='note').parentId,'task');assert.equal(restored.links[0].id,'related');
 assert.equal(calculateNumbers(restored).byId.consumer.value,4);assert.equal(calculateNumbers(restored).byId.task.fingerprint,number.fingerprint);
 assert.equal(restored.runs[0].status,'completed');assert.equal(hash(readFileSync(join(root,artifact))),hash('fictional check'));
 const provenance=store.provenance('task');assert.ok(provenance.entries.some(e=>e.kind==='undo'));assert.ok(provenance.entries.some(e=>e.changes.some(c=>c.field==='parentId')));assert.equal(provenance.runs[0].id,'run');
});

test('numeric relation addition, unlink and input edits show the same review scope before saving',t=>{
 const {store}=fixture(t),proof={artifactHash:'a'.repeat(64),criteria:'check',method:'test',result:'passed',at:new Date().toISOString()};
 change(store,[{type:'add',node:{id:'work',artifact:'artifacts/run/check.md',criteria:'check'}},{type:'add',node:{id:'other'}},{type:'add',node:{id:'budget',value:10,unit:'円',metricFreshness:'current',metricSource:'fictional'}}]);
 const basis=()=>assessNumbers(store.getState(),'work',calculateNumbers(store.getState()));
 assert.equal(basis().fingerprint,null);
 for(const type of ['relates_to','precedes']) {
  change(store,[{type:'update',id:'work',patch:{verified:proof}}]);
  const add=request(store,[{type:'link',link:{id:'number-context',from:'work',to:'budget',type}}]);
  assert.ok(store.preview(add).impact.unknown.includes('work'));store.change(add);assert.equal(store.getState().nodes.find(n=>n.id==='work').verified,false);
  assert.equal(store.getState().nodes.find(n=>n.id==='budget').metricFreshness,'current');assert.ok(basis().fingerprint);
  change(store,[{type:'update',id:'work',patch:{verified:proof}}]);
  const edit=request(store,[{type:'update',id:'budget',patch:{value:store.getState().nodes.find(n=>n.id==='budget').value+10}}]);assert.ok(store.preview(edit).impact.unknown.includes('work'));store.change(edit);assert.equal(store.getState().nodes.find(n=>n.id==='work').verified,false);
  change(store,[{type:'update',id:'work',patch:{verified:proof}}]);
  const remove=request(store,[{type:'unlink',id:'number-context'}]);assert.ok(store.preview(remove).impact.unknown.includes('work'));store.change(remove);assert.equal(basis().fingerprint,null);assert.equal(store.getState().nodes.find(n=>n.id==='work').verified,false);
 }
 const plain=request(store,[{type:'link',link:{id:'plain',from:'work',to:'other',type:'relates_to'}}]);assert.deepEqual(store.preview(plain).impact.unknown,[]);
});

test('numeric context changes invalidate artifact review without aging unrelated input values',t=>{
 const {store}=fixture(t);
 change(store,['a','b'].map(id=>({type:'add',node:{id,value:10,unit:'円',metricFreshness:'current',metricSource:'fictional'}})));
 const payload=request(store,[{type:'link',link:{id:'context',from:'a',to:'b',type:'relates_to'}}]);
 const impact=store.preview(payload).impact;assert.deepEqual(impact.unknown,['a','b']);assert.deepEqual(impact.inputRecheck,[]);
 store.change(payload);
 assert.ok(store.getState().nodes.every(n=>n.metricFreshness==='current'));assert.equal(calculateNumbers(store.getState()).byId.a.value,10);
 const edit=request(store,[{type:'update',id:'a',patch:{body:'explanation revised'}}]);
 assert.deepEqual(store.preview(edit).impact.inputRecheck,['a']);store.change(edit);
 assert.equal(store.getState().nodes.find(n=>n.id==='a').metricFreshness,'stale');assert.equal(store.getState().nodes.find(n=>n.id==='b').metricFreshness,'current');
 assert.equal(assessNumbers(store.getState(),'b',calculateNumbers(store.getState())).status,'unresolved','Related stale input still blocks artifact review');
 change(store,[{type:'unlink',id:'context'}]);assert.equal(store.getState().nodes.find(n=>n.id==='b').metricFreshness,'current');
});

test('adding or removing a numeric dependency rechecks only the dependent input, preserving its source',t=>{
 const {store}=fixture(t);
 change(store,['source','dependent'].map(id=>({type:'add',node:{id,value:10,unit:'円',metricFreshness:'current',metricSource:'fictional'}})));
 const add=request(store,[{type:'link',link:{id:'dependency',from:'dependent',to:'source',type:'depends_on'}}]);
 assert.deepEqual(store.preview(add).impact.inputRecheck,['dependent']);store.change(add);
 assert.equal(store.getState().nodes.find(n=>n.id==='source').metricFreshness,'current');assert.equal(store.getState().nodes.find(n=>n.id==='dependent').metricFreshness,'stale');
 change(store,[{type:'update',id:'dependent',patch:{metricFreshness:'current'}}]);
 const remove=request(store,[{type:'unlink',id:'dependency'}]);assert.deepEqual(store.preview(remove).impact.inputRecheck,['dependent']);store.change(remove);
 assert.equal(store.getState().nodes.find(n=>n.id==='source').metricFreshness,'current');assert.equal(store.getState().nodes.find(n=>n.id==='dependent').metricFreshness,'stale');
});
