import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { analyzeChange } from './semantics.mjs';

export class StoreError extends Error {
  constructor(message, status = 400, details = undefined) { super(message); this.status = status; this.details = details; }
}
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const nodeFields = new Set('id parentId title body domain depth status progress start due x y kind unit value formula artifact criteria verified version evidence source scope specs required weight sourceRefs'.split(' '));
const linkFields = new Set(['id', 'from', 'to', 'type', 'reason']);
const meaningfulFields = new Set(['title','body','kind','unit','value','formula','artifact','criteria','scope','specs','sourceRefs']);
const assert = (condition, message, status = 400) => { if (!condition) throw new StoreError(message, status); };
function identifier(value) { return typeof value === 'string' && /^[\p{L}\p{N}_:.-]{1,160}$/u.test(value); }
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function node(input) {
  assert(object(input), '枝の入力がオブジェクトではありません。');
  const unknown = Object.keys(input).filter(key => !nodeFields.has(key));
  assert(!unknown.length, `未対応の枝属性: ${unknown.join(', ')}`);
  const n = { id: randomUUID(), parentId:null,title:'新しい枝',body:'',domain:'',depth:0,status:'planned',progress:0,start:'',due:'',x:0,y:0,kind:'concept',unit:'',value:null,formula:'',artifact:'',criteria:'',verified:false,version:1,specs:[],required:false,weight:null,sourceRefs:[],...input };
  assert(identifier(n.id), '枝IDが不正です。');
  assert(n.parentId === null || identifier(n.parentId), '親IDが不正です。');
  for (const key of ['title','body','domain','status','start','due','kind','unit','formula','artifact','criteria']) assert(typeof n[key] === 'string' && n[key].length <= 100000, `${key} は文字列（10万文字以内）にしてください。`);
  assert(n.title.trim().length, '枝の名前を入力してください。');
  for (const key of ['depth','x','y','progress','version']) assert(Number.isFinite(n[key]), `${key} は有限の数値にしてください。`);
  assert(Number.isInteger(n.depth) && n.depth >= 0 && Number.isInteger(n.version) && n.version > 0, '深さ・版は有効な整数にしてください。');
  assert(n.progress >= 0 && n.progress <= 100, '計画進捗は0〜100です。');
  assert(n.value === null || Number.isFinite(n.value), '数値は有限値または未入力にしてください。');
  assert(typeof n.required === 'boolean', '必要な成果の指定は真偽値にしてください。');
  assert(n.weight === null || Number.isFinite(n.weight) && n.weight > 0, '成果の重みは正の数、未見積りは空欄にしてください。');
  assert(Array.isArray(n.specs) && n.specs.length <= 100, '設定は100件以内にしてください。');
  const specKeys=new Set();
  n.specs=n.specs.map(spec=>{
    assert(object(spec)&&Object.keys(spec).every(k=>['key','value'].includes(k))&&typeof spec.key==='string'&&spec.key.trim()&&spec.key.length<=120&&typeof spec.value==='string'&&spec.value.length<=10000,'設定は名前と値の組にしてください。');
    const key=spec.key.trim();assert(!specKeys.has(key),'同じ設定名が重複しています。');specKeys.add(key);return {key,value:spec.value};
  });
  assert(Array.isArray(n.sourceRefs)&&n.sourceRefs.length<=30,'契約の参照は30件以内にしてください。');
  for(const ref of n.sourceRefs) assert(object(ref)&&Object.keys(ref).every(k=>['documentId','section','sha256','revision'].includes(k))&&['goal','design','discovery'].includes(ref.documentId)&&typeof ref.section==='string'&&ref.section.length<=500&&typeof ref.revision==='string'&&ref.revision.length<=200&&/^[a-f0-9]{64}$/.test(ref.sha256||''),'契約の参照形式を確認してください。');
  for (const key of ['start','due']) assert(!n[key] || /^\d{4}-\d{2}-\d{2}$/.test(n[key]) && !Number.isNaN(Date.parse(n[key])), '日付は YYYY-MM-DD です。');
  assert(!n.start || !n.due || n.start <= n.due, '開始日が期限を超えています。');
  if (n.verified !== false) {
    const e = n.verified;
    assert(object(e) && /^[a-f0-9]{64}$/i.test(e.artifactHash || '') && e.criteria === n.criteria && typeof e.method === 'string' && e.method.trim() && e.result === 'passed' && typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) && n.artifact && n.criteria, '確認済みには現物の指紋・受入条件・検証方法・結果・時点が必要です。');
  }
  return n;
}
function validate(state) {
  assert(Array.isArray(state.nodes) && Array.isArray(state.links), 'nodes と links が必要です。');
  assert(state.nodes.length <= 10000 && state.links.length <= 50000, '取込上限（枝1万件・関係5万件）を超えています。');
  state.nodes = state.nodes.map(node);
  const ids = new Set(state.nodes.map(n => n.id));
  assert(ids.size === state.nodes.length, '枝IDが重複しています。');
  const nodes = new Map(state.nodes.map(n => [n.id, n]));
  for (const n of state.nodes) {
    assert(n.parentId === null || ids.has(n.parentId), `親が存在しません: ${n.id}`);
    let current = n; const visited = new Set();
    while (current) { assert(!visited.has(current.id), '親子関係が循環しています。'); visited.add(current.id); current = nodes.get(current.parentId); }
  }
  const linkIds = new Set();
  for (const l of state.links) {
    assert(object(l) && !Object.keys(l).some(k => !linkFields.has(k)), '未対応の関係属性があります。');
    assert(identifier(l.id) && ids.has(l.from) && ids.has(l.to) && typeof l.type === 'string' && l.type.length > 0 && l.type.length < 100, '関係ID・対象・種類が不正です。');
    assert(!linkIds.has(l.id), '関係IDが重複しています。'); linkIds.add(l.id);
    assert(l.from !== l.to, '自分自身への関係は作成できません。');
    assert(l.reason===undefined || typeof l.reason==='string' && l.reason.length<=20000,'関係の理由は文字列にしてください。');
    assert(l.type!=='exception_to' || typeof l.reason==='string' && l.reason.trim(),'局所例外には置き換える理由が必要です。');
  }
  // Temporal precedence must be acyclic; semantic relationships may form cycles.
  const adjacency = new Map();
  for (const l of state.links.filter(l => ['precedes','before','工程'].includes(l.type))) { if (!adjacency.has(l.from)) adjacency.set(l.from, []); adjacency.get(l.from).push(l.to); }
  const visiting = new Set(), done = new Set();
  function visit(id) { assert(!visiting.has(id), '工程順が循環しています。'); if (done.has(id)) return; visiting.add(id); for (const next of adjacency.get(id) || []) visit(next); visiting.delete(id); done.add(id); }
  for (const id of adjacency.keys()) visit(id);
  return state;
}

export function createStore({ root = process.cwd(), dataDir } = {}) {
  root = realpathSync(resolve(root));
  const projectId = hash(process.platform === 'win32' ? root.toLowerCase() : root).slice(0, 20);
  dataDir = resolve(dataDir || join(process.env.LOCALAPPDATA || join(homedir(), '.local','share'), 'Mindwise-Rebuild', projectId));
  mkdirSync(dataDir, {recursive:true});
  const db = new DatabaseSync(join(dataDir,'mindwise.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS mutations (revision INTEGER PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, kind TEXT NOT NULL, at TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0);');
  db.exec('CREATE TABLE IF NOT EXISTS mutation_context (operation_id TEXT PRIMARY KEY, body TEXT NOT NULL);');
  const initial = {schemaVersion:1,projectId,revision:0,nodes:[],links:[],runs:[]};
  db.prepare('INSERT OR IGNORE INTO state (id,body) VALUES (1,?)').run(JSON.stringify(initial));
  function raw() { return JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body); }
  assert(raw().projectId === projectId, '保存データは別の案件に属しています。専用の保存先を指定してください。',409);
  function save(state) { db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(state)); }
  function transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } }
  const recovered = raw(); let recovery = false;
  for (const run of recovered.runs) if (['connecting','applying','running','starting','in_progress','pending','waiting'].includes(run.status)) { run.status='interrupted'; run.recovery='前回停止後の実行結果は未照合です。自動再送していません。'; run.updatedAt=new Date().toISOString(); recovery=true; }
  if (recovery) transaction(() => save(recovered));
  function history() { return db.prepare('SELECT revision, operation_id AS operationId, kind, at, undone FROM mutations ORDER BY revision DESC').all(); }
  function provenance(targetId) {
    assert(raw().nodes.some(n=>n.id===targetId),'対象が見つかりません。',404);
    const entries=[];
    for(const row of db.prepare('SELECT m.*, c.body AS context FROM mutations m LEFT JOIN mutation_context c ON c.operation_id=m.operation_id ORDER BY revision DESC').iterate()) {
      const before=JSON.parse(row.before_json),after=JSON.parse(row.after_json),a=before.nodes.find(n=>n.id===targetId),b=after.nodes.find(n=>n.id===targetId);
      const fields=[...new Set([...Object.keys(a||{}),...Object.keys(b||{})])].filter(k=>k!=='version'&&JSON.stringify(a?.[k])!==JSON.stringify(b?.[k]));
      const links=state=>state.links.filter(l=>l.from===targetId||l.to===targetId);
      const relationsChanged=JSON.stringify(links(before))!==JSON.stringify(links(after));
      if(!fields.length&&!relationsChanged)continue;
      const context=row.context?JSON.parse(row.context):null;
      const legacyRun=raw().runs.find(r=>`ai-${r.id}`===row.operation_id);
      entries.push({revision:row.revision,operationId:row.operation_id,kind:row.kind,at:row.at,undone:Boolean(row.undone),actor:context?.actor|| (legacyRun?'codex':'unknown'),reason:context?.reason||legacyRun?.decisionReason||null,runId:context?.runId||legacyRun?.id||null,sourceRefs:context?.sourceRefs||[],inputs:context?.inputs||[],changes:fields.map(field=>({field,before:a?.[field]??null,after:b?.[field]??null})),relations:relationsChanged?{before:links(before),after:links(after)}:null});
      if(entries.length>=100)break;
    }
    return {targetId,entries,limit:100,runs:raw().runs.filter(r=>r.targetId===targetId).map(({id,status,mode,startedAt,targetVersion,prompt,reply,decisionReason,adoptedRevision})=>({id,status,mode,startedAt,targetVersion,prompt,reply,decisionReason,adoptedRevision}))};
  }
  function operationReceipt(operationId) {
    const row=db.prepare('SELECT revision,kind,after_json FROM mutations WHERE operation_id=?').get(operationId);
    return row?{revision:row.revision,kind:row.kind,after:JSON.parse(row.after_json)}:null;
  }
  function getState() { const state=raw();state.nodes=state.nodes.map(node);return {...state,history:history()}; }
  function mutate(payload, kind, transform) {
    assert(object(payload) && identifier(payload.operationId), '一意の operationId が必要です。');
    if(payload.meta!==undefined) {
      const meta=payload.meta;
      assert(object(meta)&&Object.keys(meta).every(k=>['actor','reason','runId','sourceRefs','inputs'].includes(k))&&['owner','codex'].includes(meta.actor)&& (meta.reason===null||typeof meta.reason==='string'&&meta.reason.length<=20000)&&JSON.stringify(meta).length<=1000000&& (meta.inputs===undefined||Array.isArray(meta.inputs)&&meta.inputs.length<=80)&& (meta.sourceRefs===undefined||Array.isArray(meta.sourceRefs)&&meta.sourceRefs.length<=100),'変更の出所形式を確認してください。');
    }
    const requestHash = hash(payload);
    transaction(() => {
      const old = db.prepare('SELECT request_hash FROM mutations WHERE operation_id=?').get(payload.operationId);
      if (old) { assert(old.request_hash === requestHash, '同じ操作IDで異なる内容が送られました。',409); return; }
      const before = raw();
      assert(Number.isInteger(payload.baseRevision) && before.revision === payload.baseRevision, '別の変更が先に保存されました。最新状態を取得して変更を確認してください。',409);
      const after = transform(clone(before)); validate(after); after.revision=before.revision+1;
      const at = new Date().toISOString();
      db.prepare('INSERT INTO mutations (revision,operation_id,request_hash,before_json,after_json,kind,at) VALUES (?,?,?,?,?,?,?)').run(after.revision,payload.operationId,requestHash,JSON.stringify(before),JSON.stringify(after),kind,at);
      if(payload.meta)db.prepare('INSERT INTO mutation_context (operation_id,body) VALUES (?,?)').run(payload.operationId,JSON.stringify(payload.meta));
      save(after);
    });
    return getState();
  }
  function checkOps(payload) {
    assert(object(payload) && Array.isArray(payload.ops) && payload.ops.length > 0 && payload.ops.length <= 10000, '1〜10000件の変更操作が必要です。');
    const isUndo=payload.ops.some(op=>op?.type==='undo');
    assert(!isUndo || payload.ops.length===1, '取消は単独で実行してください。');
    return isUndo;
  }
  function applyOperations(state,ops) {
    state.nodes=state.nodes.map(node);
    const before=clone(state);
    for(const op of ops) {
      assert(object(op),'変更操作が不正です。');
      if(op.type==='add') {
        const n=node(op.node || {});assert(!state.nodes.some(x=>x.id===n.id),'その枝IDは存在します。',409);state.nodes.push(n);
      } else if(op.type==='update') {
        const i=state.nodes.findIndex(n=>n.id===op.id);assert(i>=0,'変更する枝がありません。',404);
        assert(object(op.patch)&&!('id' in op.patch)&&!('version' in op.patch),'IDや版は変更できません。');
        const previous=state.nodes[i], substantive=Object.keys(op.patch).some(k=>meaningfulFields.has(k)&&JSON.stringify(previous[k])!==JSON.stringify(op.patch[k]));
        state.nodes[i]=node({...previous,...op.patch,version:previous.version+1,...(substantive?{verified:false}:{})});
      } else if(op.type==='delete') {
        assert(state.nodes.some(n=>n.id===op.id),'削除する枝がありません。',404);
        state.nodes=state.nodes.filter(n=>n.id!==op.id).map(n=>n.parentId===op.id?{...n,parentId:null,version:n.version+1}:n);
        state.links=state.links.filter(l=>l.from!==op.id&&l.to!==op.id);
      } else if(op.type==='link') state.links.push({id:randomUUID(),...op.link});
      else if(op.type==='unlink') {
        assert(state.links.some(l=>l.id===op.id),'解除する関係がありません。',404);state.links=state.links.filter(l=>l.id!==op.id);
      } else throw new StoreError(`未対応の操作: ${op.type}`);
    }
    validate(state);
    const impact=analyzeChange(before,state), invalidate=new Set([...impact.affected,...impact.unknown]);
    state.nodes=state.nodes.map(n=>invalidate.has(n.id)&&n.verified?{...n,verified:false,version:n.version+1}:n);
    return {state,impact};
  }
  function preview(payload) {
    const isUndo=checkOps(payload);assert(!isUndo,'取消は変更履歴から実行してください。');
    assert(identifier(payload.operationId),'一意の operationId が必要です。');
    const state=raw();assert(Number.isInteger(payload.baseRevision)&&payload.baseRevision===state.revision,'別の変更が先に保存されました。最新状態を取得してください。',409);
    return {baseRevision:state.revision,impact:applyOperations(clone(state),payload.ops).impact};
  }
  function change(payload,{runUpdate}={}) {
    const isUndo=checkOps(payload);
    return mutate(payload,isUndo?'undo':'change',state=>{
      if(isUndo) {
        const target=db.prepare("SELECT * FROM mutations WHERE kind != 'undo' AND undone=0 ORDER BY revision DESC LIMIT 1").get();
        assert(target,'取り消せる変更がありません。',409);
        const previous=JSON.parse(target.before_json),current=new Map(state.nodes.map(n=>[n.id,n]));
        // Restore the model's recorded evidence, not external bytes. Its actual
        // file/criteria/spec freshness is checked independently by /api/analysis.
        state.nodes=previous.nodes.map(n=>({...n,version:(current.get(n.id)?.version||n.version)+1}));state.links=previous.links;
        db.prepare('UPDATE mutations SET undone=1 WHERE revision=?').run(target.revision);
        return state;
      }
      const changed=applyOperations(state,payload.ops).state;
      if(runUpdate) {
        const i=changed.runs.findIndex(r=>r.id===runUpdate.id);
        assert(i>=0&&runUpdate.status==='adopted'&&changed.runs[i].mode==='settings'&&changed.runs[i].status==='proposed','設定案の採用記録が一致しません。',409);
        changed.runs[i]={...changed.runs[i],status:'adopted',adoptedAt:runUpdate.adoptedAt,adoptedRevision:state.revision+1};
      }
      return changed;
    });
  }
  function recordRun(run) {
    assert(object(run)&&identifier(run.id),'実行IDが必要です。');
    transaction(()=>{ const state=raw(); const i=state.runs.findIndex(r=>r.id===run.id); const existing=i<0?null:state.runs[i];
      if(existing) for(const key of ['nodeId','targetId','targetVersion','projectId']) if(existing[key]!==undefined && run[key]!==undefined) assert(existing[key]===run[key], '実行対象は途中で変更できません。',409);
      const value={...existing,...clone(run),updatedAt:new Date().toISOString()};
      if(i<0) state.runs.push(value); else state.runs[i]=value; save(state);
    }); return getState();
  }
  function exportState() { return {...getState(),exportedAt:new Date().toISOString(),backupScope:'作業モデル・履歴・実行記録。外部成果物と認証情報は含みません。'}; }
  function importState(payload) {
    assert(object(payload),'取込内容が不正です。');
    const imported=payload.state || payload;
    assert(imported.schemaVersion===1,'未対応の交換形式です。schemaVersion 1 が必要です。');
    const allowed=new Set(['schemaVersion','projectId','revision','nodes','links','runs','history','exportedAt','backupScope','baseRevision','operationId']);
    const unknown=Object.keys(imported).filter(k=>!allowed.has(k));
    assert(!unknown.length,`未対応項目のため取込を中止: ${unknown.join(', ')}`);
    validate(clone(imported));
    return mutate(payload,'import',state=>{state.nodes=clone(imported.nodes).map(n=>({...n,verified:false}));state.links=clone(imported.links);return state;});
  }
  function backup() {
    const file=join(dataDir,`backup-${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}.sqlite`);
    db.prepare('VACUUM INTO ?').run(file);
    const check=new DatabaseSync(file,{readOnly:true});
    try { assert(Object.values(check.prepare('PRAGMA integrity_check').get())[0]==='ok','バックアップ照合に失敗しました。',500); assert(check.prepare('SELECT body FROM state WHERE id=1').get().body===JSON.stringify(raw()),'バックアップの内容が一致しません。',500); } finally { check.close(); }
    return {path:file,sha256:createHash('sha256').update(readFileSync(file)).digest('hex'),revision:raw().revision,scope:'作業モデル・全変更履歴・実行記録。外部成果物と認証情報は含みません。',createdAt:new Date().toISOString()};
  }
  return {getState,change,preview,operationReceipt,recordRun,exportState,importState,backup,history,provenance,dataDir,projectId,close:()=>db.close()};
}
