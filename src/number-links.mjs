// Keep recorded edges visible even while a formula is incomplete or has bad units.
// Unused bindings conservatively request recheck; they never supply a computed value.
export function numericDependencies(state) {
  return (state.nodes||[]).flatMap(n=>!n.formula?.trim()||!Array.isArray(n.metricInputs)?[]:n.metricInputs.filter(ref=>ref&&typeof ref.nodeId==='string').map(ref=>({from:ref.nodeId,to:n.id,name:ref.name})));
}
