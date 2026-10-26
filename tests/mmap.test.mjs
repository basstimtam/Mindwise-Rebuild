import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {convertMmap,readMmapXml,readMmapZip,mmapSourceBytes,MMAP_LIMITS} from '../src/mmap.mjs';
import {createStore} from '../src/store.mjs';
import {createServer} from '../src/server.mjs';
import {xml,zip} from './fixtures/mmap.mjs';
const digest=b=>createHash('sha256').update(b).digest('hex');
const convert=text=>convertMmap(zip([{name:'Document.xml',text}]),'fictional.mmap');
function fixture(t){const root=mkdtempSync(join(tmpdir(),'mindwise-mmap-')),stores=[];t.after(()=>{for(const s of stores)s.close();rmSync(root,{recursive:true,force:true});});return {root,store:name=>{const store=createStore({root,dataDir:join(root,name)});stores.push(store);return store;}};}
function load(store,state,id=crypto.randomUUID()){const preview=store.previewImport({baseRevision:store.getState().revision,state}),payload={state,baseRevision:preview.baseRevision,signature:preview.signature,operationId:id};return {preview,payload,saved:store.importState(payload)};}

test('mmap maps text/hierarchy/planned progress without inventing dependency, calendar dates, domain or acceptance',()=>{
 const bytes=zip(),before=Buffer.from(bytes),data=convertMmap(bytes,'fictional.mmap'),[root,chapter,floating]=data.nodes,report=data.sourceDocument.report;
 assert.equal(root.title,'架空書籍：雨港の灯 & 設計');assert.equal(root.body,'一段目 & 原文\n二段目\n続き');assert.equal(chapter.parentId,root.id);assert.equal(chapter.progress,42);assert.equal(chapter.kind,'task');assert.equal(floating.parentId,null);assert.equal(report.mapping[2].originalParentOId,'root/+=');assert.equal(report.mapping[2].placement,'floating');
 assert.ok(!('start' in chapter)&&!('due' in chapter)&&!('depth' in chapter)&&!('domain' in chapter)&&!('verified' in chapter));assert.equal(data.links.length,1);assert.equal(data.links[0].type,'relates_to');assert.equal(data.links[0].from,root.id);assert.equal(data.links[0].to,chapter.id);assert.equal(report.unresolvedRelationships,1);
 assert.ok(report.unmappedAttributes.some(a=>a.name.endsWith('/@{}StartDate')));assert.ok(report.unmappedElements.some(e=>e.name.endsWith('BusinessDataGroup')));assert.ok(report.entries.some(e=>e.name==='resources/placeholder.txt'&&!e.used));assert.equal(report.relationshipMapping[0].label,'線のラベルは仕様依存ではない');assert.deepEqual(bytes,before);assert.deepEqual(mmapSourceBytes(data.sourceDocument),bytes);assert.equal(data.sourceDocument.sha256,digest(bytes));
});
test('mmap IDs bind original map/topic identity, survive content edits and reject missing/ambiguous/unvisited topics',()=>{
 const a=convert(xml),b=convert(xml.replace('第一章：港の約束','第一章：改訂'));assert.deepEqual(a.nodes.map(n=>n.id),b.nodes.map(n=>n.id));assert.notEqual(a.nodes[0].id,convert(xml.replace('fictional-map/+=','other-map')).nodes[0].id);assert.ok(a.nodes.every(n=>/^[a-z0-9:]+$/.test(n.id)));
 for(const bad of [xml.replace(' OId="chapter/+="',''),xml.replace('OId="chapter/+="','OId="root/+="'),xml.replace('<ap:Theme Custom="unmapped"/>','<ap:Theme><ap:Topic OId="hidden"><ap:Text PlainText="hidden"/></ap:Topic></ap:Theme>'),xml.replace('<ap:Text PlainText="第一章：港の約束"/>','<ap:Text PlainText="a"/><ap:Text PlainText="b"/>'),xml.replace('TaskPercentage="42"','TaskPercentage="101"')])assert.throws(()=>convert(bad));
 const empty=convert(xml.replace('PlainText="第一章：港の約束"','PlainText=""'));assert.equal(empty.nodes[1].title,'無題の枝 2');assert.equal(empty.sourceDocument.report.mapping[1].titleImported,false);
});
test('XML reader preserves mixed text/CDATA and resolves namespace identity while refusing executable/ambiguous XML',()=>{
 const root=readMmapXml(Buffer.from('<p:a xmlns:p="urn:test" xmlns:q="urn:test" q:x="&#x65E5;&#26412;"><![CDATA[<raw>]]><p:b/>tail</p:a>'));assert.equal(root.uri,'urn:test');assert.equal(root.attrs['{urn:test}x'],'日本');assert.equal(root.parts[0],'<raw>');assert.equal(root.parts[2],'tail');
 for(const bad of ['<!DOCTYPE a [<!ENTITY x SYSTEM "file:///secret">]><a>&x;</a>','<a>&unknown;</a>','<a x="1" x="2"/>','<a xmlns:p="u" xmlns:q="u" p:x="1" q:x="2"/>','<p:a/>','<a><b></a>','<a>&#0;</a>','<a>\u0000</a>','<a/><b/>','<a><!----bad--comment--></a>','<a xmlns:p=""><p:b/></a>'])assert.throws(()=>readMmapXml(Buffer.from(bad)));
 assert.throws(()=>readMmapXml(Buffer.from([0xc0,0x80])));assert.throws(()=>readMmapXml(Buffer.from('<a>'.repeat(130)+'</a>'.repeat(130))),/深さ/);assert.throws(()=>readMmapXml(Buffer.from('<a>'+'<b/>'.repeat(MMAP_LIMITS.elements)+'</a>')),/要素数/);
 assert.throws(()=>convert(xml.replace('http://schemas.mindjet.com/MindManager/Application/2003','urn:foreign')),/名前空間/);
 for(const bad of ['<a></ a>','<a\u00a0x="1"/>','<a/>\u00a0','<!--a---><a/>'])assert.throws(()=>readMmapXml(Buffer.from(bad)));
});
test('relationship markup in note text or other off-path containers cannot create live map links',()=>{
 const without=xml.replace(/<ap:Relationships>[\s\S]*<\/ap:Relationships>/,'');
 const line=xml.match(/<ap:Relationship OId="relation\/\+=">[\s\S]*?<\/ap:Relationship>/)[0];
 const data=convert(without.replace('<x:p>一段目 &amp; 原文</x:p>',`<x:p>一段目 &amp; 原文${line}</x:p>`));assert.equal(data.links.length,0);assert.equal(data.sourceDocument.report.relationships,0);assert.ok(data.sourceDocument.report.unmappedElements.some(e=>e.name.endsWith('Relationship')));
 assert.throws(()=>convert(xml.replace('</ap:Map>','<ap:Relationships/></ap:Map>')),/複数/);
});
test('ZIP reader supports stored/deflated/descriptor records and refuses path, duplicate, link and format hazards',()=>{
 for(const method of [0,8])for(const flags of [0,8,0x800])assert.equal(readMmapZip(zip([{name:'Document.xml',text:xml,method,flags}])).get('Document.xml').bytes.toString(),xml);
 for(const name of ['../Document.xml','/Document.xml','C:/Document.xml','a\\Document.xml','a/./Document.xml','a//Document.xml','a/../Document.xml','a\0.xml'])assert.throws(()=>readMmapZip(zip([{name,text:xml}])));
 for(const extra of [{name:'document.xml',text:'duplicate'},{name:'link',text:'../secret',attrs:0xa1ff0000},{name:'x',text:'data',flags:1},{name:'x',text:'data',method:99}])assert.throws(()=>readMmapZip(zip([{name:'Document.xml',text:xml},extra])));
 const original=zip([{name:'Document.xml',text:xml}]),end=original.length-22,central=original.readUInt32LE(end+16);
 for(const mutate of [b=>b.writeUInt16LE(1,end+4),b=>b.writeUInt32LE(0xffffffff,central+42),b=>b.writeUInt16LE(0x800,central+8),b=>b.writeUInt32LE(0,central+16),b=>b.writeUInt32LE(MMAP_LIMITS.document+1,central+24),b=>{b[30]^=1;},b=>b.writeUInt32LE(1,central+20)]){const bytes=Buffer.from(original);mutate(bytes);assert.throws(()=>readMmapZip(bytes));}
 assert.throws(()=>readMmapZip(Buffer.concat([original,Buffer.from('extra')])));assert.throws(()=>readMmapZip(Buffer.alloc(MMAP_LIMITS.bytes+1)));assert.throws(()=>readMmapZip(zip(Array.from({length:257},(_,i)=>({name:`x${i}`,text:''})))),/256/);
 const bomb=zip([{name:'Document.xml',text:'x'.repeat(MMAP_LIMITS.document+1)}]);assert.throws(()=>readMmapZip(bomb),/4MiB/);
});
test('mmap import/undo/re-export/restart preserve byte-exact source and source IDs without live authority',t=>{
 const f=fixture(t),s=f.store('s'),bytes=zip(),data=convertMmap(bytes,'fictional.mmap');s.change({baseRevision:0,operationId:'local',ops:[{type:'add',node:{id:'original',title:'交換前'}}]});const {preview,payload,saved}=load(s,data,'mmap-import');assert.equal(saved.revision,2);assert.equal(preview.sourceDocument.report.topics,3);assert.deepEqual(saved.runs,[]);assert.ok(saved.nodes.every(n=>!n.verified&&n.sourceRefs.length===0));
 const archive=s.archiveList().find(a=>a.sourceDocument);assert.equal(archive.sourceDocument.sha256,digest(bytes));assert.equal(s.provenance(saved.nodes[1].id).archives.find(a=>a.sourceDocument).sourceDocument.mapping.originalOId,'chapter/+=');assert.deepEqual(mmapSourceBytes(s.archiveState(archive.sha256).sourceDocument),bytes);
 assert.equal(s.importState(payload).revision,2);s.change({baseRevision:2,operationId:'undo',ops:[{type:'undo'}]});assert.equal(s.getState().nodes[0].id,'original');assert.deepEqual(mmapSourceBytes(s.archiveState(archive.sha256).sourceDocument),bytes);
 const second=f.store('second');load(second,s.exportState());const again=second.archiveState(archive.sha256);assert.deepEqual(mmapSourceBytes(again.sourceDocument),bytes);const restart=createStore({root:f.root,dataDir:second.dataDir});try{assert.equal(restart.archiveList().find(a=>a.sourceDocument).sourceDocument.sha256,digest(bytes));}finally{restart.close();}
});
test('corrupt or malformed preserved source rejects atomically and original input is unchanged',t=>{
 const f=fixture(t),s=f.store('s'),data=convertMmap(zip(),'fictional.mmap'),original=JSON.stringify(data);
 for(const mutate of [d=>d.sourceDocument.sha256='a'.repeat(64),d=>d.sourceDocument.base64+='!',d=>d.sourceDocument.report.mapping={},d=>d.sourceDocument.report.notes=[{}],d=>d.sourceDocument.other=true]){const bad=structuredClone(data);mutate(bad);assert.throws(()=>s.previewImport({baseRevision:0,state:bad}));}assert.equal(JSON.stringify(data),original);assert.equal(s.getState().revision,0);assert.equal(s.archiveList().length,0);
});
test('HTTP conversion is authenticated bounded data only and does not save before viewed import',async t=>{
 const f=fixture(t),store=f.store('s'),app=await createServer({root:f.root,store,ai:{events:()=>({}),status:()=>({}),close:()=>{}},port:0});t.after(()=>app.close());const token=(await fetch(app.url+'/api/session').then(r=>r.json())).token,post=(data,auth=token,origin)=>fetch(app.url+'/api/mmap-convert',{method:'POST',headers:{'Content-Type':'application/json','X-Mindwise-Token':auth,...(origin?{Origin:origin}:{})},body:JSON.stringify(data)}),input={name:'fictional.mmap',base64:zip().toString('base64')};
 assert.equal((await post(input,'')).status,403);assert.equal((await post(input,token,'https://example.invalid')).status,403);assert.equal((await post({...input,path:'C:/secret'})).status,400);assert.equal((await post({...input,base64:input.base64+'!'})).status,400);assert.equal((await post({...input,name:'../x.mmap'})).status,400);
 const corrupt=zip([{name:'Document.xml',text:xml}]);corrupt.fill(255,42,46);assert.equal((await post({...input,base64:corrupt.toString('base64')})).status,400);assert.equal((await post({base64:input.base64})).status,400);
 const response=await post(input);assert.equal(response.status,200);const data=await response.json();assert.equal(store.getState().revision,0);assert.equal(store.archiveList().length,0);assert.equal(data.nodes.length,3);assert.deepEqual(mmapSourceBytes(data.sourceDocument),zip());load(store,data);assert.equal(store.getState().revision,1);
});
