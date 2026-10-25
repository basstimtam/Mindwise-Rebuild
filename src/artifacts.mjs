import { openSync, closeSync, fstatSync, readSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveSpecifications } from './semantics.mjs';
import { contractContext } from './contracts.mjs';

const maxArtifactBytes = 2 * 1024 * 1024;
const textExtensions = new Set('.md .txt .json .csv .html .css .js .mjs .py .svg .xml .ts .tsx .jsx .yaml .yml .toml'.split(' '));
const within = (base, candidate) => { const rel = relative(base, candidate); return rel !== '' && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel); };
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');

export class ArtifactError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Read only the file explicitly attached to this target, never a browser supplied path. */
export function readNodeArtifact(root, node) {
  if (!node || typeof node.artifact !== 'string' || !node.artifact.trim()) throw new ArtifactError('この対象には成果物が設定されていません。', 404);
  let descriptor;
  try {
    const base = realpathSync(resolve(root)), requested = resolve(base, node.artifact);
    if (!within(base, requested)) throw new ArtifactError('成果物は登録した案件の範囲外です。', 403);
    const actual = realpathSync(requested);
    if (!within(base, actual)) throw new ArtifactError('成果物のリンク先は登録した案件の範囲外です。', 403);
    if (!textExtensions.has(extname(actual).toLowerCase())) throw new ArtifactError('この確認画面はテキスト成果物だけに対応しています。', 415);
    descriptor = openSync(actual, 'r');
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new ArtifactError('成果物は通常のファイルを指定してください。');
    if (stat.size > maxArtifactBytes) throw new ArtifactError('画面で確認できる成果物は2MiBまでです。', 413);
    const buffer = Buffer.alloc(Math.min(stat.size + 1, maxArtifactBytes + 1));
    let length = 0, count;
    do { count = readSync(descriptor, buffer, length, buffer.length - length, length); length += count; } while (count && length < buffer.length);
    // Growth during the read is treated as an unstable observation, not accepted evidence.
    if (length > maxArtifactBytes) throw new ArtifactError('画面で確認できる成果物は2MiBまでです。', 413);
    const after = fstatSync(descriptor);
    if (length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || realpathSync(requested) !== actual) throw new ArtifactError('読取中に成果物が変わりました。もう一度確認してください。', 409);
    const bytes = buffer.subarray(0, length);
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ArtifactError('UTF-8のテキスト成果物として読み取れません。', 415); }
    if (text.includes('\0')) throw new ArtifactError('バイナリを含む成果物はこの確認画面では扱えません。', 415);
    return {
      path: node.artifact,
      text,
      sha256: fingerprint(bytes),
      canonicalKey: (process.platform === 'win32' ? actual.toLowerCase() : actual).replaceAll('\\', '/'),
      bytes: bytes.length,
      observedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new ArtifactError('参照している成果物が見つかりません。', 404);
    if (error.code === 'EACCES' || error.code === 'EPERM') throw new ArtifactError('成果物を読み取れません。', 403);
    throw new ArtifactError('成果物のパスと読取状態を確認してください。');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Verify freshness from live bytes and effective specs; an AI/task completion is not proof. */
export function assessSources(root,state,node,specification=resolveSpecifications(state,node.id),catalog) {
  const ids=new Set([node.id,...specification.sources.map(s=>s.id)]);
  const refs=[...new Map(state.nodes.filter(n=>ids.has(n.id)).flatMap(n=>n.sourceRefs||[]).map(ref=>[JSON.stringify(ref),ref])).values()];
  if(!refs.length)return {status:'current',fingerprint:null,count:0};
  if(refs.length>100)return {status:'unresolved',fingerprint:null,count:refs.length};
  const context=contractContext(root,refs,catalog);
  return {status:context.references.every(r=>r.status==='current'&&['approved','record'].includes(r.documentStatus))?'current':'unresolved',fingerprint:fingerprint(JSON.stringify(context.references)),count:refs.length};
}
export function evaluateVerification(root, state, node, { specification, artifact, catalog } = {}) {
  const checkedAt = new Date().toISOString();
  if (!node?.artifact) return { status: 'unverified', reason: '成果物が未設定です。', checkedAt };
  let current;
  try { current = artifact || readNodeArtifact(root, node); }
  catch (error) {
    // Missing bytes do not create a new unit of work: preserve the declared
    // identity for relative/absolute references to the same in-root location.
    let canonicalKey;
    if(error.status===404) {
      try {
        const base=realpathSync(resolve(root)), requested=resolve(base,node.artifact);
        if(within(base,requested))canonicalKey=(process.platform==='win32'?requested.toLowerCase():requested).replaceAll('\\','/');
      } catch {}
    }
    return { status: 'missing', reason: error.message, checkedAt, ...(canonicalKey?{canonicalKey}:{}) };
  }
  const common = { canonicalKey: current.canonicalKey, artifactHash: current.sha256, checkedAt };
  const spec = specification || resolveSpecifications(state, node.id);
  if (spec.status !== 'resolved') return { ...common, status: 'conflict', reason: '適用仕様に未解決の衝突または循環があります。' };
  const sources=assessSources(root,state,node,spec,catalog);
  if(sources.status!=='current')return {...common,status:'stale',reason:'参照した契約の原文・版・承認状態を再確認してください。'};
  const proof = node.verified;
  if (!proof || typeof proof !== 'object') return { ...common, status: 'unverified', reason: '受入確認はまだ記録されていません。' };
  if (proof.result !== 'passed' || typeof proof.method !== 'string' || !proof.method.trim() || !Number.isInteger(proof.targetVersion) || proof.targetVersion < 1 || typeof proof.at !== 'string' || Number.isNaN(Date.parse(proof.at))) {
    return { ...common, status: 'stale', reason: '現行の確認証拠の形式ではありません。再確認してください。', recordedAt: proof.at };
  }
  const changed = [];
  if (proof.artifact !== node.artifact || proof.artifactHash !== current.sha256) changed.push('成果物');
  if (!node.criteria?.trim() || proof.criteria !== node.criteria) changed.push('受入条件');
  if (proof.specHash !== spec.fingerprint) changed.push('有効な仕様');
  if ((proof.sourceHash??null) !== sources.fingerprint) changed.push('契約の出所');
  if (changed.length) return { ...common, status: 'stale', reason: `${changed.join('・')}が確認時から変わっています。`, recordedAt: proof.at };
  return { ...common, status: 'verified', reason: '現物・受入条件・有効仕様が確認証拠と一致しています。', recordedAt: proof.at, method: proof.method };
}
