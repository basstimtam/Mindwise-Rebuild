// Editing endpoints are explicit. They do not bound the downstream impact.
export const relationTypes={depends_on:'依存する（fromがtoに依存）',relates_to:'関連する',precedes:'工程の前にある（fromの後にto）',applies_to:'仕様を適用する（fromをtoへ）',exception_to:'fromの設定でtoの設定を置き換える',realizes:'実現する',verifies:'検証する'};
const fail=message=>{throw new Error(message);};
const id=value=>typeof value==='string'&&/^[\p{L}\p{N}_:.-]{1,160}$/u.test(value);
export function relationScope(state,targetId,candidates) {
 if(!Array.isArray(candidates)||candidates.length>20||candidates.some(v=>!id(v))||new Set(candidates).size!==candidates.length)fail('関係案の候補は重複のない対象IDで指定してください（選択対象を含め20件まで）');
 const nodeIds=[...new Set([targetId,...candidates])].sort();
 if(nodeIds.length<2||nodeIds.length>20||nodeIds.some(v=>!state.nodes.some(n=>n.id===v)))fail('関係案は選択対象と候補を合わせて2〜20件の既存対象に限定してください');
 const contextIds=new Set(nodeIds),queue=[...nodeIds];
 for(let i=0;i<queue.length;i++)for(const link of state.links)if(['applies_to','applies'].includes(link.type)&&link.to===queue[i]&&!contextIds.has(link.from)){
  contextIds.add(link.from);queue.push(link.from);if(contextIds.size>80)fail('候補の適用元を含む関係文脈が80件を超えています。候補を整理してください');
 }
 return {nodeIds,contextIds:[...contextIds]};
}
export function relationPlan(item,state) {
 const value=item.proposal,changes=value?.relationChanges;
 if(value?.settings!==null||value.updatedBody!==null||value.children?.length||value.artifacts?.length||!value.decisionReason?.trim()||value.decisionReason.length>4000||!Array.isArray(changes)||!changes.length||changes.length>20)fail('関係案は理由と1〜20件の関係追加・解除だけを返してください。本文・設定・枝・現物は変更できません');
 const scope=new Set(item.relationNodeIds);
 if(scope.size<2||scope.size>20||!scope.has(item.targetId)||[...scope].some(v=>!state.nodes.some(n=>n.id===v)))fail('開始時の関係候補が現在の地図にありません');
 const removed=new Set(),added=new Set(),rows=[],ops=[];
 const pair=row=>JSON.stringify([row.from,row.to,row.type]);
 for(const change of changes) {
  if(!change||Object.keys(change).some(k=>!['action','id','from','to','type','reason'].includes(k))||!['add','remove'].includes(change.action)||!scope.has(change.from)||!scope.has(change.to)||change.from===change.to||change.from!==item.targetId&&change.to!==item.targetId||!Object.hasOwn(relationTypes,change.type)||typeof change.reason!=='string'||!change.reason.trim()||change.reason.length>500)fail('関係の操作・候補・方向・種類・理由を確認してください。選択対象につながる関係だけを提案できます');
  if(change.action==='remove') {
   const old=state.links.find(l=>l.id===change.id);
   if(!id(change.id)||removed.has(change.id)||!old||pair(old)!==pair(change))fail('解除する関係のID・端点・種類が開始時の候補と一致しません');
   removed.add(change.id);rows.push({action:'remove',before:old,after:null,reason:change.reason.trim()});
  }else {
   if(change.id!==null||added.has(pair(change)))fail('追加する関係のIDや同じ関係の重複を確認してください');
   added.add(pair(change));rows.push({action:'add',before:null,after:{id:`ai-rel-${item.id}:${rows.length}`,from:change.from,to:change.to,type:change.type,reason:change.reason.trim()},reason:change.reason.trim()});
  }
 }
 for(const row of rows.filter(r=>r.action==='remove'))ops.push({type:'unlink',id:row.before.id});
 for(const row of rows.filter(r=>r.action==='add')) {
  if(state.links.some(l=>!removed.has(l.id)&&pair(l)===pair(row.after)))fail('同じ方向・種類の関係が既にあります。重複追加はしません');
  ops.push({type:'link',link:row.after});
 }
 return {ops,rows};
}
