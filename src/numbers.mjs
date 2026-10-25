import { createHash } from 'node:crypto';
import { contractContext, readContracts } from './contracts.mjs';
import { resolveSpecifications } from './semantics.mjs';
export { numericDependencies } from './number-links.mjs';
import { hasNumber } from './number-links.mjs';
export { hasNumber } from './number-links.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const issue = (code, message) => ({code, message});
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const identifier = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
export const validMetricName = name => typeof name === 'string' && identifier.test(name);

/** Small arithmetic language. No eval, property access, calls, strings or ambient names. */
export function parseFormula(text) {
  if(typeof text !== 'string' || text.length > 2000) fail('limit','式は2000文字以内にしてください。');
  const tokens = []; let pos = 0;
  while(pos < text.length) {
    if(/\s/.test(text[pos])) {pos++;continue;}
    const rest = text.slice(pos), number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    const name = /^[A-Za-z][A-Za-z0-9_]*/.exec(rest);
    if(number) {const value=Number(number[0]);if(!Number.isFinite(value))fail('non-finite','定数が有限値ではありません。');tokens.push({type:'number',value});pos+=number[0].length;}
    else if(name) {if(!validMetricName(name[0]))fail('syntax','式の参照名は英字から始まる32文字以内です。');tokens.push({type:'name',value:name[0]});pos+=name[0].length;}
    else if('+-*/()'.includes(text[pos])) tokens.push({type:text[pos++]});
    else fail('syntax',`式の ${pos+1} 文字目を解釈できません。四則・括弧・参照名を使ってください。`);
    if(tokens.length>512)fail('limit','式の要素数は512個以内にしてください。');
  }
  let cursor=0, depth=0; const names=new Set();
  function primary() {
    if(++depth>32)fail('limit','式の括弧・演算の深さは32段以内です。');
    let result, token=tokens[cursor++];
    if(token?.type==='number')result={type:'number',value:token.value};
    else if(token?.type==='name') {names.add(token.value);result={type:'name',name:token.value};}
    else if(token?.type==='+'||token?.type==='-')result={type:'unary',op:token.type,right:primary()};
    else if(token?.type==='(') {result=expression();if(tokens[cursor++]?.type!==')')fail('syntax','閉じ括弧が必要です。');}
    else fail('syntax','式の値または参照名が必要です。');
    depth--;return result;
  }
  function product() {let result=primary();while(['*','/'].includes(tokens[cursor]?.type)){const op=tokens[cursor++].type;result={type:'binary',op,left:result,right:primary()};}return result;}
  function expression() {let result=product();while(['+','-'].includes(tokens[cursor]?.type)){const op=tokens[cursor++].type;result={type:'binary',op,left:result,right:product()};}return result;}
  const ast=expression();if(cursor!==tokens.length)fail('syntax','式に余分な要素があります。');
  return {ast,names:[...names]};
}

// Units are case-sensitive symbols, not a conversion catalogue. 1 is dimensionless.
export function parseUnit(text) {
  if(typeof text!=='string'||!text.trim())fail('unit-missing','単位が未定義です。無単位は 1 と入力してください。');
  if(text.length>120)fail('unit','単位は120文字以内にしてください。');
  const result=new Map();let divide=false,expect=true;
  for(const raw of text.trim().split(/([*/])/)) {
    const part=raw.trim();
    if(part==='*'||part==='/') {if(expect)fail('unit','単位の積・商の書き方を確認してください。');divide=part==='/';expect=true;continue;}
    const match=/^([\p{L}\p{N}_¥$€%]+)(?:\^(-?\d{1,2}))?$/u.exec(part);
    if(!expect||!match)fail('unit','単位は記号の積・商・整数べき（例：円/時間、m^2）で入力してください。');
    const power=(match[2]===undefined?1:Number(match[2]))*(divide?-1:1);
    if(Math.abs(power)>12)fail('unit','単位の指数は±12以内です。');
    if(match[1]!=='1')result.set(match[1],(result.get(match[1])||0)+power);
    expect=false;
  }
  if(expect)fail('unit','単位の末尾に演算子があります。');
  return normalize(result);
}
function normalize(unit) {
  const entries=[...unit].filter(([,p])=>p!==0).sort(([a],[b])=>a.localeCompare(b,'en'));
  if(entries.some(([,p])=>Math.abs(p)>12))fail('unit','計算後の単位の指数が±12を超えました。');
  return entries;
}
function combine(a,b,sign) {const map=new Map(a);for(const [symbol,power] of b)map.set(symbol,(map.get(symbol)||0)+sign*power);return normalize(map);}
function evaluate(ast,values) {
  if(ast.type==='number')return {value:ast.value,unit:[]};
  if(ast.type==='name')return values.get(ast.name);
  const right=evaluate(ast.right,values);
  if(ast.type==='unary')return {...right,value:ast.op==='-'?-right.value:right.value};
  const left=evaluate(ast.left,values);let value,unit;
  if(['+','-'].includes(ast.op)) {
    if(JSON.stringify(left.unit)!==JSON.stringify(right.unit))fail('unit-mismatch','加減算する値の単位が一致しません。');
    value=ast.op==='+'?left.value+right.value:left.value-right.value;unit=left.unit;
  } else {
    if(ast.op==='/'&&right.value===0)fail('divide-zero','0では割れません。');
    value=ast.op==='*'?left.value*right.value:left.value/right.value;unit=combine(left.unit,right.unit,ast.op==='*'?1:-1);
  }
  if(!Number.isFinite(value))fail('non-finite','計算結果が有限値ではありません。');
  return {value,unit};
}
function plan(node) {
  const result={node,refs:[],issues:[],ast:null,unit:null};
  if(!hasNumber(node))return result;
  try {
    result.unit=parseUnit(node.unit);
    if(node.formula?.trim()) {
      const parsed=parseFormula(node.formula);result.ast=parsed.ast;
      if(node.value!==null&&node.value!==undefined)result.issues.push(issue('ambiguous','入力値と式が両方あります。式を使う対象の入力値は空欄にしてください。'));
      const rows=node.metricInputs||[];
      if(!Array.isArray(rows)||rows.length>50)fail('limit','式の参照は50件以内にしてください。');
      const names=new Set();
      for(const row of rows) {
        if(!row||!validMetricName(row.name)||typeof row.nodeId!=='string')fail('reference','参照名と対象を確認してください。');
        if(names.has(row.name))fail('duplicate-name','式の参照名が重複しています。');names.add(row.name);
      }
      for(const name of parsed.names) {
        const ref=rows.find(row=>row.name===name);
        if(!ref)result.issues.push(issue('missing-reference',`参照名 ${name} の対象が未指定です。`));
        else result.refs.push(ref);
      }
    } else {
      if(!Number.isFinite(node.value))result.issues.push(issue('missing-value','入力値が未定義です。'));
      if(!node.metricSource?.trim())result.issues.push(issue('source-unknown','入力値の出所が不明です。'));
      if(node.metricFreshness!=='current')result.issues.push(issue(node.metricFreshness==='stale'?'stale':'freshness-unknown',node.metricFreshness==='stale'?'入力値は再確認が必要です。':'入力値の鮮度が不明です。'));
    }
  } catch(error) {result.issues.push(issue(error.code||'syntax',error.message));}
  return result;
}

/** Pure derived calculation: values never overwrite the stored inputs or imply acceptance. */
export function calculateNumbers(state,{root,catalog}={}) {
  const nodes=new Map((state.nodes||[]).map(n=>[n.id,n])), plans=new Map([...nodes].map(([id,n])=>[id,plan(n)]));
  const byId=Object.create(null), visiting=new Set(), checkedAt=new Date().toISOString();
  if(root&&!catalog)catalog=readContracts(root);
  function finish(p) {
    const n=p.node, inputs=p.refs.map(ref=>({name:ref.name,nodeId:ref.nodeId,title:nodes.get(ref.nodeId)?.title||'参照先がありません',version:nodes.get(ref.nodeId)?.version??null,status:byId[ref.nodeId]?.status||'unresolved',value:byId[ref.nodeId]?.value??null,unit:nodes.get(ref.nodeId)?.unit||'',fingerprint:byId[ref.nodeId]?.fingerprint||null}));
    const issues=[...p.issues];let computed=null;
    let sourceFingerprint=null;
    const spec=hasNumber(n)?resolveSpecifications(state,n.id):null;
    if(spec?.status==='conflict')issues.push(issue('spec-conflict','この数値に適用する仕様の衝突・循環を解決してください。'));
    const sourceIds=new Set([n.id,...(spec?.sources||[]).map(s=>s.id)]);
    const refs=[...new Map([...sourceIds].flatMap(id=>nodes.get(id)?.sourceRefs||[]).map(ref=>[JSON.stringify(ref),ref])).values()];
    if(refs.length) {
      const context=root&&refs.length<=100?contractContext(root,refs,catalog):null;
      sourceFingerprint=hash(context?.references||refs);
      if(!context||!context.references.every(r=>r.status==='current'&&['approved','record'].includes(r.documentStatus)))issues.push(issue('source-stale','参照した契約の原文・版・承認状態を再確認してください。'));
    }
    if(p.ast)for(const input of inputs)if(!['input','calculated'].includes(input.status))issues.push(issue('input-unresolved',`${input.name}（${input.title}）が未解決です。`));
    if(hasNumber(n)&&!issues.length) {
      try {
        computed=p.ast?evaluate(p.ast,new Map(inputs.map(input=>[input.name,{value:input.value,unit:parseUnit(input.unit)}]))):{value:n.value,unit:p.unit};
        if(JSON.stringify(computed.unit)!==JSON.stringify(p.unit))fail('unit-mismatch','式の結果と、この対象の単位が一致しません。');
      } catch(error) {issues.push(issue(error.code||'calculation',error.message));computed=null;}
    }
    const formulaHash=hash({formula:n.formula||'',unit:n.unit||'',refs:p.refs});
    // Layout and bookkeeping versions do not change the semantic fingerprint.
    const fingerprint=hash({formulaHash,value:n.value??null,source:n.metricSource||'',freshness:n.metricFreshness||'unknown',sourceFingerprint,specHash:spec?.fingerprint||null,inputs:inputs.map(({name,nodeId,fingerprint})=>({name,nodeId,fingerprint})),issues,valueResult:computed?.value??null});
    byId[n.id]={id:n.id,status:!hasNumber(n)?'empty':issues.length?'unresolved':p.ast?'calculated':'input',value:computed?.value??null,unit:n.unit||'',formula:n.formula||'',formulaHash,fingerprint,issues,inputs,source:{text:n.metricSource||'',freshness:n.metricFreshness||'unknown',sourceRefs:refs},specification:spec?{status:spec.status,fingerprint:spec.fingerprint,sources:spec.sources}:null,version:n.version,atRevision:state.revision};
  }
  for(const start of nodes.keys()) {
    if(byId[start])continue;
    const stack=[{id:start,index:0}];visiting.add(start);
    while(stack.length) {
      const frame=stack.at(-1), p=plans.get(frame.id);
      if(frame.index<p.refs.length) {
        const ref=p.refs[frame.index++];
        if(!nodes.has(ref.nodeId)) {p.issues.push(issue('missing-target',`${ref.name} の参照先が削除または欠落しています。`));continue;}
        if(byId[ref.nodeId])continue;
        if(visiting.has(ref.nodeId)) {for(const item of stack.slice(stack.findIndex(item=>item.id===ref.nodeId)))plans.get(item.id).issues.push(issue('cycle','式の参照が循環しています。'));continue;}
        if(stack.length>=256) {p.issues.push(issue('limit','数値の参照の深さが256段を超えています。'));continue;}
        stack.push({id:ref.nodeId,index:0});visiting.add(ref.nodeId);
      } else {finish(p);visiting.delete(frame.id);stack.pop();}
    }
  }
  return {revision:state.revision,checkedAt,byId};
}

export function numberContext(calculations,startIds) {
  const ids=new Set(), queue=[...startIds];
  for(let i=0;i<queue.length;i++) {
    const id=queue[i], result=calculations.byId[id];if(ids.has(id)||!result||result.status==='empty')continue;
    ids.add(id);for(const input of result.inputs)queue.push(input.nodeId);
  }
  return [...ids].map(id=>calculations.byId[id]);
}

export function assessNumbers(state,targetId,calculations,sourceIds=[]) {
  const starts=new Set([targetId,...sourceIds]);
  for(const link of state.links||[])if(link.from===targetId||link.to===targetId){starts.add(link.from);starts.add(link.to);}
  const context=numberContext(calculations,starts).sort((a,b)=>a.id.localeCompare(b.id,'en'));
  return {status:context.some(n=>n.status==='unresolved')?'unresolved':'current',fingerprint:context.length?hash(context.map(n=>({id:n.id,fingerprint:n.fingerprint}))):null,context};
}
