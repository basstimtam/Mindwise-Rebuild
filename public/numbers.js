export function createNumbersUi({el,button,field,getState,getAnalysis,getSelected,choose}) {
 const label=result=>!result?'照合中':result.status==='empty'?'数値未定義':result.status==='unresolved'?'未解決':result.status==='calculated'?'再計算済み':'現在として使用する入力値';
 function referenceEditor(node,draft) {
  const box=el('div','metric-inputs'), hidden=el('input');hidden.type='hidden';hidden.name='metricInputsJson';
  let rows=node.metricInputs||[];try {if(draft?.metricInputsJson)rows=JSON.parse(draft.metricInputsJson);}catch {}
  rows=rows.map(row=>({...row}));const host=el('div');
  const update=()=>{hidden.value=JSON.stringify(rows);hidden.dispatchEvent(new Event('input',{bubbles:true}));};
  const draw=()=>{
   host.replaceChildren();rows.forEach((ref,index)=>{
    const row=el('div','metric-reference'), alias=el('input'), target=el('select');
    alias.value=ref.name;alias.placeholder='例：hours';alias.setAttribute('aria-label',`式の参照名 ${index+1}`);alias.maxLength=32;
    target.setAttribute('aria-label',`式の参照先 ${index+1}`);
    const empty=el('option','', '参照する対象');empty.value='';target.append(empty);
    const nodes=getState().nodes;
    if(ref.nodeId&&!nodes.some(n=>n.id===ref.nodeId)){const missing=el('option','','削除・欠落した対象');missing.value=ref.nodeId;target.append(missing);}
    for(const n of nodes){const option=el('option','',n.title);option.value=n.id;target.append(option);}target.value=ref.nodeId||'';
    alias.oninput=()=>{ref.name=alias.value;update();};target.onchange=()=>{ref.nodeId=target.value;update();};
    row.append(alias,target,button('参照を外す',()=>{rows.splice(index,1);update();draw();}));host.append(row);
   });
  };
  hidden.value=JSON.stringify(rows);draw();
  box.append(el('p','small-note','式の名前を、同じ地図の対象へ結びます。例：hours * rate。使う名前は英字から始め、同名を重ねません。'),host,hidden,button('式の参照を追加',()=>{if(rows.length>=50)return;rows.push({name:'',nodeId:''});update();draw();}));return box;
 }
 function details(node,result) {
  const box=el('section','analysis-section');box.id='numberDetails';
  box.append(el('div','section-title','再計算と根拠'));
  if(!result){box.append(el('p','small-note','保存済みの数値と出所を照合中です。'));return box;}
  box.append(el('strong',`number-result ${result.status}`,result.value===null?label(result):`${result.value} ${result.unit} · ${label(result)}`));
  for(const problem of result.issues)box.append(el('p','conflict-note',problem.message));
  if(result.status==='empty')return box;
  box.append(el('p','small-note',`保存版 ${result.atRevision} から再計算 · 対象の版 ${result.version}。入力値の鮮度は明示記録であり、現物の受入確認とは別です。`));
  if(result.source.text)box.append(el('p','source-excerpt',`入力・式の出所：${result.source.text}`));
  if(result.inputs.length)box.append(el('div','section-title','式が参照する元の値'));
  for(const input of result.inputs) {
   const row=el('div','effective-spec');row.append(button(`${input.name} → ${input.title}`,()=>choose(input.nodeId),'source-button'),el('p','small-note',`版 ${input.version??'不明'} · ${input.value??'未解決'} ${input.unit} · ${label({status:input.status})}`));box.append(row);
  }
  const hashes=el('details'), summary=el('summary','','式の版と計算指紋');hashes.append(summary,el('code','source-hash',`式 ${result.formulaHash}`),el('code','source-hash',`根拠・結果 ${result.fingerprint}`));box.append(hashes);return box;
 }
 function editor(node,draft) {
  const box=el('div');box.append(field('数値の出所（資料・観測・仮定）','metricSource',node.metricSource||'','textarea'),field('入力値の鮮度','metricFreshness',node.metricFreshness||'unknown','select',[['unknown','不明・まだ照合していない'],['current','現在の値として使う'],['stale','変更後の再確認が必要']]),referenceEditor(node,draft),el('p','small-note','式を使う場合は入力値を空欄にします。四則と括弧に対応。単位は 円/時間、時間、1 など。数値定数は無単位です。単位換算は行いません。式の鮮度は参照元から計算します。'));
  return box;
 }
 function drawTable(host,nodes) {
  host.replaceChildren();const table=el('table','data-table number-table'),head=el('thead'),hr=el('tr');
  for(const text of ['対象','元の値 / 式','単位','結果・鮮度'])hr.append(el('th','',text));head.append(hr);table.append(head);
  const body=el('tbody');for(const n of nodes){
   const result=getAnalysis()?.numbers?.byId[n.id],row=el('tr',n.id===getSelected()?'selected':'');row.dataset.numberId=n.id;
   const origin=el('td');origin.append(button(n.title,()=>choose(n.id),'source-button'));
   const output=el('td');output.append(el('strong',`number-result ${result?.status||''}`,result?.value===null||!result?label(result):`${result.value} · ${label(result)}`));
   if(result?.issues?.length)output.append(el('small','',result.issues.map(p=>p.message).join(' ')));
   row.append(origin,el('td','',n.formula||String(n.value??'未定義')),el('td','',n.unit||'未定義'),output);body.append(row);
  }table.append(body);host.append(table);
 }
 return {editor,details,drawTable};
}
