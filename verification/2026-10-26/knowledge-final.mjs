// Continue the saved fictional workflow after a checker-only undo-preview error.
// No Codex calls, fixture reset, file rewrites, or owner acceptance.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createServer} from '../../src/server.mjs';
const root=path.resolve(import.meta.dirname,'../..'),file=path.join(import.meta.dirname,'knowledge-workflow.json'),evidence=JSON.parse(readFileSync(file,'utf8'));
assert.equal(process.cwd(),root);assert.equal(evidence.realCalls,3);
const digest=value=>createHash('sha256').update(value).digest('hex'),app=await createServer({root,dataDir:path.join(root,'.runtime/knowledge-workflow'),port:4317});
const token=(await fetch(app.url+'/api/session').then(r=>r.json())).token;
async function request(route,data){const r=await fetch(app.url+route,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Mindwise-Token':token},...(data===undefined?{}:{body:JSON.stringify(data)})});const result=await r.json();assert.equal(r.status,200,result.error||route);return result;}
try{
 const prior=evidence.stages.find(s=>s.stage==='new-session-current'),original=evidence.stages[0].state,artifact=prior.production.artifact,actual=path.join(root,artifact.path),bytes=readFileSync(actual),mtime=statSync(actual).mtimeMs;
 let state=await request('/api/state');assert.equal(state.runs.length,3);assert.ok([8,9].includes(state.revision));
 if(state.revision===8){assert.match(evidence.error,/取消は変更履歴/);assert.equal(state.history.filter(h=>h.operationId==='knowledge-evidence-changed').length,1);await request('/api/change',{baseRevision:8,operationId:'knowledge-undo-evidence-change',ops:[{type:'undo'}],meta:{actor:'owner',reason:null}});}
 state=await request('/api/state');assert.equal(state.revision,9);assert.equal(state.nodes.length,6);assert.equal(state.runs.length,3);assert.equal(state.history.filter(h=>h.operationId==='knowledge-undo-evidence-change').length,1);
 const analysis=await request('/api/analysis?targetId=know-work'),provenance=await request('/api/provenance?targetId=know-topic'),queue=await request('/api/knowledge');assert.equal(analysis.knowledge.status,'current');assert.equal(analysis.specification.effective.find(s=>s.key==='通行口').value,'北門');
 const withoutVersion=({version,...rest})=>rest;
 for(const id of ['know-new','know-other'])assert.deepEqual(withoutVersion(state.nodes.find(n=>n.id===id)),withoutVersion(original.nodes.find(n=>n.id===id)));
 assert.equal(provenance.entries.find(e=>e.operationId==='knowledge-seed').reason,null);assert.equal(provenance.entries.find(e=>e.operationId==='knowledge-correct-north').changes.find(c=>c.field==='specs').before[0].value,'東門');
 assert.deepEqual(readFileSync(actual),bytes);assert.equal(statSync(actual).mtimeMs,mtime);assert.equal(digest(bytes),artifact.sha256);assert.equal(state.nodes.find(n=>n.id==='know-work').verified,false);assert.ok(queue.items.some(n=>n.id==='know-organized'&&n.state==='hypothesis'));assert.ok(queue.items.some(n=>n.id==='know-new'&&n.state==='unorganized'));
 const main=await fetch('http://127.0.0.1:4316/api/state').then(r=>r.json()),mainHash=digest(JSON.stringify({revision:main.revision,nodes:main.nodes,links:main.links}));assert.equal(mainHash,evidence.stages[0].main.hash);
 const mainAnalysis=await fetch('http://127.0.0.1:4316/api/analysis').then(r=>r.json()),mainContracts=await fetch('http://127.0.0.1:4316/api/contracts').then(r=>r.json()),mainAsset=await fetch('http://127.0.0.1:4316/knowledge.js');assert.equal(mainAnalysis.numbers.byId['fa2f7bcf-ef72-4b39-af97-9c68b0c25e84'].value,4800);assert.equal(mainContracts.status,'approved');assert.equal(mainAsset.status,200);assert.equal(digest(await mainAsset.text()),digest(readFileSync(path.join(root,'public/knowledge.js'))));
 evidence.stages.push({stage:'restored-final-code',at:new Date().toISOString(),state,analysis,provenance,queue,realCalls:3,main:{revision:main.revision,nodes:main.nodes.length,hash:mainHash},artifact:{path:artifact.path,sha256:digest(bytes),bytes:bytes.length,mtimeMs:mtime,text:bytes.toString('utf8')},sourceHashes:Object.fromEntries(['src/knowledge.mjs','src/store.mjs','src/semantics.mjs','src/artifacts.mjs','src/codex.mjs','src/server.mjs','public/knowledge.js','public/app.js','public/sources.js','public/index.html'].map(name=>[name,digest(readFileSync(path.join(root,name)))]))});
 evidence.stages.at(-1).main.finalHttp={amount:4800,contracts:'approved',knowledgeJsStatus:200,knowledgeJsHash:digest(readFileSync(path.join(root,'public/knowledge.js'))),browserReload:'unverified'};
 evidence.continuation={error:'Checker attempted preview for undo; product intentionally requires direct history undo. Original error retained.',resolved:true,reset:false,newCodexCalls:0};writeFileSync(file,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({assertions:'passed',revision:9,nodes:6,realCalls:3,artifact:artifact.path,sha256:artifact.sha256}));
}finally{await app.close();}
