export function createRecoveryUi({api,el,toast,onRecovered,onUncertain}) {
 const dialog=document.querySelector('#recoveryDialog'),host=document.querySelector('#recoveryDetails'),apply=document.querySelector('#recoverResult');
 let report=null,pending=false;
 document.querySelector('#closeRecovery').onclick=()=>dialog.close();
 dialog.addEventListener('close',()=>{report=null;apply.disabled=true;});
 function renderReport(observed) {
   report=observed;
   host.replaceChildren(el('h3','',observed.title),el('p','small-note',`保存版 ${observed.baseRevision} のモデルと現物を照合しました。現物の再作成・上書きやCodexの再実行は行いません。`));
   if(observed.fixture)host.append(el('p','conflict-note','故障試験用の保存応答です。Codexの実制作の証拠ではありません。'));
   const labels={connect:'現物が揃い、制作時の文脈と一致しています。モデルへの接続を回復できます。','record-only':'元のモデル変更は受領済みです。枝へ再適用せず、実行記録だけを回復します。',held:'回復を保留しています。保存済みの状態と現物を保持しています。',done:'この実行は照合済みです。現物の受入確認は別です。'};
   host.append(el('p',observed.status==='held'?'conflict-note':'verification-state',labels[observed.status]||observed.status));
   for(const issue of observed.issues)host.append(el('p','conflict-note',issue));
   if(observed.modelReceipt) {
    host.append(el('p','small-note',`接続の受領：保存版 ${observed.modelReceipt.revision}。${observed.modelReceipt.undone?'この接続は取消済みです。取り消した内容を戻しません。':''}${observed.modelReceipt.laterChanges?'受領後のモデル変更も保持します。':''}`));
   }
   for(const file of observed.files) {
    const row=el('section','recovery-file'),state={matched:'現物一致',missing:'現物なし',changed:'現物が変更済み',unreadable:'読取・境界の確認が必要'}[file.status]||file.status;
    row.append(el('strong','',`${file.name} · ${state}`),el('p','small-note',file.path));
    if(file.error)row.append(el('p','conflict-note',file.error));
    const details=el('details');details.append(el('summary','','指紋と現物の本文'),el('pre','source-excerpt',`保存応答の指紋：${file.expectedHash}\n現物の指紋：${file.sha256||'未取得'}\n\n${file.text??'本文を取得していません。'}${file.textTruncated?'\n（変更済みの本文は先頭4000文字を表示）':''}`));row.append(details);host.append(row);
   }
   if(!observed.files.length)host.append(el('p','small-note','照合できる成果物はありません。保存済み応答の有無を確認してください。'));
   if(observed.changes) {
    host.append(el('h3','section-title','モデルへ接続する内容'));
    if(observed.changes.updatedBody!==null)host.append(el('pre','source-excerpt',`現在の本文\n${observed.changes.beforeBody}\n\n接続する本文\n${observed.changes.updatedBody}`));
    if(observed.changes.artifact)host.append(el('p','small-note',`成果物の参照：${observed.changes.artifact}`));
    for(const child of observed.changes.children)host.append(el('pre','source-excerpt',`追加する枝：${child.title}\n領域：${child.domain}\n${child.body}`));
   }
   const effects=(observed.impact?.details||[]).filter(row=>row.effect!=='unchanged');
   if(effects.length)host.append(el('h3','section-title','接続前の影響'));
   for(const effect of effects)host.append(el('p','small-note',`${effect.title}：${effect.reasons.join(' / ')}`));
   apply.textContent=observed.status==='record-only'?'実行記録だけを回復':'この結果を地図へ接続';
   apply.disabled=!['connect','record-only'].includes(observed.status);
   if(!dialog.open)dialog.showModal();
 }
 async function open(runId) {
  if(pending)return;
  try {
   renderReport(await api('/api/ai/recovery-preview',{runId}));
  }catch(error){toast(error.message,true);}
 }
 apply.onclick=async()=>{
  if(!report||pending||apply.disabled)return;
  const viewed=report;pending=true;apply.disabled=true;
  try {
   const result=await api('/api/ai/recover',{runId:viewed.runId,baseRevision:viewed.baseRevision,signature:viewed.signature});
   if(report===viewed)dialog.close();await onRecovered(result);toast(result.run.recovery);
  }catch(error){
   toast(`回復の結果を再照合します：${error.message}`,true);
   try{await onUncertain();}catch{}
   try {
    const observed=await api('/api/ai/recovery-preview',{runId:viewed.runId});renderReport(observed);
    host.prepend(el('p','conflict-note',observed.modelReceipt||observed.status==='done'?'モデル接続の受領を確認しました。再適用せず、表示した記録の状態を確認してください。':'応答を受け取れなかったため再照合しました。以下の現在状態を確認してください。'));
   }catch{
    host.prepend(el('p','conflict-note','回復の結果は未確認です。一部が保存されている可能性があります。画面を閉じて、モデルと現物を照合し直してください。'));
    if(!dialog.open)dialog.showModal();
   }
  }
  finally{pending=false;}
 };
 return {open};
}
