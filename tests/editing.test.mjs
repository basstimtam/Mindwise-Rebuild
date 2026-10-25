import test from 'node:test';
import assert from 'node:assert/strict';
import {rebaseDraft,parentCandidates,selectionAfterChange} from '../public/editing.js';

test('own detach preserves dirty prose while advancing clean parent and base; actual conflicts remain blocked',()=>{
 const before={id:'task',version:4,body:'saved',parentId:'old',progress:40,value:null,specs:[],metricInputs:[],required:false};
 const draft={baseVersion:4,values:{body:'unsaved prose',parentId:'old',progress:'40',value:'',specsText:'',metricInputsJson:'[]',required:false}};
 const after={...before,version:5,parentId:null};
 const rebased=rebaseDraft(draft,before,after);
 assert.equal(rebased.baseVersion,5);assert.equal(rebased.values.body,'unsaved prose');assert.equal(rebased.values.parentId,'');
 assert.equal(draft.values.parentId,'old','Original draft must remain immutable');
 assert.equal(rebaseDraft(draft,before,{...after,body:'concurrent prose'}),draft);
 assert.equal(rebaseDraft({...draft,baseVersion:3},before,after).baseVersion,3);
 assert.equal(rebaseDraft(draft,before,null).values,draft.values);
 const editedParent={...draft,values:{...draft.values,parentId:'chosen'}};
 assert.equal(rebaseDraft(editedParent,before,after),editedParent,'Do not overwrite a conflicting parent choice');
 const removed=rebaseDraft(draft,before,null),restored=rebaseDraft(removed,null,{...before,version:6});
 assert.equal(restored.baseVersion,6);assert.equal(restored.values.body,'unsaved prose');assert.equal(restored.values.parentId,'old');
 assert.equal(rebaseDraft(removed,null,{...before,body:'changed after deletion',version:6}),removed);
});
test('parent picker excludes self and all descendants without changing the graph',()=>{
 const nodes=[{id:'root',parentId:null},{id:'task',parentId:'root'},{id:'child',parentId:'task'},{id:'deep',parentId:'child'},{id:'orphan',parentId:null}];
 const before=structuredClone(nodes);
 assert.deepEqual(parentCandidates(nodes,'task').map(n=>n.id),['root','orphan']);assert.deepEqual(nodes,before);
});
test('delete selects retained child; undo selects the restored original, retaining ID',()=>{
 const before={nodes:[{id:'root',parentId:null},{id:'task',parentId:'root'},{id:'note',parentId:'task'}]};
 const removed={nodes:[before.nodes[0],{id:'note',parentId:null}]};
 assert.equal(selectionAfterChange(before,removed,'task',[{type:'delete',id:'task'}]),'note');
 assert.equal(selectionAfterChange(removed,before,'note',[{type:'undo'}]),'task');
 assert.equal(selectionAfterChange(before,before,'task',[{type:'update',id:'task'}]),'task');
});
