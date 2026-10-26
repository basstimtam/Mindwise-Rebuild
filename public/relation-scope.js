export function createRelationScopeUi({el,field,button,getState,getSelected,onChanged}) {
 const host=el('section','analysis-section'),drafts=new Map();let rendered='';host.hidden=true;
 function ids() {
  const state=getState(),targetId=getSelected();
  if(!drafts.has(targetId))drafts.set(targetId,[...new Set(state.links.filter(l=>l.from===targetId||l.to===targetId).map(l=>l.from===targetId?l.to:l.from))]);
  return drafts.get(targetId).filter(id=>id!==targetId&&state.nodes.some(n=>n.id===id));
 }
 function render(visible) {
  host.hidden=!visible;if(!visible)return;
  const state=getState(),targetId=getSelected(),candidates=ids(),key=JSON.stringify([targetId,candidates,state.nodes.map(n=>[n.id,n.title])]);
  if(rendered===key)return;rendered=key;host.replaceChildren(el('div','section-title','関係を検討する対象'),el('p','small-note','選択中の枝につながる関係だけを提案します。候補は選択対象を含め20件まで。適用や例外の影響は候補外にも及ぶため、採用前に別途確認します。'));
  for(const id of candidates)host.append(button(`${state.nodes.find(n=>n.id===id).title} を候補から外す`,()=>{drafts.set(targetId,ids().filter(v=>v!==id));onChanged();},'source-button'));
  const picker=field('候補へ加える対象','relationCandidate','','select',[['','対象を選択'],...state.nodes.filter(n=>n.id!==targetId&&!candidates.includes(n.id)).map(n=>[n.id,n.title])]);
  host.append(picker,button('関係の候補へ追加',()=>{const id=picker.querySelector('select').value;if(!id)return;drafts.set(targetId,[...ids(),id]);onChanged();}),el('p',candidates.length>19?'conflict-note':'small-note',`候補 ${candidates.length} 件 + 選択対象 1 件。${!candidates.length?'候補を加えてください。':candidates.length>19?'候補を減らしてください。':''}`));
 }
 return {host,ids,render,clear(){drafts.clear();rendered='';}};
}
