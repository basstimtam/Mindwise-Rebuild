import {createHash} from 'node:crypto';

export const knowledgeStates={unorganized:'未整理',unknown:'不明',hypothesis:'仮説',adopted:'採用判断'};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields=['title','body','specs','sourceRefs','kind','unit','value','formula','metricInputs','metricSource','metricFreshness'];
export const knowledgeContent=node=>Object.fromEntries(fields.map(key=>[key,node?.[key]??null]));
export const knowledgeContentHash=node=>hash(knowledgeContent(node));
export const knowledgeModelHash=node=>hash({content:knowledgeContent(node),artifact:node?.artifact||'',criteria:node?.criteria||'',knowledge:node?.knowledge??null});
export const knowledgeDependencies=state=>(state.nodes||[]).flatMap(n=>(n.knowledge?.evidence||[]).map(ref=>({from:ref.nodeId,to:n.id})));

export function validateKnowledge(value,assert) {
 if(value===undefined||value===null)return;
 const object=v=>v&&typeof v==='object'&&!Array.isArray(v),digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),id=v=>typeof v==='string'&&/^[\p{L}\p{N}_:.-]{1,160}$/u.test(v);
 assert(object(value)&&Object.keys(value).every(k=>['state','reason','evidence','contentHash','operationId','previousOperationId','needsAdoption'].includes(k)),'知識記録の形式が不正です。');
 assert(Object.hasOwn(knowledgeStates,value.state)&&(value.reason===null||typeof value.reason==='string'&&value.reason.length<=4000),'知識の状態・理由を確認してください。');
 assert(value.state!=='adopted'||typeof value.reason==='string'&&value.reason.trim(),'採用判断には今回の理由が必要です。');
 assert(digest(value.contentHash)&&id(value.operationId)&&(value.previousOperationId===null||id(value.previousOperationId))&&typeof value.needsAdoption==='boolean','知識の内容指紋・操作記録が不正です。');
 assert(Array.isArray(value.evidence)&&value.evidence.length<=20&&new Set(value.evidence.map(r=>r?.nodeId)).size===value.evidence.length,'知識の根拠は重複のない20件以内にしてください。');
 for(const ref of value.evidence)assert(object(ref)&&Object.keys(ref).every(k=>['nodeId','version','modelHash','artifactHash'].includes(k))&&id(ref.nodeId)&&Number.isInteger(ref.version)&&ref.version>0&&digest(ref.modelHash)&&(ref.artifactHash===null||digest(ref.artifactHash)),'知識の根拠指紋が不正です。');
}

/** Roots are current production inputs; evidence may be raw/unorganized material.
 * Versions describe the observation. Semantic hashes deliberately ignore layout.
 */
export function assessKnowledge(state,rootIds,{observeArtifact}={}) {
 const nodes=new Map(state.nodes.map(n=>[n.id,n])),roots=new Set(rootIds),rows=[],issues=[],visited=new Set(),active=new Set();
 function visit(id) {
  if(active.has(id)){issues.push({nodeId:id,type:'cycle'});return;}
  if(visited.has(id))return;
  if(visited.size>=80){issues.push({nodeId:id,type:'limit'});return;}
  visited.add(id);active.add(id);
  const n=nodes.get(id),k=n?.knowledge;
  if(!n){issues.push({nodeId:id,type:'missing'});active.delete(id);return;}
  if(k){
   const row={nodeId:id,title:n.title,state:k.state,reason:k.reason,operationId:k.operationId,previousOperationId:k.previousOperationId,needsAdoption:k.needsAdoption,evidence:[],contentCurrent:k.contentHash===knowledgeContentHash(n)};
   rows.push(row);
   if(!row.contentCurrent)issues.push({nodeId:id,type:'content-changed'});
   if(k.needsAdoption)issues.push({nodeId:id,type:'imported-unadopted'});
   if(roots.has(id)&&k.state!=='adopted')issues.push({nodeId:id,type:'unsettled',state:k.state});
   for(const ref of k.evidence){
    const source=nodes.get(ref.nodeId),e={...ref,title:source?.title||ref.nodeId,currentModelHash:source?knowledgeModelHash(source):null,status:'current'};
    if(!source||e.currentModelHash!==ref.modelHash)e.status=source?'changed':'missing';
    if(source?.artifact&&observeArtifact){try{e.currentArtifactHash=observeArtifact(source).sha256;if(e.currentArtifactHash!==ref.artifactHash)e.status='changed';}catch{e.currentArtifactHash=null;e.status='unreadable';}}
    row.evidence.push(e);
    if(e.status!=='current')issues.push({nodeId:id,evidenceId:ref.nodeId,type:'evidence-'+e.status});
    visit(ref.nodeId);
   }
  }
  active.delete(id);
 }
 for(const id of roots)visit(id);
 return {status:issues.length?'unresolved':'current',fingerprint:rows.length?hash({rows,issues}):null,rows,issues,contextIds:[...visited]};
}

/** Server-built record: clients select evidence, never assert its fingerprints. */
export function recordKnowledge(state,op,operationId,{assert,observeArtifact}={}) {
 assert(op&&Object.keys(op).every(k=>['type','id','patch','state','reason','evidenceIds'].includes(k)),'未対応の知識操作があります。');
 const target=state.nodes.find(n=>n.id===op.id);
 assert(target,'知識を記録する主題がありません。',404);
 assert(op.patch&&typeof op.patch==='object'&&!Array.isArray(op.patch)&&Object.keys(op.patch).every(k=>['title','body','specs'].includes(k)),'主題の変更は表題・本文・設定に限定してください。');
 assert(Array.isArray(op.evidenceIds)&&op.evidenceIds.length<=20&&new Set(op.evidenceIds).size===op.evidenceIds.length&&!op.evidenceIds.includes(op.id),'根拠は自分以外の重複のない20件以内にしてください。');
 const updated={...target,...op.patch},evidence=op.evidenceIds.map(nodeId=>{
  const source=state.nodes.find(n=>n.id===nodeId);assert(source,'根拠の対象が見つかりません。',409);
  let artifactHash=null;
  if(source.artifact){assert(observeArtifact,'現物根拠を照合できません。');artifactHash=observeArtifact(source).sha256;}
  return {nodeId,version:source.version,modelHash:knowledgeModelHash(source),artifactHash};
 });
 const knowledge={state:op.state,reason:op.reason,evidence,contentHash:knowledgeContentHash(updated),operationId,previousOperationId:target.knowledge?.operationId||null,needsAdoption:false};
 validateKnowledge(knowledge,assert);
 const candidate={...updated,knowledge,verified:false,version:target.version+1};
 const next={...state,nodes:state.nodes.map(n=>n.id===op.id?candidate:n)},assessment=assessKnowledge(next,[op.id]);
 assert(!assessment.issues.some(i=>i.type==='cycle'||i.type==='limit'),'知識の根拠が循環しているか80件を超えています。');
 // An explicit adoption must start from the actual, current evidence.
 if(op.state==='adopted')assert(!assessment.issues.length,'古い・未採用の根拠を再確認してから判断を採用してください。',409);
 return candidate;
}
