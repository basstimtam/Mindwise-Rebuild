import test from 'node:test';
import assert from 'node:assert/strict';
import {reconcileAiState} from '../public/ai-state.js';
test('newly persisted production is visible at the same model revision, while a late pre-import response stays detached',async()=>{
 const state={revision:3,runs:[]},run={id:'new',status:'running'},response={revision:3,run,events:[{type:'delta',text:'working'}]};let reads=0;
 const started=await reconcileAiState(state,response,async()=>{reads++;return {...state,runs:[run]};});assert.equal(reads,1);assert.equal(started.run.status,'running');assert.equal(started.events[0].text,'working');
 const imported=await reconcileAiState({revision:4,runs:[]},response,async()=>({revision:4,runs:[]}));assert.equal(imported.run,null);assert.deepEqual(imported.events,[]);
 const stopped=await reconcileAiState(started.state,{revision:3,run:null},async()=>assert.fail('no read needed'));assert.equal(stopped.run,null);
});
