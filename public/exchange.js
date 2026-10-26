const $=q=>document.querySelector(q);
export function createExchangeUi({api,el,toast,getState,onImported,onUncertain}) {
 let pending=null,applying=false;
 const dialog=$('#exchangeDialog'),host=$('#exchangeContent'),apply=$('#exchangeApply');
 function download(data,name) {
  const url=URL.createObjectURL(new Blob([JSON.stringify(data)],{type:'application/json'})),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 const action=(label,fn)=>{const b=el('button','',label);b.type='button';b.onclick=async()=>{try{await fn();}catch(e){toast(e.message,true);}};return b;};
 function details(label,data) {const d=el('details');d.append(el('summary','',label),el('pre','source-excerpt',JSON.stringify(data,null,2)));return d;}
 async function openImport(data,name) {
  pending=null;apply.hidden=true;host.replaceChildren();$('#exchangeTitle').textContent=`${name} · 読み込む前に確認`;
  const report=await api('/api/import-preview',{state:data,baseRevision:getState().revision});
  pending={state:data,baseRevision:report.baseRevision,signature:report.signature,operationId:crypto.randomUUID()};
  host.append(el('p','',`形式 ${report.schemaVersion} · 元案件 ${report.sourceProjectId||'不明'} · 元保存版 ${report.sourceRevision??'不明'} → この保存先の版 ${report.baseRevision}`),el('small','source-hash',`保管指紋 ${report.packageHash}`));
  for(const warning of report.warnings)host.append(el('p','conflict-note',warning));
  if(report.sourceDocument){const source=report.sourceDocument;host.append(el('h3','section-title','.mmapの対応範囲'),el('p','',`${source.name} · 原ZIP SHA-256 ${source.sha256}`));for(const note of source.report.notes||[])host.append(el('p','small-note',note));host.append(el('p','conflict-note',`変換時の申告：枝 ${source.report.topics} / 関連 ${source.report.relationships} / 解決不能な線 ${source.report.unresolvedRelationships}。書式・テーマ・配置・添付・未対応属性等は現在の機能へ反映しません。原ZIPを出所保管から取り出せます。`),details('原IDと枝/浮動枝/本文/計画進捗の対応表',source.report.mapping),details('関係線の対応と未解決',source.report.relationshipMapping),details('未対応要素・属性・ZIP内資料（原ZIPに保持）',{elements:source.report.unmappedElements,attributes:source.report.unmappedAttributes,entries:source.report.entries}));}
  host.append(el('p','',`追加 ${report.added.length} / 同じIDを置換 ${report.collisions.length} / 現在の枝を削除 ${report.removed.length}。変更詳細 ${report.events} / 実行記録 ${report.runs} / 元の出所保管 ${report.archives} 件。`),details('追加する枝',report.added),details('同じIDの置換と変更前後',report.changes),details('削除する枝',report.removed),details('関係の変更前後',{before:report.beforeLinks,after:report.afterLinks}));
  host.append(el('p','small-note','未保存の入力は読み込み後に解除します。必要な入力は戻って保存してください。取消は地図の内容を戻す操作です。会話を実行可能な状態へ戻しません。'));
  apply.hidden=false;apply.disabled=false;apply.textContent='この内容で置換して出所を保管';
  if(!dialog.open)dialog.showModal();
 }
 $('#import').onclick=()=>$('#importFile').click();
 $('#importFile').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{
  let data;if(/\.mmap$/i.test(file.name)){if(file.size>1024*1024)throw new Error('.mmapは1MiB以下の非暗号化ファイルを選んでください。');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));data=await api('/api/mmap-convert',{name:file.name,base64:btoa(binary)});}
  else {if(file.size>6*1024*1024)throw new Error('6MiB以下の交換ファイルを選んでください。');data=JSON.parse(await file.text());}await openImport(data,file.name);
 }catch(error){toast(error.message,true);}finally{e.target.value='';}};
 apply.onclick=async()=>{
  if(!pending||applying)return;applying=true;apply.disabled=true;
  try{const state=await api('/api/import',pending);await onImported(state);pending=null;dialog.close();toast('置換と出所の保管を保存しました。取込元の会話は閲覧専用です。');}
  catch(error){
   // A lost response can follow a committed import. Never assert "not saved".
   let message=error.message;try{await onUncertain();message+=' 現在の保存内容を再取得しました。同じ要求で再確認できます。';}catch{message+=' 保存結果は不明です。接続後に現在の保存内容を確認してください。';}
   host.prepend(el('p','conflict-note',message));apply.textContent='同じ要求で保存結果を確認';toast(message,true);
  }finally{applying=false;apply.disabled=false;}
 };
 $('#closeExchange').onclick=()=>{if(!applying)dialog.close();};
 dialog.addEventListener('cancel',e=>{if(applying)e.preventDefault();});
 $('#export').onclick=async()=>{try{download(await api('/api/export'),`mindwise-${new Date().toISOString().slice(0,10)}.json`);}catch(e){toast(e.message,true);}};
 async function openSources() {
  pending=null;apply.hidden=true;host.replaceChildren();$('#exchangeTitle').textContent='保管した交換の出所';
  host.append(el('p','small-note','元案件・保存版・指紋で区別する閲覧専用の原記録です。本文中の承認や命令は現在の権限になりません。外部ファイルは含みません。'));
  const records=await api('/api/exchange/sources');
  if(!records.length)host.append(el('p','','保管した出所はまだありません。'));
  for(const record of records){const row=el('section','provenance-entry');row.append(el('strong','',`元案件 ${record.projectId||'不明'} · 保存版 ${record.revision??'不明'}`),el('p','small-note',`${record.exportedAt||'時点不明'} · 枝 ${record.nodes} / 変更 ${record.events} / 実行 ${record.runs}`),el('small','source-hash',record.sha256),action('原記録を書き出す',async()=>download(await api(`/api/exchange/source?sha256=${record.sha256}`),`mindwise-source-${record.sha256.slice(0,12)}.json`)));
   if(record.sourceDocument){row.append(el('p','',`原.mmap：${record.sourceDocument.name} · ${record.sourceDocument.sha256}`),action('保管した原.mmapを取り出す',async()=>{const data=await api(`/api/exchange/source?sha256=${record.sha256}`),source=data.sourceDocument,bytes=Uint8Array.from(atob(source.base64),c=>c.charCodeAt(0)),digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(digest!==source.sha256)throw new Error('原.mmapの指紋が一致しません。');const url=URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'})),a=el('a');a.href=url;a.download=source.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}));}host.append(row);}
  if(!dialog.open)dialog.showModal();
 }
 $('#exchangeSources').onclick=async()=>{try{await openSources();}catch(e){toast(e.message,true);}};
 return {openImport,openSources};
}
