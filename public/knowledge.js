const states={unorganized:'未整理',unknown:'不明',hypothesis:'仮説',adopted:'採用判断'};
const issues={cycle:'根拠が循環しています',limit:'根拠の照合上限を超えています',missing:'対象がありません','content-changed':'記録後に主題の内容が変わっています','imported-unadopted':'取込元の判断です。この保存先では未採用です',unsettled:'現在の制作判断は未確定です','evidence-changed':'根拠が記録時から変わっています','evidence-missing':'根拠が見つかりません','evidence-unreadable':'根拠の現物を照合できません'};
const snapshot=n=>n?{title:n.title,body:n.body,specs:n.specs||[],knowledge:n.knowledge||null}:null;
const specsText=specs=>(specs||[]).map(s=>`${s.key} = ${s.value}`).join('\n');

export function createKnowledgeUi({api,el,field,button,getState,getNode,getAnalysis,change,choose,openProvenance,toast}) {
 const queue=el('dialog'),queueHead=el('div','dialog-head'),queueList=el('div');queue.id='knowledgeQueueDialog';queueHead.append(el('h2','','未整理情報と現在の判断'),button('閉じる',()=>queue.close()));queue.append(queueHead,el('p','small-note','明示して知識を記録した主題です。未整理・不明・仮説を採用判断に数えません。未記録の枝は地図から選び、原情報として記録できます。'),queueList);document.body.append(queue);
 const drafts=new Map(),dialog=el('dialog'),head=el('div','dialog-head'),heading=el('h2'),close=button('戻る',()=>{if(!pending)dialog.close();});
 dialog.id='knowledgeDialog';head.append(heading,close);
 const note=el('p','small-note','原情報は別の枝に保持します。採用判断と現物の受入確認は別です。記録のない過去の理由を、今回の理由で補いません。'),status=el('p','small-note'),form=el('form'),fields=el('div'),evidenceBox=el('section','analysis-section'),conflictBox=el('section'),actions=el('div','dialog-actions'),save=el('button','primary','差分と影響を確認');
 save.type='submit';actions.append(save);form.append(fields,evidenceBox,conflictBox,actions);dialog.append(head,note,status,form);document.body.append(dialog);
 let active=null,pending=false,epoch=0;const disabledBeforePending=new Map();
 dialog.addEventListener('cancel',e=>{if(pending)e.preventDefault();});
 const safe=fn=>async()=>{try{await fn();}catch(e){toast(e.message,true);}};
 document.querySelector('#knowledgeQueue').onclick=safe(async()=>{
  const result=await api('/api/knowledge');queueList.replaceChildren();
  for(const item of [...result.items].sort((a,b)=>(a.state==='adopted')-(b.state==='adopted'))){
   const row=el('section','provenance-entry');row.append(button(item.title,()=>{queue.close();choose(item.id);}),el('strong','',`${states[item.state]} · ${item.needsAdoption?'取込元・当地では未採用':item.assessment.status==='current'?'根拠の照合一致':'未確定・再確認が必要'}`),el('p','small-note',`記録理由：${item.reason||'記録なし・不明'}`));
   if(item.usedBy.length)row.append(el('p','small-note',`根拠として結ばれた主題：${item.usedBy.map(n=>n.title).join('、')}`));queueList.append(row);
  }
  if(!result.items.length)queueList.append(el('p','small-note','知識状態を記録した主題はまだありません。枝を選び「この主題を記録・訂正」か「この原情報から主題を作る」を使います。'));
  if(!queue.open)queue.showModal();
 });
 const provenance=(id,operationId)=>safe(()=>openProvenance(id,operationId));
 function name(id){return getNode(id)?.title||'削除・欠落した根拠';}
 function describe(value){if(!value)return '対象がありません。';const k=value.knowledge;return `${value.title}\n${value.body||''}\n設定：${specsText(value.specs)||'なし'}\n状態：${states[k?.state]||'未記録'}\n記録理由：${k?.reason||'記録なし・不明'}\n根拠：${k?.evidence.map(r=>name(r.nodeId)).join('、')||'枝としての登録なし'}`;}
 function freshness(row,report) {
  if(!row)return '照合待ち';
  if(row.needsAdoption)return '取込元の判断・この保存先では未採用';
  if(!row.contentCurrent)return '内容変更後の再確認が必要';
  if((report.issues||[]).some(i=>i.nodeId===row.nodeId))return '根拠・判断の再確認が必要';
  return '記録時の内容と根拠が一致';
 }
 function referenceButton(id,text){const b=button(text,()=>choose(id),'source-button');b.disabled=!getNode(id);return b;}
 function renderTarget(n) {
  const box=el('section','analysis-section'),k=n.knowledge,report=getAnalysis()?.knowledge,row=report?.rows?.find(r=>r.nodeId===n.id);
  box.append(el('div','section-title','主題の知識'));
  if(!k)box.append(el('p','small-note','知識状態は未記録です。採用済みとは扱いません。過去の判断理由は記録なし・不明です。'));
  else {
   box.append(el('strong','',`${states[k.state]||'状態不明'} · ${freshness(row,report||{})}`),el('p','',`今回の記録理由：${k.reason?.trim()?k.reason:'記録なし・不明'}`));
   if(k.state==='unorganized')box.append(el('p','small-note','未整理の原情報です。主題として整理する際も、この枝の内容は保持します。'));
   box.append(el('p','small-note','通常の詳細欄で本文・設定等を変えると、この知識記録との再照合が必要になります。「記録・訂正」で今回の判断と根拠を保存できます。'));
   if(k.needsAdoption&&!row)box.append(el('p','conflict-note','取込元の知識記録です。この保存先での採用と根拠の照合が必要です。'));
   if(!row)box.append(el('p','small-note','現在の本文・根拠・現物との照合を待っています。'));
   for(const ref of row?.evidence||k.evidence||[]){const live=row?.evidence?.find(e=>e.nodeId===ref.nodeId),label={current:'記録時と一致',changed:'変更あり',missing:'欠落',unreadable:'読取未確認'}[live?.status]||'照合待ち';box.append(referenceButton(ref.nodeId,`根拠：${name(ref.nodeId)} · ${label}`),el('small','small-note',`記録時の対象版 ${ref.version}`));}
   if(!k.evidence?.length)box.append(el('p','small-note','枝として結んだ根拠はありません。理由の記録と現物による検証を区別します。'));
   box.append(button('今回の判断と変更へ',provenance(n.id,k.operationId),'source-button'));
   if(k.previousOperationId)box.append(button('訂正前の判断と理由へ',provenance(n.id,k.previousOperationId),'source-button'));
  }
  if(report) {
   for(const issue of report.issues||[])box.append(el('p','conflict-note',`${name(issue.nodeId)}：${issues[issue.type]||'根拠を再確認してください'}${issue.evidenceId?`（${name(issue.evidenceId)}）`:''}`));
   const related=(report.rows||[]).filter(r=>r.nodeId!==n.id);
   if(related.length)box.append(el('div','section-title','適用元・根拠の知識'));
   for(const source of related)box.append(referenceButton(source.nodeId,`${source.title} · ${states[source.state]||'状態不明'} · ${freshness(source,report)}`),el('p','small-note',`記録理由：${source.reason?.trim()?source.reason:'記録なし・不明'}`));
  }
  box.append(button('この主題を記録・訂正',()=>open(n.id,false)),button('この原情報から主題を作る',()=>open(n.id,true)));
  return box;
 }
 function open(id,creating) {
  if(pending)return toast('保存の結果を照合しています。');
  const n=getNode(id);if(!n)return toast('対象が見つかりません。',true);
  const key=`${creating?'new':'edit'}:${id}`;
  if(!drafts.has(key))drafts.set(key,{key,creating,sourceId:id,id:creating?crypto.randomUUID():id,baseRevision:getState().revision,version:n.version,sourceBefore:snapshot(n),before:creating?null:snapshot(n),values:{title:creating?`${n.title}の主題`:n.title,body:creating?'':n.body,specsText:creating?'':specsText(n.specs),state:creating?'hypothesis':n.knowledge?.state||'unknown',reason:''},evidenceIds:creating?[id]:(n.knowledge?.evidence||[]).map(r=>r.nodeId)});
  active=drafts.get(key);drawEditor();if(!dialog.open)dialog.showModal();
 }
 function drawEditor() {
  const d=active;if(!d)return;
  heading.textContent=d.creating?'原情報から主題を作る':'主題の知識を記録・訂正';
  status.className='small-note';status.textContent=`${name(d.sourceId)} · 開いた時の保存版 ${d.baseRevision} / 対象版 ${d.version}。${d.creating?'元の枝は変更しません。':'同じ主題IDへ今回の判断を記録します。'}`;
  fields.replaceChildren();conflictBox.replaceChildren();
  if(d.creating){const original=el('details');original.open=true;original.append(el('summary','','整理元の原情報'),el('pre','source-excerpt',`${d.sourceBefore.title}\n${d.sourceBefore.body}\n\n${specsText(d.sourceBefore.specs)}\n\n記録理由：${d.sourceBefore.knowledge?.reason?.trim()?d.sourceBefore.knowledge.reason:'記録なし・不明'}`));fields.append(original);}
  const definitions=[['主題の名前','title','text'],['現在の内容・整理したこと','body','textarea'],['この主題の設定（名前 = 値、一行に一つ）','specsText','textarea'],['知識の状態','state','select'],['今回の記録・訂正の理由','reason','textarea']];
  for(const [label,key,type] of definitions){const f=field(label,`knowledge-${key}`,d.values[key],type,key==='state'?Object.entries(states):undefined),control=f.querySelector('input,textarea,select');control.maxLength=key==='reason'?4000:100000;if(key==='title')control.required=true;if(control.tagName==='TEXTAREA')control.rows=key==='body'?6:3;control.addEventListener('input',()=>{d.values[key]=control.value;updateReasonRequirement();});control.addEventListener('change',()=>{d.values[key]=control.value;updateReasonRequirement();});fields.append(f);}
  if(d.before?.knowledge)fields.append(el('p','small-note',`訂正前の記録理由：${d.before.knowledge.reason?.trim()?d.before.knowledge.reason:'記録なし・不明'}。今回の理由とは別の過去記録です。`));
  fields.append(el('p','small-note','採用判断には今回の理由が必要です。未整理・仮説・不明は、理由が未記録なら空欄にできます。設定にしていない本文の意味を自動的に確定しません。'));
  updateReasonRequirement();drawEvidence();setPending(false);
  if(getState().revision!==d.baseRevision||getNode(d.sourceId)?.version!==d.version)showConflict();
 }
 function updateReasonRequirement(){const reason=fields.querySelector('[name="knowledge-reason"]');if(reason)reason.required=active?.values.state==='adopted';}
 function drawEvidence() {
  const d=active;if(!d)return;
  evidenceBox.replaceChildren(el('div','section-title',`根拠の枝 ${d.evidenceIds.length} / 20`),el('p','small-note','選んだ根拠の本文・設定と、結ばれた現物を保存時に照合します。元の内容は変更しません。'));
  for(const id of d.evidenceIds){const row=el('div','metric-reference');row.append(referenceButton(id,name(id)),button('根拠から外す',()=>{d.evidenceIds=d.evidenceIds.filter(v=>v!==id);drawEvidence();}));evidenceBox.append(row);}
  const picker=field('根拠へ加える枝','knowledge-evidence','','select',[['','枝を選択'],...getState().nodes.filter(n=>n.id!==d.id&&!d.evidenceIds.includes(n.id)).map(n=>[n.id,n.title])]),add=button('根拠を追加',()=>{const id=picker.querySelector('select').value;if(!id||d.evidenceIds.includes(id))return;if(d.evidenceIds.length>=20)return toast('根拠は20件までです。',true);d.evidenceIds.push(id);drawEvidence();});add.disabled=d.evidenceIds.length>=20;evidenceBox.append(picker,add);
 }
 function parseSpecs(text){const keys=new Set();return text.split(/\r?\n/).filter(line=>line.trim()).map(line=>{const split=line.indexOf('=');if(split<1)throw new Error('設定は「名前 = 値」を一行に一つ入力してください。');const key=line.slice(0,split).trim(),value=line.slice(split+1).trim();if(!key||keys.has(key))throw new Error('設定名が空欄か重複しています。');keys.add(key);return {key,value};});}
 function setPending(value){pending=value;if(value){disabledBeforePending.clear();for(const control of form.querySelectorAll('input,textarea,select,button')){disabledBeforePending.set(control,control.disabled);control.disabled=true;}}else{for(const [control,disabled] of disabledBeforePending)control.disabled=disabled;disabledBeforePending.clear();}close.disabled=value;}
 function showConflict(message='保存版または対象が変わりました。下書きを保持しています。現在値と差分を確認してから編集を再開してください。') {
  const d=active,current=d&&getNode(d.sourceId);if(!d)return;
  status.textContent=message;status.className='conflict-note';conflictBox.replaceChildren(el('div','section-title','現在値と下書きの照合'),el('pre','source-excerpt',`開いた時の内容\n${describe(d.sourceBefore)}\n\n現在の内容\n${describe(snapshot(current))}\n\n保持した下書き\n${d.values.title}\n${d.values.body}\n設定：${d.values.specsText||'なし'}\n状態：${states[d.values.state]}\n今回の理由：${d.values.reason||'未入力'}\n根拠：${d.evidenceIds.map(name).join('、')||'枝としての登録なし'}`));
  if(current&&(!d.creating||!getNode(d.id)))conflictBox.append(button('この差分を確認して編集を再開',()=>{d.baseRevision=getState().revision;d.version=current.version;d.sourceBefore=snapshot(current);d.before=d.creating?null:snapshot(current);drawEditor();}));
  else if(d.creating&&getNode(d.id))conflictBox.append(button('保存された主題を確認',()=>{dialog.close();choose(d.id);void provenance(d.id)();}));
 }
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(pending||!active)return;
  const d=active,runEpoch=epoch;
  try {
   const current=getNode(d.sourceId);
   if(!current||getState().revision!==d.baseRevision||current.version!==d.version||d.creating&&getNode(d.id)){showConflict();return;}
   const patch={title:d.values.title.trim(),body:d.values.body,specs:parseSpecs(d.values.specsText)},reason=d.values.reason.trim()||null;
   if(!patch.title)throw new Error('主題の名前を入力してください。');
   if(d.values.state==='adopted'&&!reason)throw new Error('採用判断には今回の理由が必要です。');
   const ops=[];
   if(d.creating)ops.push({type:'add',node:{id:d.id,parentId:null,title:patch.title,domain:current.domain||'',depth:current.depth||0,x:(current.x||0)+245,y:(current.y||0)+100,kind:'concept'}});
   ops.push({type:'knowledge',id:d.id,patch,state:d.values.state,reason,evidenceIds:[...d.evidenceIds]});
   setPending(true);
   const saved=await change(ops,{review:{mode:'knowledge',targetId:d.id,reason,before:d.before,after:{...patch,knowledge:{state:d.values.state,reason,evidenceIds:d.evidenceIds}}},reason});
   if(epoch!==runEpoch)return;
   if(saved){drafts.delete(d.key);dialog.close();active=null;choose(d.id);toast(d.creating?'原情報を保持して主題を作りました。':'今回の判断を記録しました。過去の内容と理由は変更履歴へ残しています。');}
   else if(getState().revision!==d.baseRevision||getNode(d.sourceId)?.version!==d.version||d.creating&&getNode(d.id))showConflict('保存の結果と現在値を確認してください。下書きは保持しています。');
  }catch(error){if(epoch===runEpoch)toast(error.message,true);}
  finally{setPending(false);}
 });
 return {renderTarget,clear(){epoch++;drafts.clear();active=null;if(dialog.open)dialog.close();if(queue.open)queue.close();fields.replaceChildren();evidenceBox.replaceChildren();conflictBox.replaceChildren();}};
}
