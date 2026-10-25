// Creates explicitly fictional failure states in the existing root16 test model.
// No real Codex process, authentication, API request, or paid model is used.
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {readFileSync,writeFileSync,existsSync,unlinkSync,realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createStore} from '../../src/store.mjs';
import {createCodexService} from '../../src/codex.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),evidence=path.join(root,'verification/2026-10-26/recovery-fixture.json');
const store=createStore({root,dataDir:path.join(root,'.runtime/spec-progress-workflow')});
try {
 if(existsSync(evidence)){console.log('Existing fixture retained; no changes.');process.exitCode=0;}
 else {
  const record={fixture:true,realCodexCalls:0,protocolAdapter:'simulated test adapter',createdAt:new Date().toISOString(),cases:[]};
  for(const [kind,title] of [['ready','回復試験：保存後に停止した制作'],['missing','回復試験：現物欠落で保留']]) {
   const targetId=`recovery-fixture-${kind}-2026-10-26`;
   assert.ok(!store.getState().nodes.some(n=>n.id===targetId),'Do not overwrite an existing fixture');
   store.change({baseRevision:store.getState().revision,operationId:`seed-${targetId}`,ops:[{type:'add',node:{id:targetId,title,domain:'回復の架空試験',parentId:'goal',body:'部分制作の回復を確認する架空の故障試験。応答は試験用の固定データであり、実Codexの制作や認証成立の証拠ではない。'}}],meta:{actor:'owner',reason:'承認済みA9の現物回復を、新版の架空素材で確認する。'}});
   const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('exit',0));};
   const emit=message=>child.stdout.write(JSON.stringify(message)+'\n');
   createInterface({input:child.stdin}).on('line',line=>{
    const msg=JSON.parse(line);if(!msg.method||!('id' in msg))return;
    const result=msg.method==='account/read'?{account:{type:'chatgpt'}}:msg.method.startsWith('thread/')?{thread:{id:'fixture-only-thread'}}:msg.method==='turn/start'?{turn:{id:'fixture-only-turn'}}:{};
    queueMicrotask(()=>emit({id:msg.id,result}));
   });
   const injectedStore={...store,change(payload,...args){if(payload.operationId.startsWith('ai-'))throw new Error('架空の故障注入：現物保存後のモデル保存停止');return store.change(payload,...args);}};
   const ai=createCodexService({root,store:injectedStore,spawnProcess:()=>child,resolveMcpOverrides:async()=>[]});
   await ai.start({targetId,prompt:'故障試験用の固定応答を受け取る。実モデルは呼び出さない。'});
   const proposal={reply:'架空の回復試験応答。実Codexの制作ではありません。',updatedBody:null,settings:null,decisionReason:'A9の故障窓を再現するため、試験用の固定テキストを保存した。',children:[{title:'回復で接続する資料メモ',body:'架空の回復試験。接続が重複しないことを確認する。',domain:'回復の架空試験'}],artifacts:[{name:'recovery-check.md',content:'# 架空の部分結果回復試験\n\nこの本文は故障試験用の固定データです。実Codexの制作ではありません。\n現物を再作成せず、モデルへの接続だけを回復します。\n'}]};
   if(kind==='missing')proposal.artifacts.push({name:'missing-check.md',content:'欠落状態を再現する試験専用ファイル。'});
   emit({method:'item/completed',params:{threadId:'fixture-only-thread',item:{type:'agentMessage',text:JSON.stringify(proposal)}}});
   emit({method:'turn/completed',params:{threadId:'fixture-only-thread',turn:{id:'fixture-only-turn',status:'completed'}}});
   await new Promise(r=>setImmediate(r));
   const run=store.getState().runs.at(-1);assert.equal(run.status,'partial');
   if(kind==='missing') {
    const missing=realpathSync(path.join(root,run.artifacts[1].path)),expectedDir=realpathSync(path.join(root,'artifacts',run.id));
    assert.equal(path.dirname(missing),expectedDir,'Delete only the just-created fictional fixture file');unlinkSync(missing);
   }
   store.recordRun({...run,fixture:{kind:'simulated-response',realCodex:false},status:'interrupted',artifacts:[],threadId:undefined,turnId:undefined,output:undefined});
   ai.close();record.cases.push({kind,targetId,title,runId:run.id,expectedArtifacts:run.artifacts,expectedChildId:`${run.id}:child:0`,expectedChildTitle:proposal.children[0].title});
  }
  record.revision=store.getState().revision;writeFileSync(evidence,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record));
 }
}finally{store.close();}
