// Fictional material for actual Codex and UI verification. No existing DB reset.
import {existsSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createStore} from '../../src/store.mjs';
import {readContracts} from '../../src/contracts.mjs';
import {resolveSpecifications} from '../../src/semantics.mjs';
const root=path.resolve(import.meta.dirname,'../..'),dataDir=path.join(root,'.runtime/relations-workflow'),evidence=path.join(import.meta.dirname,'relations-fixture.json');assert.equal(process.cwd(),root);
assert.ok(!existsSync(path.join(dataDir,'mindwise.sqlite'))&&!existsSync(evidence),'Existing fixture must be retained');
const goal=readContracts(root).documents.find(d=>d.id==='goal');assert.equal(goal.status,'approved');
const sourceRefs=[{documentId:'goal',section:'3. 観測可能な完成条件',revision:goal.revision,sha256:goal.sha256}];
const nodes=[
 {id:'rel-p',title:'雨港の環境（架空）',body:'架空短編の資料。天候は雨。実案件の受入ではない。',specs:[{key:'天候',value:'雨'}]},
 {id:'rel-s',title:'共通の衣装設定（架空）',body:'架空短編の共通衣装は赤。通常の人物に適用する。夜警の局所設定を変える理由はない。',specs:[{key:'衣装',value:'赤'}]},
 {id:'rel-t',title:'夜警の局所設定（架空）',body:'架空短編の夜警だけは雨の港でも視認できる青の衣装にする。そのため、夜警の局所設定で共通の赤を置き換える明示例外が必要。夜警設定が適用される短編も青を使う。通常の人物紹介は共通の赤を保つ。理由の出所はこの本文であり、実案件の戦略承認ではない。',specs:[{key:'衣装',value:'青'}],sourceRefs},
 {id:'rel-u',title:'夜警の短編を制作（架空）',body:'夜警の設定と共通設定を受ける架空の短編。現在の有効設定と理由を利用して制作する。'},
 {id:'rel-v',title:'通常の人物紹介（架空）',body:'共通設定だけを使う人物紹介。夜警の局所例外を適用しない。'},
 {id:'rel-w',title:'独立した資料（架空）',body:'関係を結んでいない資料。今回変更しない。'}
];
const links=[['p-s','rel-p','rel-s'],['s-t','rel-s','rel-t'],['s-u','rel-s','rel-u'],['t-u','rel-t','rel-u'],['s-v','rel-s','rel-v']].map(([id,from,to])=>({id,from,to,type:'applies_to'}));
const store=createStore({root,dataDir});try{
 store.change({baseRevision:0,operationId:'seed-relations-workflow',ops:[...nodes.map((n,i)=>({type:'add',node:{...n,domain:'関係案の架空短編',x:80+(i%3)*260,y:80+Math.floor(i/3)*180}})),...links.map(link=>({type:'link',link}))],meta:{actor:'owner',reason:'承認済みA3/A5の関係案を、専用の架空短編で実Codex/画面検証する。実案件の受入ではない。'}});
 const state=store.getState();assert.equal(resolveSpecifications(state,'rel-t').status,'conflict');assert.equal(resolveSpecifications(state,'rel-u').status,'conflict');assert.equal(resolveSpecifications(state,'rel-v').effective.find(s=>s.key==='衣装').value,'赤');
 writeFileSync(evidence,JSON.stringify({fictional:true,realCodexCallsAtSeed:0,createdAt:new Date().toISOString(),dataDir:'.runtime/relations-workflow',port:4317,revision:state.revision,nodes:state.nodes,links:state.links,expectations:{proposal:'T exception_to S only, T/U become blue; V stays red; W unchanged',removal:'exact original exception ID, U conflict again, undo restores ID',acceptance:'No owner acceptance'}},null,2)+'\n');console.log(JSON.stringify({revision:state.revision,nodes:state.nodes.length,sourceRefs}));
}finally{store.close();}
