import {existsSync,mkdirSync,writeFileSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import {createStore} from '../../src/store.mjs';
import {zip} from '../../tests/fixtures/mmap.mjs';
const root=resolve(import.meta.dirname,'../..'),dataDir=join(root,'.runtime/mmap-workflow'),evidence=join(root,'.runtime/mmap-evidence');
if(existsSync(join(dataDir,'mindwise.sqlite')))throw new Error('既存の試験保存先は初期化しません。');
mkdirSync(evidence,{recursive:true});const bytes=zip(),path=join(evidence,'fictional.mmap');writeFileSync(path,bytes,{flag:'wx'});writeFileSync(join(evidence,'rejected.mmap'),zip([{name:'../Document.xml',text:'fictional invalid path'}]),{flag:'wx'});
const store=createStore({root,dataDir});try{store.change({baseRevision:0,operationId:'mmap-fixture-local',ops:[{type:'add',node:{id:'mmap-local',title:'読込前：架空のローカル資料',body:'専用の試験モデル。実案件の受入ではありません。'}}]});}finally{store.close();}
const metadata={fixture:'fictional bounded mmap, no real Codex/no owner acceptance',dataDir,path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),mtimeMs:statSync(path).mtimeMs,expected:{topics:3,links:1,unresolvedRelationships:1,floating:1,progress:42},main:{revision:48,nodes:14}};
writeFileSync(join(import.meta.dirname,'mmap-fixture.json'),JSON.stringify(metadata,null,2));console.log(JSON.stringify(metadata));
