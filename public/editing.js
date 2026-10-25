// Reconcile an in-memory form only after our own revision-checked mutation.
// Concurrent saves still leave the old baseVersion and require explicit review.
function formValue(node,key) {
 if(key==='specsText')return (node.specs||[]).map(s=>`${s.key} = ${s.value}`).join('\n');
 if(key==='metricInputsJson')return JSON.stringify(node.metricInputs||[]);
 if(key==='required')return Boolean(node.required);
 return String(node[key]??'');
}
export function rebaseDraft(draft,before,after) {
 if(before&&!after&&draft.baseVersion===before.version)return {...draft,removedBase:before};
 if(!before&&after&&draft.removedBase)before=draft.removedBase;
 if(!before||!after||draft.baseVersion!==before.version)return draft;
 const values={...draft.values};
 for(const key of Object.keys(values)) {
  const old=formValue(before,key),next=formValue(after,key);
  if(old===next)continue;
  // A locally edited field changed in the saved model too: retain both bases
  // for the existing conflict UI, never silently choose either value.
  if(values[key]!==old&&values[key]!==next)return draft;
  values[key]=next;
 }
 return {baseVersion:after.version,values};
}
export function parentCandidates(nodes,id) {
 const children=new Map();
 for(const n of nodes){if(!children.has(n.parentId))children.set(n.parentId,[]);children.get(n.parentId).push(n.id);}
 const excluded=new Set([id]),queue=[id];
 for(let i=0;i<queue.length;i++)for(const child of children.get(queue[i])||[])if(!excluded.has(child)){excluded.add(child);queue.push(child);}
 return nodes.filter(n=>!excluded.has(n.id));
}
export function selectionAfterChange(before,after,selected,ops) {
 if(ops.some(op=>op.type==='undo')) {
  const existing=new Set(before.nodes.map(n=>n.id)),restored=after.nodes.find(n=>!existing.has(n.id));
  if(restored)return restored.id;
 }
 if(after.nodes.some(n=>n.id===selected))return selected;
 const old=before.nodes.find(n=>n.id===selected);
 return before.nodes.find(n=>n.parentId===selected&&after.nodes.some(a=>a.id===n.id))?.id
  ||after.nodes.find(n=>n.id===old?.parentId)?.id||after.nodes[0]?.id||null;
}
