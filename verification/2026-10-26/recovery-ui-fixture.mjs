// Dedicated fictional recovery states. Never opens/resets the normal test DB.
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createInterface} from 'node:readline';
import {existsSync,readFileSync,writeFileSync,statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createStore} from '../../src/store.mjs';
import {createCodexService} from '../../src/codex.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),dataDir=path.join(root,'.runtime/recovery-ui-workflow'),evidence=path.join(root,'verification/2026-10-26/recovery-ui-fixture.json');
assert.equal(process.cwd(),root,'Run only from the new root16');
assert.ok(!existsSync(path.join(dataDir,'mindwise.sqlite'))&&!existsSync(evidence),'Existing fixture must be retained; no reset');
const cases=[['connect','回復画面試験：通常の接続'],['record-only','回復画面試験：取消と後続編集を保つ'],['loss-record','回復画面試験：接続受領後に応答失敗'],['loss-done','回復画面試験：回復記録保存後に応答失敗']].map(([kind,title])=>({kind,title,targetId:`recovery-ui-${kind}`}));
const store=createStore({root,dataDir});
try {
 store.change({baseRevision:0,operationId:'seed-recovery-ui',ops:cases.map(c=>({type:'add',node:{id:c.targetId,title:c.title,domain:'回復UIの架空試験',body:'回復画面の故障試験用の架空資料。固定応答であり実Codex制作やオーナー受入の証拠ではありません。',x:80,y:80+cases.indexOf(c)*130}})),meta:{actor:'owner',reason:'承認済みA5/A9の回復UIを、新しい隔離保存先の架空素材で確認する。'}});
 for(const c of cases) {
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{child.killed=true;queueMicrotask(()=>child.emit('exit',0));};
  const emit=msg=>child.stdout.write(JSON.stringify(msg)+'\n');
  createInterface({input:child.stdin}).on('line',line=>{const msg=JSON.parse(line);if(!msg.method||!('id' in msg))return;const result=msg.method==='account/read'?{account:{type:'chatgpt'}}:msg.method.startsWith('thread/')?{thread:{id:'fictional-thread'}}:msg.method==='turn/start'?{turn:{id:'fictional-turn'}}:{};queueMicrotask(()=>emit({id:msg.id,result}));});
  const injected={...store,change(payload,...args){if(c.kind!=='record-only'&&payload.operationId.startsWith('ai-'))throw new Error('架空試験：現物保存後、モデル接続前に停止');return store.change(payload,...args);},recordRun(run){if(c.kind==='record-only'&&run.status==='completed')throw new Error('架空試験：モデル受領後、終端記録前に停止');return store.recordRun(run);}};
  const ai=createCodexService({root,store:injected,spawnProcess:()=>child,resolveMcpOverrides:async()=>[]});
  try {
   await ai.start({targetId:c.targetId,prompt:'架空の回復UI試験。固定応答の接続だけを調べる。実モデルは呼び出さない。'});
   const proposal={reply:'架空の回復画面試験応答です。実Codexの制作ではありません。',updatedBody:'回復で接続する架空の本文。現物の受入確認は別です。',settings:null,decisionReason:'A5/A9の保存境界を固定応答で調べるための架空資料。',children:[{title:`架空の資料メモ：${c.kind}`,body:'一度だけ接続する資料。実案件の成果ではない。',domain:'回復UIの架空試験'}],artifacts:[{name:'recovery-ui.md',content:`# 回復UIの架空試験 ${c.kind}\n\n固定応答の故障試験資料です。実Codexの制作ではありません。\nファイルを書き直さず、接続を回復します。\n`} ]};
   emit({method:'item/completed',params:{threadId:'fictional-thread',item:{type:'agentMessage',text:JSON.stringify(proposal)}}});emit({method:'turn/completed',params:{threadId:'fictional-thread',turn:{id:'fictional-turn',status:'completed'}}});
   await new Promise(r=>setImmediate(r));
   const run=store.getState().runs.at(-1);assert.equal(run.status,'partial');assert.equal(run.artifacts.length,1);
   store.recordRun({...run,fixture:{kind:'simulated-ui-recovery',realCodex:false},threadId:undefined,turnId:undefined,output:undefined,status:'interrupted',artifacts:[]});
   c.runId=run.id;c.expectedChildId=`${run.id}:child:0`;c.expectedBody=proposal.updatedBody;
   c.files=run.artifacts.map(a=>({...a,mtimeMs:statSync(path.join(root,a.path)).mtimeMs,sha256:createHash('sha256').update(readFileSync(path.join(root,a.path))).digest('hex')}));
   if(c.kind==='record-only') {
    c.originalReceiptRevision=store.operationReceipt(`ai-${run.id}`).revision;
    store.change({baseRevision:store.getState().revision,operationId:'undo-recovery-ui-receipt',ops:[{type:'undo'}]});
    store.change({baseRevision:store.getState().revision,operationId:'later-recovery-ui-edit',ops:[{type:'update',id:c.targetId,patch:{body:'保護する後続編集：接続は取り消した。この本文と、追加し直していない子の状態を保持する。'}}],meta:{actor:'owner',reason:'架空試験で取消後の編集を再適用から保護する。'}});
   }
  }finally{ai.close();}
 }
 const state=store.getState();assert.equal(state.revision,4);assert.equal(state.nodes.length,4);assert.ok(state.runs.every(r=>r.fixture&&!r.threadId&&!r.turnId));
 const record={fixture:true,realCodexCalls:0,createdAt:new Date().toISOString(),dataDir:'.runtime/recovery-ui-workflow',port:4317,revision:state.revision,cases,initialNodes:state.nodes};
 writeFileSync(evidence,JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify({revision:state.revision,cases:cases.map(({kind,runId})=>({kind,runId})),realCodexCalls:0}));
}finally{store.close();}
