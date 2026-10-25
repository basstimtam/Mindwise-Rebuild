import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { createStore, StoreError } from './store.mjs';
import { readNodeArtifact, evaluateVerification, assessSources } from './artifacts.mjs';
import { resolveSpecifications, summarizeProgress } from './semantics.mjs';
import { readContracts, contractContext } from './contracts.mjs';

const rootDefault = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.json':'application/json; charset=utf-8'};
const hash = value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function inside(root,path) { const rel=relative(root,path); return !rel.startsWith('..')&&!isAbsolute(rel); }
async function body(req) {
  if (!String(req.headers['content-type']||'').startsWith('application/json')) throw new StoreError('Content-Type: application/json が必要です。',415);
  const chunks=[]; let length=0;
  for await(const chunk of req) { length+=chunk.length; if(length>8*1024*1024) throw new StoreError('入力は8MiB以内にしてください。',413); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new StoreError('JSONを読み取れません。'); }
}
export async function createServer({root=rootDefault,dataDir,port=Number(process.env.PORT||4316),store:providedStore,ai:providedAi}={}) {
  root=await realpath(root);
  const store=providedStore||createStore({root,dataDir:dataDir||process.env.MINDWISE_DATA_DIR});
  const ai=providedAi||(await import('./codex.mjs')).createCodexService({store,root});
  const token=randomBytes(32).toString('hex');
  let actualPort=port;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    function json(value,status=200) { res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); }
    try {
      const validHosts=new Set([`127.0.0.1:${actualPort}`,`localhost:${actualPort}`]);
      if(!validHosts.has(req.headers.host)) throw new StoreError('許可されていないHostです。127.0.0.1から開いてください。',403);
      if(req.headers.origin && !new Set([`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`]).has(req.headers.origin)) throw new StoreError('別サイトからの操作は許可されていません。',403);
      if(req.headers['sec-fetch-site']==='cross-site') throw new StoreError('別サイトからの接続は許可されていません。',403);
      const url=new URL(req.url,`http://127.0.0.1:${actualPort}`);
      if(!['GET','HEAD','POST'].includes(req.method)) throw new StoreError('未対応のHTTPメソッドです。',405);
      if(req.method==='POST') {
        const supplied=Buffer.from(String(req.headers['x-mindwise-token']||'')); const expected=Buffer.from(token);
        if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) throw new StoreError('セッションが一致しません。画面を再読込してください。',403);
      }
      if(url.pathname==='/api/session' && req.method==='GET') return json({token,projectId:store.projectId});
      if(url.pathname==='/api/state' && req.method==='GET') return json(store.getState());
      if(url.pathname==='/api/history' && req.method==='GET') return json(store.history());
      if(url.pathname==='/api/contracts' && req.method==='GET') return json(readContracts(root));
      if(url.pathname==='/api/provenance' && req.method==='GET') {
        const targetId=url.searchParams.get('targetId'),state=store.getState(),node=state.nodes.find(n=>n.id===targetId);
        if(!node)throw new StoreError('対象が見つかりません。',404);
        return json({...store.provenance(targetId),sources:contractContext(root,node.sourceRefs||[])});
      }
      if(url.pathname==='/api/analysis' && req.method==='GET') {
        const state=store.getState(), targetId=url.searchParams.get('targetId'),catalog=readContracts(root);
        if(targetId&&!state.nodes.some(n=>n.id===targetId)) throw new StoreError('対象が見つかりません。',404);
        const verificationById=Object.create(null), artifactKeys=Object.create(null);
        for(const node of state.nodes) {
          const observation=evaluateVerification(root,state,node,{catalog});
          verificationById[node.id]=observation;
          if(observation.canonicalKey) artifactKeys[node.id]=observation.canonicalKey;
        }
        return json({revision:state.revision,specification:targetId?resolveSpecifications(state,targetId):null,verificationById,progress:summarizeProgress(state,verificationById,artifactKeys)});
      }
      if(url.pathname==='/api/artifact' && req.method==='GET') {
        const nodeId=url.searchParams.get('nodeId');
        if(nodeId) {
          const state=store.getState(), node=state.nodes.find(n=>n.id===nodeId);
          if(!node) throw new StoreError('対象が見つかりません。',404);
          const artifact=readNodeArtifact(root,node), specification=resolveSpecifications(state,nodeId);
          const sources=assessSources(root,state,node,specification);
          return json({...artifact,revision:state.revision,targetId:nodeId,targetVersion:node.version,criteria:node.criteria,specHash:specification.fingerprint,sourceHash:sources.fingerprint,sourceStatus:sources.status,specificationStatus:specification.status,verification:evaluateVerification(root,state,node,{artifact,specification})});
        }
        const run=store.getState().runs.find(r=>r.id===url.searchParams.get('runId'));
        const index=Number(url.searchParams.get('index'));
        const artifact=Number.isInteger(index)&&index>=0?run?.artifacts?.[index]:null;
        if(!artifact) throw new StoreError('登録された成果物が見つかりません。',404);
        const outputRoot=await realpath(resolve(root,'artifacts',run.id));
        const actual=await realpath(resolve(root,artifact.path));
        if(!inside(root,outputRoot)||!inside(outputRoot,actual)) throw new StoreError('成果物が許可範囲外です。',403);
        const observed=readNodeArtifact(root,{artifact:artifact.path});
        return json({path:artifact.path,text:observed.text,sha256:observed.sha256,recordedSha256:artifact.sha256,matches:observed.sha256===artifact.sha256});
      }
      if(url.pathname==='/api/export' && req.method==='GET') {res.setHeader('Content-Disposition','attachment; filename="mindwise-project.json"');return json(store.exportState());}
      if(url.pathname==='/api/change' && req.method==='POST') return json(store.change(await body(req)));
      if(url.pathname==='/api/preview' && req.method==='POST') return json(store.preview(await body(req)));
      if(url.pathname==='/api/verify' && req.method==='POST') {
        const input=await body(req);
        const fields=new Set(['baseRevision','operationId','targetId','targetVersion','artifactHash','criteria','sourceHash','method','result','note']);
        if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!fields.has(key))) throw new StoreError('確認記録の形式を確認してください。');
        if(!Number.isInteger(input.baseRevision)||!Number.isInteger(input.targetVersion)||input.targetVersion<1||typeof input.operationId!=='string'||!/^[\p{L}\p{N}_:.-]{1,160}$/u.test(input.operationId)||typeof input.targetId!=='string') throw new StoreError('確認した対象版と操作IDが必要です。');
        if(input.method!=='owner-review'||input.result!=='passed'||typeof input.criteria!=='string'||!input.criteria.trim()||typeof input.artifactHash!=='string'||!(/^[a-f0-9]{64}$/i.test(input.artifactHash))) throw new StoreError('現物と受入条件を確認し、確認方法と合格結果を明示してください。');
        if(input.note!==undefined&&(typeof input.note!=='string'||input.note.length>4000)) throw new StoreError('確認メモは4000文字以内にしてください。');
        const requestHash=hash(input), receipt=store.operationReceipt(input.operationId);
        if(receipt) {
          const proof=receipt.after.nodes.find(n=>n.id===input.targetId)?.verified;
          if(proof?.operationId!==input.operationId||proof.requestHash!==requestHash) throw new StoreError('同じ操作IDで異なる内容が送られました。',409);
          return json(store.getState());
        }
        const state=store.getState(), node=state.nodes.find(n=>n.id===input.targetId);
        if(!node) throw new StoreError('確認する対象がありません。',404);
        if(state.revision!==input.baseRevision||node.version!==input.targetVersion||node.criteria!==input.criteria) throw new StoreError('確認画面を開いてから対象が変わりました。最新の内容を読み直してください。',409);
        const specification=resolveSpecifications(state,node.id);
        if(specification.status!=='resolved') throw new StoreError('仕様の衝突または循環を解決してから確認してください。',409);
        const sources=assessSources(root,state,node,specification);
        if(sources.status!=='current'||(input.sourceHash??null)!==sources.fingerprint)throw new StoreError('確認画面の契約原文・版・承認状態が変わっています。出所を照合してから開き直してください。',409);
        const artifact=readNodeArtifact(root,node);
        if(artifact.sha256!==input.artifactHash.toLowerCase()) throw new StoreError('確認画面を開いてから現物が変わりました。読み直してください。',409);
        const proof={artifactHash:artifact.sha256,artifact:node.artifact,criteria:node.criteria,specHash:specification.fingerprint,sourceHash:sources.fingerprint,method:input.method,result:input.result,at:new Date().toISOString(),targetVersion:node.version,reviewer:'owner',operationId:input.operationId,requestHash,...(input.note?{note:input.note}:{})};
        return json(store.change({baseRevision:state.revision,operationId:input.operationId,ops:[{type:'update',id:node.id,patch:{verified:proof}}]}));
      }
      if(url.pathname==='/api/import' && req.method==='POST') return json(store.importState(await body(req)));
      if(url.pathname==='/api/backup' && req.method==='POST') return json(store.backup());
      if(url.pathname==='/api/ai/status' && req.method==='GET') return json(await ai.status());
      if(url.pathname==='/api/ai/events' && req.method==='GET') return json(await ai.events());
      if(url.pathname==='/api/ai/start' && req.method==='POST') return json(await ai.start(await body(req)));
      if(url.pathname==='/api/ai/proposal' && req.method==='POST') return json(await ai.previewProposal(await body(req)));
      if(url.pathname==='/api/ai/adopt' && req.method==='POST') return json(await ai.adoptProposal(await body(req)));
      if(url.pathname==='/api/ai/interrupt' && req.method==='POST') return json(await ai.interrupt());
      if(url.pathname.startsWith('/api/')) throw new StoreError('APIが見つかりません。',404);
      if(req.method!=='GET' && req.method!=='HEAD') throw new StoreError('未対応の操作です。',405);
      const publicRoot=await realpath(resolve(root,'public'));
      const requested=resolve(publicRoot, '.'+decodeURIComponent(url.pathname==='/'?'/index.html':url.pathname));
      if(!inside(publicRoot,requested)) throw new StoreError('公開範囲外のパスです。',403);
      let actual; try { actual=await realpath(requested); } catch { throw new StoreError('ファイルが見つかりません。',404); }
      if(!inside(publicRoot,actual)) throw new StoreError('リンク先は公開範囲外です。',403);
      const bytes=await readFile(actual); res.writeHead(200,{'Content-Type':mime[extname(actual)]||'application/octet-stream'}); res.end(req.method==='HEAD'?undefined:bytes);
    } catch(e) { if(!res.headersSent) json({error:e.message||'処理に失敗しました。',details:e.details},e.status||500); else res.end(); }
  });
  await new Promise((ok,fail)=>{server.once('error',fail);server.listen(port,'127.0.0.1',ok);});
  actualPort=server.address().port;
  async function close() { await ai.close?.(); await new Promise((ok,fail)=>server.close(e=>e?fail(e):ok())); if(!providedStore) store.close(); }
  return {server,store,ai,close,url:`http://127.0.0.1:${actualPort}`};
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const app=await createServer();
  console.log(`Mindwise: ${app.url}\n保存先: ${app.store.dataDir}`);
  let closing=false; const stop=async()=>{if(closing)return;closing=true;await app.close();process.exit(0);};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
}
