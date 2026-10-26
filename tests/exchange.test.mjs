import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createStore} from '../src/store.mjs';
import {createServer} from '../src/server.mjs';
import {exchangeHash} from '../src/exchange.mjs';

function fixture(t) {const root=mkdtempSync(join(tmpdir(),'mindwise-exchange-')),stores=[];t.after(()=>{for(const s of stores)s.close();rmSync(root,{recursive:true,force:true});});return {root,store:name=>{const s=createStore({root,dataDir:join(root,name)});stores.push(s);return s;}};}
const change=(store,ops,meta)=>store.change({baseRevision:store.getState().revision,operationId:crypto.randomUUID(),ops,...(meta?{meta}:{})});
const load=(store,state,id=crypto.randomUUID())=>{const preview=store.previewImport({baseRevision:store.getState().revision,state}),payload={baseRevision:preview.baseRevision,state,signature:preview.signature,operationId:id};return {preview,payload,result:store.importState(payload)};};

test('exchange keeps all decision deltas, input/source originals and undone flags without a 100-entry truncation',t=>{
 const f=fixture(t),source=f.store('source');change(source,[{type:'add',node:{id:'a',body:'before'}}]);
 for(let i=0;i<102;i++)change(source,[{type:'update',id:'a',patch:{body:`v${i}`}}],{actor:'codex',reason:`reason-${i}`,inputs:[{id:'a',version:i,body:'input-original'}],sourceRefs:[{documentId:'goal',text:'source-original'}]});
 change(source,[{type:'undo'}]);const exported=source.exportState();assert.equal(exported.schemaVersion,2);assert.equal(exported.events.length,104);
 const event=exported.events.find(e=>e.context?.reason==='reason-101');assert.equal(event.undone,true);assert.equal(event.targets[0].changes.find(c=>c.field==='body').before,'v100');assert.equal(event.context.inputs[0].body,'input-original');assert.equal(event.context.sourceRefs[0].text,'source-original');
 const target=f.store('target');load(target,exported);const archive=target.provenance('a').archives.find(a=>a.events.length===104);assert.ok(archive);assert.equal(archive.events.find(e=>e.operationId===event.operationId).context.reason,'reason-101');
});
test('import previews full replacement, strips verification and preserves local and foreign runs only as inert sources',t=>{
 const f=fixture(t),source=f.store('source'),target=f.store('target');change(source,[{type:'add',node:{id:'same',title:'foreign',artifact:'outside.md',criteria:'proof'}}]);
 change(source,[{type:'update',id:'same',patch:{verified:{artifactHash:'a'.repeat(64),criteria:'proof',method:'claimed-owner',result:'passed',at:new Date().toISOString()}}}]);source.recordRun({id:'foreign-run',targetId:'same',status:'running',threadId:'foreign-thread',decisionReason:'foreign-reason'});
 change(target,[{type:'add',node:{id:'same',title:'local'}},{type:'add',node:{id:'removed'}}]);target.recordRun({id:'local-run',targetId:'same',status:'completed',threadId:'local-thread'});
 const exported=source.exportState(),{preview,payload,result}=load(target,exported,'import-receipt');assert.deepEqual(preview.collisions.map(c=>c.id),['same']);assert.deepEqual(preview.removed.map(c=>c.id),['removed']);assert.equal(preview.changes[0].before.title,'local');assert.equal(preview.changes[0].after.title,'foreign');
 assert.equal(result.nodes[0].verified,false);assert.deepEqual(result.runs,[]);assert.equal(target.operationReceipt('ai-foreign-run'),null);
 const archives=target.provenance('same').archives;assert.ok(archives.some(a=>a.runs.some(r=>r.threadId==='foreign-thread')));assert.ok(archives.some(a=>a.runs.some(r=>r.threadId==='local-thread')));
 assert.equal(target.importState(payload).revision,result.revision);change(target,[{type:'undo'}]);assert.equal(target.getState().nodes[0].title,'local');assert.deepEqual(target.getState().runs,[]);assert.equal(target.archiveList().length,2);
});
test('preview binds document, revision and run state; import while production active is rejected',t=>{
 const f=fixture(t),s=f.store('s'),data={schemaVersion:1,nodes:[{id:'a'}],links:[]};const preview=s.previewImport({baseRevision:0,state:data});
 assert.throws(()=>s.importState({baseRevision:0,state:data,operationId:'no-preview'}),/照合/);
 assert.throws(()=>s.importState({baseRevision:0,state:{...data,nodes:[{id:'b'}]},operationId:'changed',signature:preview.signature}),/照合/);
 s.recordRun({id:'r',status:'running'});assert.throws(()=>s.importState({baseRevision:0,state:data,operationId:'active',signature:preview.signature}),/制作中/);
 s.recordRun({id:'r',status:'interrupted'});assert.throws(()=>s.importState({baseRevision:0,state:data,operationId:'run-changed',signature:preview.signature}),/照合/);
 change(s,[{type:'add',node:{id:'new'}}]);assert.throws(()=>s.importState({baseRevision:0,state:data,operationId:'stale',signature:preview.signature}),/別の変更/);assert.equal(s.archiveList().length,0);
});
test('re-export flattens sources and preserves foreign records through another import and restart',t=>{
 const f=fixture(t),a=f.store('a'),b=f.store('b'),c=f.store('c');change(a,[{type:'add',node:{id:'a'}}],{actor:'owner',reason:'original decision'});a.recordRun({id:'r',targetId:'a',status:'completed',decisionReason:'original production'});
 load(b,a.exportState());const exported=b.exportState();assert.equal(exported.archives.length,2);assert.ok(exported.archives.every(a=>!('archives' in a.data)));load(c,exported);
 assert.ok(c.provenance('a').archives.some(a=>a.events.some(e=>e.context?.reason==='original decision')));assert.equal(c.getState().runs.length,0);const again=c.exportState();assert.equal(new Set(again.archives.map(a=>a.sha256)).size,again.archives.length);
 const backup=c.backup(),dir=join(f.root,'restored');mkdirSync(dir);copyFileSync(backup.path,join(dir,'mindwise.sqlite'));const restored=createStore({root:f.root,dataDir:dir});try{assert.deepEqual(restored.archiveList(),c.archiveList());assert.deepEqual(restored.provenance('a').archives,c.provenance('a').archives);}finally{restored.close();}
});
test('unknown schema/fields, duplicate IDs, corrupted/absent archive data are refused without changing source or destination',t=>{
 const f=fixture(t),s=f.store('s'),base={schemaVersion:1,nodes:[{id:'a'}],links:[]};
 for(const data of [{...base,schemaVersion:8},{...base,custom:true},{...base,nodes:[{title:'IDなし'}]},{...base,nodes:[{id:'a',custom:true}]},{...base,nodes:[{id:'a'},{id:'a'}]},{...base,archives:[{sha256:'a'.repeat(64),data:base}]},{...base,archiveRefs:['a'.repeat(64)]}]){const before=JSON.stringify(data);assert.throws(()=>s.previewImport({baseRevision:0,state:data}));assert.equal(JSON.stringify(data),before);}
 assert.equal(s.getState().revision,0);assert.equal(s.archiveList().length,0);
});
test('size failure during archive retention rolls back replacement and all archive writes',t=>{
 const f=fixture(t),a=f.store('a'),b=f.store('b');change(b,[{type:'add',node:{id:'local'}}]);const exported=a.exportState();exported.runs=[{id:'big',reply:'x'.repeat(3.3*1024*1024)}];
 // Incoming fits; retaining current live runs plus incoming would exceed limit.
 b.recordRun({id:'local-run',status:'completed',reply:'y'.repeat(3.3*1024*1024)});const preview=b.previewImport({baseRevision:1,state:exported});assert.throws(()=>b.importState({baseRevision:1,operationId:'oversize',state:exported,signature:preview.signature}),/6MiB/);
 assert.equal(b.getState().revision,1);assert.equal(b.getState().nodes[0].id,'local');assert.equal(b.getState().runs.length,1);assert.equal(b.archiveList().length,0);assert.equal(b.operationReceipt('oversize'),null);
});
test('same target IDs from another project remain distinguished by project and package hash',t=>{
 const f=fixture(t),s=f.store('s'),data={schemaVersion:1,projectId:'foreign-project',revision:7,nodes:[{id:'a'}],links:[],runs:[{id:'r',targetId:'a',threadId:'do-not-resume',status:'completed'}]};load(s,data);
 const record=s.provenance('a').archives.find(a=>a.projectId==='foreign-project');assert.ok(record);assert.equal(record.revision,7);const original=s.archiveState(record.sha256);delete original.archives;assert.equal(exchangeHash(original),record.sha256);assert.equal(original.runs[0].threadId,'do-not-resume');assert.deepEqual(s.getState().runs,[]);
 load(s,{schemaVersion:1,projectId:'unrelated',nodes:[{id:'different'}],links:[]});assert.deepEqual(s.archiveState(record.sha256).archives,[],'source download excludes later unrelated packages');
});
test('HTTP import requires token and viewed signature; archive records are retrievable after idempotent import',async t=>{
 const f=fixture(t),store=f.store('s'),ai={events:()=>({}),status:()=>({}),close:()=>{}};const app=await createServer({root:f.root,store,ai,port:0});t.after(()=>app.close());const token=(await fetch(app.url+'/api/session').then(r=>r.json())).token;
 const post=(path,payload,auth=token)=>fetch(app.url+path,{method:'POST',headers:{'Content-Type':'application/json','X-Mindwise-Token':auth},body:JSON.stringify(payload)}),data={schemaVersion:1,nodes:[{id:'a'}],links:[]};
 assert.equal((await post('/api/import-preview',{state:data,baseRevision:0},'')).status,403);assert.equal((await post('/api/import',{state:data,baseRevision:0,operationId:'i'})).status,409);
 const preview=await post('/api/import-preview',{state:data,baseRevision:0}).then(r=>r.json()),payload={state:data,baseRevision:0,signature:preview.signature,operationId:'i'};
 assert.equal((await post('/api/import',payload)).status,200);assert.equal((await post('/api/import',payload)).status,200);const sources=await fetch(app.url+'/api/exchange/sources').then(r=>r.json());assert.equal(sources.length,2);assert.equal((await fetch(app.url+'/api/exchange/source?sha256='+preview.packageHash).then(r=>r.json())).nodes[0].id,'a');assert.equal(store.getState().revision,1);
});
