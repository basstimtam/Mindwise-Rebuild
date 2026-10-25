import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const definitions = [
  { id: 'goal', path: 'GOAL.md', title: '到達点と完成条件' },
  { id: 'design', path: 'DESIGN_STANDARD.md', title: '設計と品質の基準' },
  { id: 'discovery', path: 'DISCOVERY_LOG.md', title: '判断と承認の記録' }
];
const hash = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

// The registry binds a reviewed source to its provenance. It is not an execution
// permission, and cannot expand the fixed set of readable files.
function readRegistered(root, name) {
  const expected = resolve(root, name), stat = lstatSync(expected);
  if (stat.isSymbolicLink() || !stat.isFile() || !equalPath(realpathSync(expected), expected)) throw new Error('登録原文が通常ファイルではないか、リンクで置き換えられています。');
  if (stat.size > 2 * 1024 * 1024) throw new Error('登録原文の読取上限（2MiB）を超えています。');
  return readFileSync(expected);
}

function sectionsOf(text) {
  const lines = text.split('\n'), headings = [];
  let fence = null;
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, ''), marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) headings.push({ heading: heading[2], level: heading[1].length, index });
  }
  return headings.map((heading, index) => {
    const end = headings.slice(index + 1).find(next => next.level <= heading.level)?.index ?? lines.length;
    // Preserve original content and line endings inside each excerpt.
    const sectionText = lines.slice(heading.index, end).join('\n').trimEnd();
    return { heading: heading.heading, level: heading.level, startLine: heading.index + 1, endLine: end, text: sectionText, sha256: hash(sectionText.replaceAll('\r\n','\n')) };
  });
}

function field(text, name) {
  const matches = [...text.matchAll(new RegExp(`^- \\*\\*${name}\\*\\*:\\s*([^\\r\\n]+)`, 'gm'))];
  return matches.length === 1 ? matches[0][1].trim() : null;
}

export function readContracts(root) {
  root = realpathSync(resolve(root));
  const issues = [];
  let registry = null;
  try {
    registry = JSON.parse(readRegistered(root, 'contract-registry.json').toString('utf8'));
    if (registry.schemaVersion !== 1 || typeof registry.revision !== 'string' || !Array.isArray(registry.documents) || registry.documents.length !== 2 || registry.documents.some(row => !['goal', 'design'].includes(row.id) || !digest(row.sha256)) || new Set(registry.documents.map(row => row.id)).size !== 2 || registry.approval?.documentId !== 'discovery' || typeof registry.approval.section !== 'string' || !digest(registry.approval.sha256)) throw new Error('登録形式が不明です。');
  } catch (error) {
    registry = null;
    issues.push('契約の照合登録が欠落または不明です。承認状態を確定できません。');
  }
  const documents = definitions.map(definition => {
    const document = { ...definition, text: null, revision: null, declaredStatus: null, status: 'unknown', sha256: null, sections: [], issues: [] };
    try {
      const bytes = readRegistered(root, definition.path);
      document.text = bytes.toString('utf8'); document.sha256 = hash(bytes); document.sections = sectionsOf(document.text);
      document.revision = field(document.text, '共通契約リビジョン');
      document.declaredStatus = field(document.text, '状態');
    } catch (error) {
      document.status = error.code === 'ENOENT' ? 'missing' : 'unreadable';
      document.issues.push(document.status === 'missing' ? '原文がありません。' : error.message);
      return document;
    }
    const declared = document.declaredStatus?.match(/^([A-Z_]+)(?:[（(\s]|$)/)?.[1];
    if (!document.revision || !declared) {
      document.status = 'unknown'; document.issues.push('版または状態を特定できません。');
    } else if (declared === 'DRAFT' || declared === 'PROPOSED') {
      document.status = 'draft'; document.issues.push('草案・提案です。承認済みとして扱いません。');
    } else if (registry && document.revision !== registry.revision) {
      document.status = 'revision-mismatch'; document.issues.push('照合登録と原文の版が異なります。');
    } else if (declared !== 'ACTIVE') {
      document.status = 'unknown'; document.issues.push('状態が未対応です。現行契約として照合できません。');
    } else if (definition.id === 'discovery') {
      document.status = 'record';
    } else if (!registry) {
      document.status = 'unknown'; document.issues.push('承認された現行契約として照合できません。');
    } else if (registry.documents.find(row => row.id === definition.id)?.sha256 !== document.sha256) {
      document.status = 'changed'; document.issues.push('照合済みの原文から変更されています。変更内容の承認は未確認です。');
    } else document.status = 'approved';
    return document;
  });
  if (registry) {
    const source = documents.find(document => document.id === registry.approval.documentId);
    const matches = source.sections.filter(section => section.heading === registry.approval.section);
    const proof = matches.length === 1 ? matches[0] : null;
    const valid = source.status === 'record' && source.revision === registry.revision && proof?.sha256 === registry.approval.sha256;
    for (const document of documents.filter(document => document.id !== 'discovery')) {
      document.approval = { ...registry.approval, status: valid ? 'current' : 'unknown', note: registry.note || '' };
      if (document.status === 'approved' && !valid) {
        document.status = 'approval-unknown'; document.issues.push('登録された承認根拠を原文と照合できません。');
      }
    }
  }
  const revision = registry?.revision || null;
  const status = documents.filter(document => document.id !== 'discovery').every(document => document.status === 'approved') ? 'approved' : 'needs_review';
  return { revision, status, documents, issues, authority: '契約の原文と既存承認記録の照合表示です。実行権限を新たに付与しません。' };
}

export function contractContext(root, refs = [], catalog = readContracts(root)) {
  const documents = catalog.documents.map(({ id, path, title, revision, declaredStatus, status, sha256, approval, issues }) => ({ id, path, title, revision, declaredStatus, status, sha256, approval, issues }));
  const references = (Array.isArray(refs) ? refs : []).slice(0, 100).map(ref => {
    const result = { ...ref, status: 'unknown', text: null };
    if (!ref || typeof ref !== 'object' || Array.isArray(ref) || !digest(ref.sha256) || typeof ref.revision !== 'string' || typeof ref.section !== 'string') return result;
    const document = catalog.documents.find(document => document.id === ref.documentId);
    if (!document) return result;
    if (!document.text) return { ...result, status: 'missing' };
    const matching = ref.section ? document.sections.filter(section => section.heading === ref.section) : [{ text: document.text }];
    if (matching.length !== 1) return { ...result, status: 'missing' };
    const current = matching[0];
    return { ...result, status: ref.sha256 === document.sha256 && ref.revision === document.revision ? 'current' : 'stale', documentStatus: document.status, currentSha256: document.sha256, currentRevision: document.revision, text: current.text };
  });
  return { revision: catalog.revision, status: catalog.status, documents, references, issues: catalog.issues, authority: catalog.authority };
}
