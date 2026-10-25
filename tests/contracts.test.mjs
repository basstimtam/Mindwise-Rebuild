import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readContracts, contractContext } from '../src/contracts.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const revision = 'Mindwise Rebuild Rev 2';
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mindwise-contract-'));
  const files = {
    goal: '# Goal\n\n- **共通契約リビジョン**: '+revision+'\n- **状態**: ACTIVE\n\n## 1. Goal\n意味のある目標。\n\n### 細目\n<script>untrusted()</script>\n',
    design: '# Design\n\n- **共通契約リビジョン**: '+revision+'\n- **状態**: ACTIVE\n\n## 1. Design\n設計の原文。\n',
    discovery: '# Discovery\n\n- **共通契約リビジョン**: '+revision+'\n- **状態**: ACTIVE\n\n## 7. Approval\nオーナーの委譲記録。\n\n## 8. Evidence\n観測。\n'
  };
  const paths = { goal: 'GOAL.md', design: 'DESIGN_STANDARD.md', discovery: 'DISCOVERY_LOG.md' };
  for (const [id, text] of Object.entries(files)) writeFileSync(join(root, paths[id]), text);
  const approval = readContracts(root).documents.find(d => d.id === 'discovery').sections.find(s => s.heading === '7. Approval');
  const registry = { schemaVersion: 1, revision, documents: ['goal', 'design'].map(id => ({ id, sha256: sha(files[id]) })), approval: { documentId: 'discovery', section: approval.heading, sha256: approval.sha256 }, note: '既存記録の照合' };
  function saveRegistry() { writeFileSync(join(root, 'contract-registry.json'), JSON.stringify(registry)); }
  saveRegistry();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, files, paths, registry, saveRegistry, write: (id, text) => writeFileSync(join(root, paths[id]), text) };
}
const document = (root, id) => readContracts(root).documents.find(d => d.id === id);

test('contract sources return original text, revision and traceable existing approval without promoting the log to a contract', t => {
  const f = fixture(t), catalog = readContracts(f.root), goal = document(f.root, 'goal');
  assert.equal(catalog.status, 'approved'); assert.equal(goal.status, 'approved');
  assert.equal(goal.text, f.files.goal); assert.equal(goal.revision, revision);
  assert.equal(goal.sha256, sha(f.files.goal)); assert.equal(goal.approval.status, 'current');
  assert.equal(goal.approval.documentId, 'discovery');
  assert.equal(document(f.root, 'discovery').status, 'record');
  assert.match(goal.sections.find(s => s.heading === '1. Goal').text, /<script>untrusted/);
  assert.ok(!('text' in contractContext(f.root).documents[0]));
});

test('DRAFT, missing status, missing source and another revision never appear approved', t => {
  const f = fixture(t);
  f.write('goal', f.files.goal.replace('ACTIVE', 'DRAFT'));
  assert.equal(document(f.root, 'goal').status, 'draft');
  assert.equal(readContracts(f.root).status, 'needs_review');
  f.write('goal', f.files.goal.replace('- **状態**: ACTIVE\n', ''));
  assert.equal(document(f.root, 'goal').status, 'unknown');
  f.write('goal', f.files.goal.replace(revision, 'Mindwise Rebuild Rev 3'));
  assert.equal(document(f.root, 'goal').status, 'revision-mismatch');
  f.write('discovery', f.files.discovery.replace('ACTIVE', 'UNKNOWN'));
  assert.equal(document(f.root, 'design').status, 'approval-unknown');
  rmSync(join(f.root, f.paths.goal));
  assert.equal(document(f.root, 'goal').status, 'missing');
});

test('matching ACTIVE metadata is insufficient after an unapproved source or approval record change', t => {
  const f = fixture(t);
  f.write('goal', f.files.goal+'\n変更した要求。\n');
  assert.equal(document(f.root, 'goal').status, 'changed');
  f.write('goal', f.files.goal);
  f.write('discovery', f.files.discovery.replace('オーナーの委譲記録。', '承認根拠を訂正。'));
  assert.equal(document(f.root, 'goal').status, 'approval-unknown');
  assert.equal(document(f.root, 'design').status, 'approval-unknown');
});

test('append-only discovery updates keep the original approval binding valid', t => {
  const f = fixture(t);
  f.write('discovery', f.files.discovery+'\n## 9. New finding\n追加の観測。\n');
  assert.equal(readContracts(f.root).status, 'approved');
  assert.equal(document(f.root, 'goal').approval.status, 'current');
});

test('approval section identity survives Git line-ending normalization while original bytes remain visible', t => {
  const f=fixture(t),crlf=f.files.discovery.replaceAll('\n','\r\n');
  f.write('discovery',crlf);
  assert.equal(readContracts(f.root).status,'approved');
  assert.equal(document(f.root,'discovery').text,crlf);
  assert.notEqual(document(f.root,'discovery').sha256,sha(f.files.discovery));
});

test('unknown or absent registry cannot confer approval, and registry file paths cannot redirect reads', t => {
  const f = fixture(t);
  f.registry.documents[0].path = '../unregistered.md'; f.saveRegistry();
  assert.equal(document(f.root, 'goal').text, f.files.goal);
  f.registry.schemaVersion = 99; f.saveRegistry();
  assert.equal(document(f.root, 'goal').status, 'unknown');
  assert.ok(readContracts(f.root).issues.length);
  rmSync(join(f.root, 'contract-registry.json'));
  assert.equal(readContracts(f.root).status, 'needs_review');
});

test('references retain current, stale, missing and unknown distinctions and carry only the requested section', t => {
  const f = fixture(t), ref = { documentId: 'goal', section: '1. Goal', sha256: sha(f.files.goal), revision };
  let context = contractContext(f.root, [ref]);
  assert.equal(context.references[0].status, 'current');
  assert.match(context.references[0].text, /意味のある目標/);
  assert.ok(!context.references[0].text.includes('共通契約リビジョン'));
  f.write('goal', f.files.goal.replace('意味のある目標', '訂正した目標'));
  context = contractContext(f.root, [ref, { ...ref, section: '不明' }, { ...ref, documentId: '../other' }, { ...ref, sha256: 'bad' }]);
  assert.equal(context.references[0].status, 'stale');
  assert.equal(context.references[0].documentStatus, 'changed');
  assert.match(context.references[0].text, /訂正した目標/);
  assert.equal(context.references[1].status, 'missing');
  assert.equal(context.references[2].status, 'unknown');
  assert.equal(context.references[2].text, null);
  assert.equal(context.references[3].status, 'unknown');
});

test('duplicate headings or metadata are ambiguous and fenced Markdown headings cannot masquerade as source sections', t => {
  const f = fixture(t), ref = { documentId: 'goal', section: '1. Goal', sha256: sha(f.files.goal), revision };
  f.write('goal', f.files.goal+'\n```md\n## Pretend\n```\n\n## 1. Goal\n別の節。\n');
  assert.ok(!document(f.root, 'goal').sections.some(s => s.heading === 'Pretend'));
  assert.equal(contractContext(f.root, [ref]).references[0].status, 'missing');
  f.write('goal', f.files.goal+'\n- **状態**: ACTIVE\n');
  assert.equal(document(f.root, 'goal').status, 'unknown');
});

test('contract source link substitution is rejected before foreign source content is read', t => {
  const f = fixture(t), foreign = join(f.root, 'foreign.txt');
  writeFileSync(foreign, 'foreign source content'); rmSync(join(f.root, f.paths.goal));
  try { symlinkSync(foreign, join(f.root, f.paths.goal), 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Windows account cannot create file symlinks'); throw error; }
  const goal = document(f.root, 'goal');
  assert.equal(goal.status, 'unreadable'); assert.equal(goal.text, null); assert.equal(goal.sha256, null);
});

test('oversized registered sources are explicit unreadable entries, not silent omission', t => {
  const f = fixture(t);
  f.write('goal', 'x'.repeat(2*1024*1024+1));
  assert.equal(document(f.root, 'goal').status, 'unreadable');
  assert.equal(readContracts(f.root).documents.length, 3);
});
