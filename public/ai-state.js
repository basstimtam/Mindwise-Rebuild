// Run writes do not increment model revision. Re-read an unfamiliar run before
// admitting it; this also filters old responses delivered after an import.
export async function reconcileAiState(state,response,readState) {
 if(response.revision!==undefined&&response.revision!==state.revision||response.run&&!state.runs.some(r=>r.id===response.run.id))state=await readState();
 const run=response.run&&state.runs.some(r=>r.id===response.run.id)?response.run:null;
 return {state,run,events:run?response.events||[]:[]};
}
