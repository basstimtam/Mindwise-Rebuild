import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createCodexService, artifactPath, disabledMcpOverrides } from '../src/codex.mjs';

function setup(t, {resolveMcpOverrides=async()=>[]}={}) {
  const root=mkdtempSync(join(tmpdir(),'mindwise-codex-'));
  const store=createStore({root,dataDir:join(root,'data')});
  store.change({baseRevision:0,operationId:'seed',ops:[{type:'add',node:{id:'a',title:'主人公',body:'現在の仕様',x:80,y:70}}]});
  const proc=new EventEmitter(); proc.stdin=new PassThrough(); proc.stdout=new PassThrough(); proc.stderr=new PassThrough();
  proc.kill=()=>{proc.killed=true;queueMicrotask(()=>proc.emit('exit',0));};
  const requests=[]; let args;
  const emit=message=>proc.stdout.write(JSON.stringify(message)+'\n');
  createInterface({input:proc.stdin}).on('line',line=>{
    const msg=JSON.parse(line);requests.push(msg);
    if (!msg.method || !('id' in msg)) return;
    const result=msg.method==='account/read'?{account:{type:'chatgpt'}}:
      msg.method.startsWith('thread/')?{thread:{id:'thread-a'}}:
      msg.method==='turn/start'?{turn:{id:'turn-a'}}:{};
    queueMicrotask(()=>emit({id:msg.id,result}));
  });
  const ai=createCodexService({store,root,resolveMcpOverrides,spawnProcess:(_exe,a)=>{args=a;return proc;}});
  t.after(()=>{ai.close();store.close();rmSync(root,{recursive:true,force:true});});
  const complete=result=>{
    emit({method:'item/completed',params:{threadId:'thread-a',item:{type:'agentMessage',text:JSON.stringify(result)}}});
    emit({method:'turn/completed',params:{threadId:'thread-a',turn:{id:'turn-a',status:'completed'}}});
  };
  return {root,store,ai,requests,get args(){return args;},emit,complete};
}
const output=()=>({reply:'制作しました',updatedBody:null,decisionReason:'現在の仕様に従った',children:[],artifacts:[{name:'intro.md',content:'現在の仕様の主人公'}]});

test('stdio production uses supported stable parameters and returns real artifacts to the bound node',async t=>{
  const f=setup(t);await f.ai.start({targetId:'a',prompt:'紹介文を作成'});
  assert.ok(f.args.includes('approval_policy="on-request"'));
  assert.ok(f.args.includes('features.shell_tool=false'));
  assert.ok(!f.args.some(a=>a.includes('untrusted')));
  for(const req of f.requests.filter(r=>['thread/start','turn/start'].includes(r.method))) assert.ok(!('environments' in req.params));
  // Unsupported approval/tool requests cannot cause a host operation.
  f.emit({id:900,method:'item/commandExecution/requestApproval',params:{}});
  assert.equal(f.requests.find(r=>r.id===900)?.error?.code,-32000);
  f.complete({...output(),children:[{title:'具体案',body:'詳細',domain:'登場人物'}]});
  await new Promise(r=>setImmediate(r));
  const state=f.store.getState(),run=state.runs.at(-1),target=state.nodes.find(n=>n.id==='a');
  assert.equal(run.status,'completed');assert.equal(run.targetId,'a');assert.equal(target.verified,false);
  assert.equal(readFileSync(join(f.root,run.artifacts[0].path),'utf8'),'現在の仕様の主人公');
  assert.equal(target.artifact,run.artifacts[0].path);
  const child=state.nodes.find(n=>n.parentId==='a');assert.equal(child.status,'planned');assert.equal(child.x,325);
  assert.equal(f.ai.events().revision,state.revision);
});

test('an old target version produces a preserved proposal, never a current-model overwrite or file write',async t=>{
  const f=setup(t);await f.ai.start({targetId:'a',prompt:'制作'});
  f.store.change({baseRevision:1,operationId:'owner-correction',ops:[{type:'update',id:'a',patch:{body:'訂正済みの仕様'}}]});
  f.complete(output());await new Promise(r=>setImmediate(r));
  const state=f.store.getState(),run=state.runs.at(-1);
  assert.equal(run.status,'needs_review');assert.equal(state.nodes[0].body,'訂正済みの仕様');
  assert.ok(run.proposal);assert.ok(!existsSync(join(f.root,'artifacts')));
});

test('restart retains the last execution evidence and resume supplies corrected context plus prior reason',async t=>{
  const f=setup(t);await f.ai.start({targetId:'a',prompt:'制作'});f.complete(output());await new Promise(r=>setImmediate(r));
  f.store.change({baseRevision:f.store.getState().revision,operationId:'correction',ops:[{type:'update',id:'a',patch:{body:'訂正後'}}]});
  const reader=createCodexService({store:f.store,root:f.root});
  assert.equal(reader.events().run.status,'completed');assert.ok(reader.events().events.length);
  reader.close();
  await assert.rejects(()=>f.ai.start({targetId:'a',prompt:'続き',threadId:'unregistered'}),/未登録/);
  await f.ai.start({targetId:'a',prompt:'続き',threadId:'thread-a'});
  const request=f.requests.filter(r=>r.method==='turn/start').at(-1);
  assert.match(request.params.input[0].text,/訂正後/);assert.match(request.params.input[0].text,/現在の仕様に従った/);
});

test('artifact paths reject traversal, alternate streams and reserved Windows names',t=>{
  const f=setup(t);
  for(const name of ['../escape.md','sub/file.md','a:stream.md','CON.txt','x.md.']) assert.throws(()=>artifactPath(f.root,'run-a',name));
  assert.throws(()=>artifactPath(f.root,'../other','ok.md'));
});

test('MCP restrictions replace resolved transports, verify disablement and reject unverified output',async()=>{
  let calls=0;
  const overrides=await disabledMcpOverrides({cli:'unused',configArgs:[],runCli:async args=>{
    calls++;if(calls===2)assert.ok(args.some(a=>a.includes('mcp_servers=') && a.includes('inline_server') && a.includes('enabled = false')));
    return JSON.stringify([{name:'inline_server',enabled:calls===1}]);
  }});
  assert.equal(calls,2);assert.ok(overrides.some(a=>a.includes('inline_server') && a.includes('command = \"mindwise-disabled\"')));
  let quotedCalls=0; const quoted=await disabledMcpOverrides({cli:'unused',configArgs:[],runCli:async args=>{quotedCalls++;return JSON.stringify([{name:'quoted.dotted',enabled:quotedCalls===1}]);}}); assert.ok(quoted.some(a=>a.includes('\"quoted.dotted\"')));
  await assert.rejects(()=>disabledMcpOverrides({cli:'unused',configArgs:[],runCli:async()=>JSON.stringify([{name:'remaining',enabled:true}])}),/無効化を確認できない/);
});

test('coordinate changes and unrelated edits do not discard production for an unchanged semantic context',async t=>{
  const f=setup(t);await f.ai.start({targetId:'a',prompt:'制作'});
  f.store.change({baseRevision:1,operationId:'layout-change',ops:[{type:'update',id:'a',patch:{x:900}},{type:'add',node:{id:'unrelated',title:'別の領域'}}]});
  f.complete(output());await new Promise(r=>setImmediate(r));
  assert.equal(f.store.getState().runs.at(-1).status,'completed');assert.equal(f.store.getState().nodes.find(n=>n.id==='a').x,900);
});

test('interrupt during asynchronous connection preflight cannot start a late turn or corrupt a retry',async t=>{
  let release, calls=0;
  const f=setup(t,{resolveMcpOverrides:()=>++calls===1?new Promise(r=>release=r):Promise.resolve([])});
  const starting=f.ai.start({targetId:'a',prompt:'制作'});
  await new Promise(r=>setImmediate(r));await f.ai.interrupt();
  assert.equal(f.ai.status().run.status,'interrupted');
  release([]);await assert.rejects(()=>starting,/中断/);
  assert.equal(f.args,undefined);assert.equal(f.requests.some(r=>r.method==='turn/start'),false);
  await f.ai.start({targetId:'a',prompt:'再試行'});
  assert.equal(f.ai.status().active,true);assert.equal(f.ai.status().run.status,'running');
});

test('completion arriving after an interrupt request cannot write artifacts',async t=>{
  const f=setup(t);await f.ai.start({targetId:'a',prompt:'制作'});
  await f.ai.interrupt();f.complete(output());await new Promise(r=>setImmediate(r));
  assert.equal(f.ai.status().run.status,'interrupted');assert.equal(f.ai.status().active,false);
  assert.ok(!existsSync(join(f.root,'artifacts')));
});
