import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,copyFileSync,writeFileSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateNumbers,parseFormula,parseUnit,assessNumbers } from '../src/numbers.mjs';
import { createStore } from '../src/store.mjs';
import { createServer } from '../src/server.mjs';
import { readContracts } from '../src/contracts.mjs';
import { analyzeChange } from '../src/semantics.mjs';

const input=(id,value,unit,extra={})=>({id,title:id,version:1,value,unit,metricSource:'架空の試験見積り',metricFreshness:'current',...extra});
const formula=(id,text,unit,refs)=>({id,title:id,version:1,value:null,formula:text,unit,metricInputs:Object.entries(refs).map(([name,nodeId])=>({name,nodeId}))});
const fixture=()=>({revision:4,nodes:[input('hours',3,'時間'),input('rate',1200,'円/時間'),formula('cost','hours * rate','円',{hours:'hours',rate:'rate'}),formula('double','cost * 2','円',{cost:'cost'}),input('unrelated',7,'頁')],links:[]});
const get=(s,id)=>calculateNumbers(s).byId[id];
test('calculator resolves chained named references with dimensions, source and immutable formula identity',()=>{
 const state=fixture(),calc=calculateNumbers(state);assert.equal(calc.byId.cost.value,3600);assert.equal(calc.byId.double.value,7200);assert.equal(calc.byId.cost.status,'calculated');
 assert.equal(calc.byId.cost.inputs[0].nodeId,'hours');assert.equal(calc.byId.cost.inputs[0].version,1);assert.equal(calc.byId.hours.source.text,'架空の試験見積り');assert.equal(calc.byId.cost.atRevision,4);
 const fingerprint=calc.byId.cost.fingerprint,formulaHash=calc.byId.cost.formulaHash;state.nodes[0].value=4;
 assert.equal(get(state,'cost').value,4800);assert.notEqual(get(state,'cost').fingerprint,fingerprint);assert.equal(get(state,'cost').formulaHash,formulaHash);
 const before=get(state,'cost').fingerprint;state.nodes[0].version++;state.nodes[0].x=999;state.revision++;
 assert.equal(get(state,'cost').fingerprint,before);assert.equal(get(state,'cost').inputs[0].version,2);
 assert.equal(get({nodes:[formula('constant','-(2 + 3) / .5','1',{})]},'constant').value,-10);
 assert.deepEqual(parseUnit('時間*円/時間'),parseUnit('円'));assert.deepEqual(parseUnit('m^2/m'),parseUnit('m'));
});

test('missing values, sources, freshness, refs, units and invalid arithmetic never become a result',()=>{
 const mutations=[
  s=>s.nodes[0].value=null,s=>s.nodes[0].metricSource='',s=>s.nodes[0].metricFreshness='unknown',s=>s.nodes[0].metricFreshness='stale',
  s=>s.nodes.splice(0,1),s=>s.nodes[2].unit='時間',s=>s.nodes[0].unit='分',s=>s.nodes[2].formula='hours + rate',
  s=>s.nodes[2].formula='hours / 0',s=>s.nodes[2].formula='unknown * rate',s=>s.nodes[2].value=10,
  s=>s.nodes[2].metricInputs.push({name:'rate',nodeId:'hours'}),s=>s.nodes[0].unit='',
  s=>{s.nodes[0].value=Number.MAX_VALUE;s.nodes[1].value=2;},
 ];
 for(const mutate of mutations){const s=fixture();mutate(s);const result=get(s,'cost');assert.equal(result.status,'unresolved',JSON.stringify(s));assert.equal(result.value,null);assert.ok(result.issues.length);assert.equal(get(s,'unrelated').value,7);}
});

test('cycles and pathological expressions stay finite, and cannot execute JavaScript',()=>{
 const s=fixture();s.nodes[0]=formula('hours','x','時間',{x:'double'});const calc=calculateNumbers(s);
 for(const id of ['hours','cost','double']){assert.equal(calc.byId[id].status,'unresolved');assert.equal(calc.byId[id].value,null);}assert.equal(calc.byId.unrelated.value,7);
 for(const text of ['globalThis.process.exit()','a.constructor','fetch(1)','2 ** 3','[1][0]','1;2','1e999','('.repeat(33)+'1'+')'.repeat(33),'1+'.repeat(600)+'1'])assert.throws(()=>parseFormula(text));
 const deep={nodes:[input('leaf',1,'1')],links:[]};for(let i=300;i>=0;i--)deep.nodes.unshift(formula('n'+i,'x','1',{x:i===300?'leaf':'n'+(i+1)}));
 assert.equal(get(deep,'n0').status,'unresolved');
});

test('numeric dependency changes demand a finite impact recheck without layout or unrelated effects',()=>{
 const before=fixture(),after=structuredClone(before);after.nodes[0].value=4;
 const impact=analyzeChange(before,after);assert.ok(impact.unknown.includes('cost'));assert.ok(impact.unknown.includes('double'));assert.ok(!impact.affected.includes('unrelated'));assert.ok(!impact.unknown.includes('unrelated'));
 const deleted=structuredClone(before);deleted.nodes.shift();assert.ok(analyzeChange(before,deleted).unknown.includes('cost'));
 const invalid=structuredClone(before);invalid.nodes[2].unit='';assert.ok(analyzeChange(invalid,{...invalid,nodes:invalid.nodes.map(n=>n.id==='hours'?{...n,value:4}:n)}).unknown.includes('cost'),'invalid result units do not hide the reference edge');
});

function temp(t,cleanup=true) {const root=mkdtempSync(join(tmpdir(),'mindwise-number-'));if(cleanup)t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}
test('contract version or approval changes remove derived numeric results even without a model mutation',t=>{
 const root=temp(t);for(const name of ['GOAL.md','DESIGN_STANDARD.md','DISCOVERY_LOG.md','contract-registry.json'])copyFileSync(fileURLToPath(new URL(`../${name}`,import.meta.url)),join(root,name));
 const doc=readContracts(root).documents.find(d=>d.id==='goal'),s=fixture();s.nodes[0].sourceRefs=[{documentId:'goal',section:'1. 最終到達点',revision:doc.revision,sha256:doc.sha256}];
 assert.equal(calculateNumbers(s,{root}).byId.cost.value,3600);
 writeFileSync(join(root,'GOAL.md'),readFileSync(join(root,'GOAL.md'),'utf8')+'\n未承認の試験改変\n');
 const changed=calculateNumbers(s,{root});assert.equal(changed.byId.cost.status,'unresolved');assert.equal(changed.byId.cost.value,null);assert.equal(changed.byId.unrelated.value,7);
 const applied=fixture();applied.nodes.push({id:'source',body:'単価の根拠',sourceRefs:s.nodes[0].sourceRefs});applied.links.push({id:'apply-rate',from:'source',to:'rate',type:'applies_to'});
 assert.equal(calculateNumbers(applied,{root}).byId.cost.status,'unresolved','applied sources are part of numeric freshness');
});

test('an erased number remains missing while numeric metadata or a numeric use remains',()=>{
 const s=fixture();s.nodes[0].value=null;s.links.push({id:'direct',from:'work',to:'hours',type:'depends_on'});s.nodes.push({id:'work'});
 const calc=calculateNumbers(s);assert.equal(calc.byId.hours.status,'unresolved');assert.equal(assessNumbers(s,'work',calc).status,'unresolved');
});

test('semantic source changes mark manual numbers stale, preserve layout and allow an explicit recheck',t=>{
 const root=temp(t,false),store=createStore({root,dataDir:join(root,'data')});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 store.change({baseRevision:0,operationId:'seed',ops:[...fixture().nodes.map(node=>({type:'add',node})),{type:'add',node:{id:'note',body:'架空単価1200'}},{type:'link',link:{id:'reason-rate',from:'rate',to:'note',type:'depends_on'}}]});
 let s=store.getState();assert.equal(s.nodes.find(n=>n.id==='rate').metricFreshness,'current');
 store.change({baseRevision:s.revision,operationId:'layout',ops:[{type:'update',id:'note',patch:{x:100}}]});assert.equal(calculateNumbers(store.getState()).byId.cost.value,3600);
 store.change({baseRevision:store.getState().revision,operationId:'source-change',ops:[{type:'update',id:'note',patch:{body:'架空単価1500へ変更'}}]});
 s=store.getState();assert.equal(s.nodes.find(n=>n.id==='rate').metricFreshness,'stale');assert.equal(calculateNumbers(s).byId.cost.value,null);assert.equal(calculateNumbers(s).byId.unrelated.value,7);
 store.change({baseRevision:s.revision,operationId:'rechecked',ops:[{type:'update',id:'rate',patch:{value:1500,metricFreshness:'current',metricSource:'変更後の架空単価を再確認'}}]});assert.equal(calculateNumbers(store.getState()).byId.cost.value,4500);
});

test('previously legal long fields survive read and export as unresolved calculations',t=>{
 const root=temp(t,false),store=createStore({root,dataDir:join(root,'data')});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
 store.change({baseRevision:0,operationId:'legacy',ops:[{type:'add',node:formula('long',' '.repeat(2001)+'1','1',{})},{type:'add',node:input('unit',1,'字'.repeat(121))}]});
 assert.equal(store.exportState().nodes[0].formula.length,2002);const calc=calculateNumbers(store.getState());assert.equal(calc.byId.long.status,'unresolved');assert.equal(calc.byId.unit.status,'unresolved');
});

test('common mutation, restart and undo retain inputs; numeric evidence binds live roots and blocks stale review',async t=>{
 const root=temp(t,false),dataDir=join(root,'data');let store=createStore({root,dataDir});
 const seeded=fixture();store.change({baseRevision:0,operationId:'seed',ops:seeded.nodes.map(node=>({type:'add',node}))});
 store.close();store=createStore({root,dataDir});
 const app=await createServer({root,store,port:0,ai:{status:()=>({}),events:()=>({}),close:()=>{}}});t.after(async()=>{try{await app.close();}finally{store.close();rmSync(root,{recursive:true,force:true});}});
 const session=await (await fetch(app.url+'/api/session')).json();
 const post=async(url,body)=>{const r=await fetch(app.url+url,{method:'POST',headers:{'Content-Type':'application/json','X-Mindwise-Token':session.token},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 const get=async url=>(await fetch(app.url+url)).json();
 assert.equal((await get('/api/analysis?targetId=cost')).numbers.byId.cost.value,3600);
 assert.equal((await post('/api/change',{baseRevision:1,operationId:'edit',ops:[{type:'update',id:'hours',patch:{value:4}}]})).status,200);
 assert.equal((await get('/api/analysis?targetId=cost')).numbers.byId.cost.value,4800);
 assert.equal((await post('/api/change',{baseRevision:2,operationId:'undo',ops:[{type:'undo'}]})).status,200);
 assert.equal((await get('/api/analysis?targetId=cost')).numbers.byId.cost.value,3600);
 writeFileSync(join(root,'story.md'),'架空の見積りは3600円');
 assert.equal((await post('/api/change',{baseRevision:3,operationId:'artifact',ops:[{type:'add',node:{id:'artifact',artifact:'story.md',criteria:'3600円と記載',required:true,weight:1}},{type:'link',link:{id:'numbers',from:'artifact',to:'cost',type:'depends_on'}}]})).status,200);
 const view=await get('/api/artifact?nodeId=artifact');assert.equal(view.numberStatus,'current');assert.ok(view.numberHash);
 const proof={baseRevision:view.revision,operationId:'accept',targetId:'artifact',targetVersion:view.targetVersion,artifactHash:view.sha256,criteria:view.criteria,numberHash:view.numberHash,method:'owner-review',result:'passed'};
 assert.equal((await post('/api/verify',{...proof,numberHash:null})).status,409);
 assert.equal((await post('/api/verify',proof)).status,200);assert.equal((await get('/api/analysis?targetId=artifact')).progress.verifiedWeight,1);
 const originalState=store.getState();assert.equal(assessNumbers(originalState,'artifact',calculateNumbers(originalState)).fingerprint,view.numberHash);
 const state=store.getState();await post('/api/change',{baseRevision:state.revision,operationId:'stale-input',ops:[{type:'update',id:'hours',patch:{metricFreshness:'stale'}}]});
 const analysis=await get('/api/analysis?targetId=artifact');assert.equal(analysis.verificationById.artifact.status,'stale');assert.equal(analysis.progress.verifiedWeight,0);assert.equal(analysis.numbers.byId.cost.value,null);
 const staleView=await get('/api/artifact?nodeId=artifact');assert.equal(staleView.numberStatus,'unresolved');
 assert.equal((await post('/api/verify',{...proof,operationId:'stale-receipt',baseRevision:staleView.revision,targetVersion:staleView.targetVersion,numberHash:staleView.numberHash})).status,409);
});
