// Keep recorded edges visible even while a formula is incomplete or has bad units.
// Unused bindings conservatively request recheck; they never supply a computed value.
export const hasNumber = n => n.value !== null && n.value !== undefined || Boolean(n.formula?.trim()||n.unit?.trim()||n.metricSource?.trim()||n.metricInputs?.length) || n.kind === 'metric' || ['current','stale'].includes(n.metricFreshness);

// Artifact review and Codex include numeric objects directly related to a target,
// regardless of the relation label. Keep preview and invalidation on that same basis.
export function numberContextDependencies(state) {
  const numbers=new Set((state.nodes||[]).filter(hasNumber).map(n=>n.id)),edges=[];
  for(const link of state.links||[]) {
    if(numbers.has(link.from))edges.push({from:link.from,to:link.to});
    if(numbers.has(link.to))edges.push({from:link.to,to:link.from});
  }
  return edges;
}
export function numericDependencies(state) {
  return (state.nodes||[]).flatMap(n=>!n.formula?.trim()||!Array.isArray(n.metricInputs)?[]:n.metricInputs.filter(ref=>ref&&typeof ref.nodeId==='string').map(ref=>({from:ref.nodeId,to:n.id,name:ref.name})));
}
