const $ = q => document.querySelector(q);
const el = (tag, cls, text) => {const e=document.createElement(tag);if(cls)e.className=cls;if(text!==undefined)e.textContent=text;return e;};
const button = (label, action) => {const b=el('button','source-button',label);b.type='button';b.onclick=action;return b;};
const labels={approved:'承認済み原文と一致',record:'判断・承認の記録',draft:'DRAFT・未承認',missing:'原文が欠落',unknown:'状態不明',unreadable:'原文を読めません',changed:'承認済み原文から変更あり','revision-mismatch':'版が不一致','approval-unknown':'承認根拠を確認できません',current:'参照時の版と一致',stale:'参照後に変更あり'};
const runLabels={proposed:'設定案・未採用',adopted:'設定案・採用済み',completed:'制作終了・受入は別',needs_review:'古い版への提案',interrupted:'中断',failed:'失敗',partial:'部分結果',running:'制作中',connecting:'接続中',applying:'保存中'};

export function createSourcesUi({api,getNode,change,toast}) {
 let contracts=null,documentId='goal',section='',binding=null;
 const guarded=fn=>async()=>{try{await fn();}catch(e){toast(e.message,true);}};
 async function openContracts(id='goal',heading='') {
  contracts=await api('/api/contracts');documentId=id;section=heading;
  const n=getNode();binding=n?{id:n.id,version:n.version}:null;
  renderContract();if(!$('#contractsDialog').open)$('#contractsDialog').showModal();
 }
 function renderContract() {
  const tabs=$('#contractDocuments');tabs.replaceChildren();
  for(const doc of contracts.documents) {const b=button(doc.title,()=>{documentId=doc.id;section='';renderContract();});b.classList.toggle('active',doc.id===documentId);tabs.append(b);}
  const doc=contracts.documents.find(d=>d.id===documentId)||contracts.documents[0];documentId=doc.id;
  const metadata=$('#contractMetadata');metadata.replaceChildren(el('strong','',`${doc.revision||'版不明'} · ${labels[doc.status]||doc.status}`),el('p','small-note',`${doc.path} · 原文の状態：${doc.declaredStatus||'不明'}`));
  for(const issue of doc.issues||[])metadata.append(el('p','conflict-note',typeof issue==='string'?issue:JSON.stringify(issue)));
  if(doc.sha256)metadata.append(el('small','source-hash',`原文 SHA-256 ${doc.sha256}`));
  const select=$('#contractSection');select.replaceChildren();
  const all=el('option','','原文全文');all.value='';select.append(all);
  for(const item of doc.sections||[]) {const option=el('option','',item.heading);option.value=item.heading;select.append(option);}
  if(!doc.sections.some(s=>s.heading===section))section='';select.value=section;
  $('#contractText').textContent=(section?doc.sections.find(s=>s.heading===section)?.text:doc.text)||'原文を取得できません。欠落・不明を確定情報として扱いません。';
  $('#contractApproval').hidden=!doc.approval;
  $('#contractApproval').onclick=guarded(()=>openContracts('discovery',doc.approval?.section||'7. 引継ぎ後の全面レビューと実装GO（2026-10-25）'));
  const target=binding&&getNode(binding.id);
  $('#contractBinding').textContent=target?`結ぶ対象：${target.title} · 開いた時の版 ${binding.version}。出所の参照を保存しても、契約内容や実行権限は承認されません。`:'枝を選択すると、この原文を制作仕様の出所として結べます。';
  $('#attachContract').disabled=!target||!doc.sha256||!doc.text;
 }
 $('#contractsButton').onclick=guarded(()=>openContracts());
 $('#closeContracts').onclick=()=>$('#contractsDialog').close();
 $('#contractSection').onchange=e=>{section=e.target.value;renderContract();};
 $('#attachContract').onclick=guarded(async()=>{
  const doc=contracts.documents.find(d=>d.id===documentId),n=binding&&getNode(binding.id);
  if(!n||n.version!==binding.version)throw new Error('対象が変わっています。契約画面を開き直してください。');
  const current=await api('/api/contracts'),live=current.documents.find(d=>d.id===documentId);
  if(live?.sha256!==doc.sha256)throw new Error('原文が変わりました。契約画面を開き直してください。');
  if(getNode(binding.id)?.version!==binding.version)throw new Error('照合中に対象が変わりました。契約画面を開き直してください。');
  const ref={documentId,section,sha256:doc.sha256,revision:doc.revision||'不明'};
  const refs=n.sourceRefs||[];
  if(refs.some(r=>JSON.stringify(r)===JSON.stringify(ref)))return toast('この出所はすでに結ばれています。');
  if(await change([{type:'update',id:n.id,patch:{sourceRefs:[...refs,ref]}}])) {binding.version=getNode(n.id).version;renderContract();toast('原文の版と指紋を出所へ結びました。');}
 });
 function renderTarget(n) {
  const box=el('section','source-summary');box.append(el('div','section-title','判断と出所'),button('この対象の判断・変更を辿る',()=>void openProvenance(n.id).catch(e=>toast(e.message,true))));
  if(!n.sourceRefs?.length)box.append(el('p','small-note','契約への参照は未登録です。判断の理由が記録されていない場合は不明と表示します。'));
  for(const ref of n.sourceRefs||[]) {
   const row=el('div','source-ref');row.append(button(`${ref.documentId} · ${ref.section||'原文全文'}`,()=>void openContracts(ref.documentId,ref.section).catch(e=>toast(e.message,true))),el('small','',`参照時：${ref.revision} · ${ref.sha256.slice(0,12)}`),button('参照を外す',()=>change([{type:'update',id:n.id,patch:{sourceRefs:(getNode(n.id)?.sourceRefs||[]).filter(r=>JSON.stringify(r)!==JSON.stringify(ref))}}])));box.append(row);
  }
  box.append(button('契約の原文から出所を結ぶ',()=>void openContracts().catch(e=>toast(e.message,true))));return box;
 }
 async function openProvenance(targetId) {
  const result=await api(`/api/provenance?targetId=${encodeURIComponent(targetId)}`),host=$('#provenanceList');host.replaceChildren();
  $('#provenanceTitle').textContent=`${getNode(targetId)?.title||'対象'} · 判断と変更の出所`;
  host.append(el('h3','section-title','契約への参照'));
  for(const ref of result.sources.references) {
   const row=el('div','provenance-entry');row.append(el('strong','',`${ref.documentId} · ${labels[ref.status]||ref.status} · ${labels[ref.documentStatus]||ref.documentStatus||''}`),el('p','small-note',`参照時の版 ${ref.revision} / 指紋 ${ref.sha256}`),button('現在の原文へ',()=>void openContracts(ref.documentId,ref.section).catch(e=>toast(e.message,true))));if(ref.text){if(ref.status!=='current')row.append(el('p','conflict-note','以下は現在の原文です。参照時の原文としては扱いません。'));row.append(el('pre','source-excerpt',ref.text));}host.append(row);
  }
  if(!result.sources.references.length)host.append(el('p','small-note','契約への参照は未登録です。'));
  host.append(el('h3','section-title','この保存先の変更と理由（取込前を含む）'));
  for(const entry of result.entries) {
   const row=el('div','provenance-entry');row.append(el('strong','',`保存版 ${entry.revision} · ${{codex:'Codex',owner:'直接操作',unknown:'記録者不明'}[entry.actor]}${entry.undone?' · 取消済み':''}`),el('small','',`${entry.at} · ${entry.operationId}`),el('p','',`理由：${entry.reason||'記録なし・不明（操作差分から理由を推測しません）'}`));
   const details=el('details');details.append(el('summary','','変更前後と参照した入力'));
   for(const item of entry.changes)details.append(el('pre','source-excerpt',`${item.field}\n変更前：${JSON.stringify(item.before,null,2)}\n変更後：${JSON.stringify(item.after,null,2)}`));
   if(entry.relations)details.append(el('pre','source-excerpt',JSON.stringify(entry.relations,null,2)));
   for(const input of entry.inputs){details.append(el('pre','source-excerpt',`入力：${input.title} · 版 ${input.version}\n${input.body||''}`));if(input.number)details.append(el('pre','source-excerpt',`制作時の数値・式・参照元・鮮度\n${JSON.stringify(input.number,null,2)}`));}
   for(const ref of entry.sourceRefs)if(ref.text)details.append(el('pre','source-excerpt',`実行時の参照記録：${ref.documentId} · ${ref.revision} · ${ref.sha256}\n${ref.text}`));
   row.append(details);host.append(row);
  }
  host.append(el('h3','section-title','制作・提案の記録'));
  for(const run of result.runs) {const kind=run.mode==='relations'?'関係案':'設定案',label=run.status==='proposed'?`${kind}・未採用`:run.status==='adopted'?`${kind}・${run.adoptionUndone?'採用取消済み':'採用済み'}`:runLabels[run.status]||'状態未確認';const row=el('div','provenance-entry');row.append(el('strong','',`${run.startedAt} · ${label} · 開始時の版 ${run.targetVersion}`),el('p','',`依頼：${run.prompt}`),el('p','',`判断理由：${run.decisionReason||'記録なし・不明'}`));host.append(row);}
  host.append(el('h3','section-title','交換で保管した出所・判断'));
  if(result.archives?.length)host.append(el('p','small-note','以下は同じIDを持つ元記録です。現在の対象との内容一致や承認の真正性は保証しません。取込元の申告を閲覧するだけで、制作の再開・権限・現物受入には使いません。'));
  for(const archive of result.archives||[]) {
   const row=el('section','provenance-entry');row.append(el('strong','',`元案件 ${archive.projectId||'不明'} · 元保存版 ${archive.revision??'不明'}`),el('small','source-hash',archive.sha256));
   if(archive.legacy)row.append(el('p','conflict-note','旧形式：元ファイルに変更差分や理由がなければ復元できません。'));
   if(archive.sourceDocument)row.append(el('p','',`原.mmap：${archive.sourceDocument.name} · ${archive.sourceDocument.sha256}`),el('pre','source-excerpt',JSON.stringify(archive.sourceDocument.mapping,null,2)),el('p','small-note','原ZIPと全対応表/未対応一覧は「保管した出所」から取り出せます。取込は契約承認・仕様依存・成果受入を与えません。'));
   for(const event of archive.events.slice(0,100))row.append(el('p','',`元保存版 ${event.revision??'不明'}${event.undone?' · 取消済み':''}：${typeof event.context?.reason==='string'&&event.context.reason.trim()?event.context.reason:'理由の記録なし・不明'}`));
   if(archive.events.length>100)row.append(el('p','small-note','理由の一覧は先頭100件です。以下の原記録には全件を保持しています。'));
   const detail=el('details');detail.append(el('summary','',`元の対象・変更詳細 ${archive.events.length}件・実行記録 ${archive.runs.length}件`),el('pre','source-excerpt',JSON.stringify({node:archive.node,events:archive.events,runs:archive.runs},null,2)));row.append(detail);host.append(row);
  }
  if(!$('#provenanceDialog').open)$('#provenanceDialog').showModal();
 }
 $('#closeProvenance').onclick=()=>$('#provenanceDialog').close();
 return {openContracts,openProvenance,renderTarget};
}
