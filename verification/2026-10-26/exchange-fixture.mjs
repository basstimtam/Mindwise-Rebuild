// Fictional isolated exchange fixture. No Codex call, owner acceptance, or external file read.
import {createStore} from '../../src/store.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=process.cwd(),runtime=resolve(root,'.runtime'),source=createStore({root,dataDir:resolve(runtime,'exchange-source-fixture')}),target=createStore({root,dataDir:resolve(runtime,'exchange-workflow')});
try {
 if(source.getState().revision||target.getState().revision)throw new Error('This fixture requires new dedicated stores; it never resets existing data.');
 const meta={actor:'codex',reason:'架空書籍の用語統一のため、主人公の呼称をナギに揃える。実Codexの応答ではなく交換保全の試験データ。',inputs:[{id:'exchange-same',title:'架空の旧稿',version:1,body:'元の本文は「ナミ」。'}],sourceRefs:[{documentId:'fixture',revision:'fictional-1',text:'架空資料：主人公の呼称はナギ。契約や権限ではない。'}]};
 source.change({baseRevision:0,operationId:'fixture-create',ops:[{type:'add',node:{id:'exchange-same',title:'交換試験：呼称の判断',body:'元の本文は「ナミ」。',domain:'交換の架空試験'}}]});
 source.change({baseRevision:1,operationId:'fixture-decision',meta,ops:[{type:'update',id:'exchange-same',patch:{body:'主人公の呼称を「ナギ」に統一。架空の交換試験。'}},{type:'add',node:{id:'exchange-added',title:'交換試験：資料',body:'資料の本文を保全する。',parentId:'exchange-same',domain:'交換の架空試験'}},{type:'link',link:{id:'exchange-relation',from:'exchange-same',to:'exchange-added',type:'relates_to'}}]});
 source.recordRun({id:'fictional-exchange-run',projectId:source.projectId,targetId:'exchange-same',targetVersion:1,status:'completed',threadId:'fictional-do-not-resume',decisionReason:meta.reason,prompt:'交換保全の固定データ。実Codex呼出なし。',reply:'交換試験用の原記録。',fixture:{kind:'exchange-test',actualCodexCalls:0}});
 target.change({baseRevision:0,operationId:'fixture-local',meta:{actor:'owner',reason:'架空の既存モデル。実オーナーの受入ではない。'},ops:[{type:'add',node:{id:'exchange-same',title:'交換前の同ID',body:'置換前の本文。',domain:'交換の架空試験'}},{type:'add',node:{id:'exchange-removed',title:'交換で取り除く枝',domain:'交換の架空試験'}}]});
 const data=source.exportState();data.projectId='fictional-source-project';
 mkdirSync(resolve(runtime,'exchange-evidence'),{recursive:true});
 writeFileSync(resolve(runtime,'exchange-evidence','input.json'),JSON.stringify(data));
 writeFileSync(resolve(runtime,'exchange-evidence','unknown.json'),JSON.stringify({...data,unsupportedFixture:true}));
 writeFileSync(resolve(root,'verification/2026-10-26/exchange-fixture.json'),JSON.stringify({kind:'fictional-exchange-fixture',actualCodexCalls:0,sourceProjectId:data.projectId,sourceRevision:data.revision,targetRevision:target.getState().revision,sourceEvents:data.events.length,sourceRuns:data.runs.length,targetIds:target.getState().nodes.map(n=>n.id),inputFile:'.runtime/exchange-evidence/input.json'},null,2));
 console.log(JSON.stringify({sourceRevision:data.revision,targetRevision:target.getState().revision}));
}finally{source.close();target.close();}
