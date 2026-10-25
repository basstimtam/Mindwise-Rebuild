import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpecifications, analyzeChange, summarizeProgress } from '../src/semantics.mjs';

const spec = (id, value, extra = {}) => ({ id, title: id, specs: [{ key: '衣装色', value }], ...extra });
const apply = (from, to) => ({ id: `${from}-${to}`, from, to, type: 'applies_to' });
const exception = (from, to) => ({ id: `${from}-over-${to}`, from, to, type: 'exception_to', reason: 'この領域だけ演出を変える' });
function fixture() {
  return { nodes: [spec('shared', '青'), spec('local', '赤', { domain: '物語' }), { id: 'normal', title: '通常', domain: 'キャラクター' }, { id: 'unrelated', title: '無関係', domain: 'UI' }], links: [apply('shared', 'local'), apply('shared', 'normal'), exception('local', 'shared')] };
}

test('explicit application and local exception produce effective values and traceable sources', () => {
  const state = fixture(), local = resolveSpecifications(state, 'local'), normal = resolveSpecifications(state, 'normal');
  assert.equal(local.status, 'resolved'); assert.deepEqual(local.effective, [{ key: '衣装色', value: '赤', sourceIds: ['local'] }]);
  assert.equal(local.exceptions[0].reason, 'この領域だけ演出を変える'); assert.equal(normal.effective[0].value, '青');
  const displayChild = resolveSpecifications({ ...state, nodes: [...state.nodes, { id: 'display-only', parentId: 'shared' }] }, 'display-only');
  assert.equal(displayChild.effective.length, 0);
});

test('local values never win implicitly; identical values merge and explicit priority chains resolve', () => {
  const state = fixture(); state.links = state.links.filter(link => link.type !== 'exception_to');
  assert.equal(resolveSpecifications(state, 'local').status, 'conflict');
  state.nodes.find(node => node.id === 'local').specs[0].value = '青';
  assert.deepEqual(resolveSpecifications(state, 'local').effective[0].sourceIds, ['local', 'shared']);
  const chain = { nodes: [spec('low', '青'), spec('middle', '黄'), spec('high', '赤'), { id: 'work' }], links: [apply('low', 'work'), apply('middle', 'work'), apply('high', 'work'), exception('high', 'middle'), exception('middle', 'low')] };
  assert.equal(resolveSpecifications(chain, 'work').effective[0].value, '赤');
});

test('application and exception cycles, missing exception reasons, and missing targets stay unresolved', () => {
  const state = fixture(); state.links.push(apply('local', 'shared'));
  assert.equal(resolveSpecifications(state, 'local').cycles[0].type, 'application'); assert.equal(resolveSpecifications(state, 'normal').status, 'conflict');
  const cycle = fixture(); cycle.links.push(exception('shared', 'local'));
  assert.equal(resolveSpecifications(cycle, 'local').cycles[0].type, 'exception');
  const noReason = fixture(); noReason.links.find(link => link.type === 'exception_to').reason = '';
  assert.equal(resolveSpecifications(noReason, 'local').conflicts[0].type, 'exception-reason-missing');
  assert.equal(resolveSpecifications(fixture(), 'missing').status, 'conflict');
  assert.equal(resolveSpecifications(cycle, 'unrelated').status, 'resolved');
});

test('common setting changes affect the normal branch and preserve the exact local exception', () => {
  const before = fixture(), after = structuredClone(before); after.nodes[0].specs[0].value = '緑';
  assert.equal(resolveSpecifications(before, 'local').fingerprint, resolveSpecifications(after, 'local').fingerprint);
  const impact = analyzeChange(before, after);
  assert.ok(impact.affected.includes('normal')); assert.ok(impact.exempt.includes('local')); assert.ok(!impact.affected.includes('unrelated'));
  assert.equal(impact.details.find(row => row.targetId === 'unrelated').effect, 'unchanged');
});

test('unstructured source changes and semantic dependencies demand recheck instead of an invented no-effect claim', () => {
  const before = fixture(), after = structuredClone(before); after.nodes[0].body = '自由記述の重要な変更';
  const impact = analyzeChange(before, after); assert.ok(impact.unknown.includes('local')); assert.ok(impact.unknown.includes('normal'));
  const dependency = { nodes: [spec('source', '青'), { id: 'dependent' }], links: [{ id: 'd', from: 'dependent', to: 'source', type: 'depends_on' }] };
  const next = structuredClone(dependency); next.nodes[0].specs[0].value = '緑';
  assert.ok(analyzeChange(dependency, next).unknown.includes('dependent'));
});

test('layout, bookkeeping versions, verification, and row ordering do not create semantic changes', () => {
  const before = fixture(), after = structuredClone(before); after.nodes[0].x = 123; after.nodes[0].version = 8; after.nodes[0].verified = { result: 'passed' };
  assert.deepEqual(analyzeChange(before, after).changed, []); assert.deepEqual(analyzeChange(before, after).affected, []);
});

test('a removed application invalidates only the former application path', () => {
  const before = fixture(), after = structuredClone(before); after.links = after.links.filter(link => link.id !== 'shared-normal');
  const impact = analyzeChange(before, after); assert.ok(impact.affected.includes('normal')); assert.ok(!impact.affected.includes('local'));
});

test('deleting or disconnecting a body-only source preserves unknown impact on its work, not unrelated nodes', () => {
  const before = { nodes: [{ id: 'prose', body: '自由記述で示した制作上の条件' }, { id: 'work' }, { id: 'unrelated' }], links: [apply('prose', 'work')] };
  const disconnected = structuredClone(before); disconnected.links = [];
  const deleted = structuredClone(disconnected); deleted.nodes = deleted.nodes.filter(node => node.id !== 'prose');
  for (const next of [disconnected, deleted]) {
    const impact = analyzeChange(before, next);
    assert.equal(resolveSpecifications(before, 'work').fingerprint, resolveSpecifications(next, 'work').fingerprint);
    assert.ok(impact.unknown.includes('work'));
    assert.equal(impact.details.find(row => row.targetId === 'unrelated').effect, 'unchanged');
  }
  const addition = analyzeChange(disconnected, before); assert.ok(addition.unknown.includes('work'));
});

test('removing a prose source or an empty intermediary application rechecks its downstream work', () => {
  const before = { nodes: [{ id: 'prose', body: '上流の資料本文' }, { id: 'middle' }, { id: 'work' }, { id: 'unrelated' }], links: [apply('prose', 'middle'), apply('middle', 'work')] };
  const disconnected = structuredClone(before); disconnected.links = disconnected.links.filter(link => link.id !== 'middle-work');
  assert.ok(analyzeChange(before, disconnected).unknown.includes('work'));
  const deleted = structuredClone(before); deleted.nodes = deleted.nodes.filter(node => node.id !== 'prose'); deleted.links = deleted.links.filter(link => link.from !== 'prose');
  const impact = analyzeChange(before, deleted);
  assert.ok(impact.unknown.includes('middle')); assert.ok(impact.unknown.includes('work'));
  assert.equal(impact.details.find(row => row.targetId === 'unrelated').effect, 'unchanged');
  const retargeted = structuredClone(before); retargeted.links[1].to = 'unrelated';
  const moved = analyzeChange(before, retargeted); assert.ok(moved.unknown.includes('work')); assert.ok(moved.unknown.includes('unrelated'));
});

test('weighted progress counts a shared artifact once and excludes unknown or stale proof', () => {
  const state = { nodes: [
    { id: 'a', title: '共有成果', domain: '物語', required: true, weight: 3, artifact: 'work/shared.md' },
    { id: 'alias', domain: 'キャラクター', required: true, artifact: 'WORK\\shared.md' },
    { id: 'b', domain: '物語', required: true, weight: 1, artifact: 'work/next.md' },
    { id: 'unknown', domain: '戦闘', required: true, weight: null }, { id: 'idea', domain: 'UI' }
  ] };
  const proofs = { a: { status: 'verified' }, alias: { status: 'verified' }, b: { status: 'stale' } };
  const summary = summarizeProgress(state, proofs);
  assert.equal(summary.requiredCount, 3); assert.equal(summary.requiredNodeCount, 4); assert.equal(summary.knownWeight, 4);
  assert.equal(summary.verifiedWeight, 3); assert.equal(summary.knownRate, 75); assert.equal(summary.unknownWeightCount, 1);
  assert.deepEqual(summary.unestimatedDomains, ['UI']);
  proofs.alias.status = 'stale'; assert.equal(summarizeProgress(state, proofs).verifiedWeight, 0);
  state.nodes.push({ id: 'split', domain: '物語', parentId: 'a', required: false });
  assert.equal(summarizeProgress(state, proofs).requiredCount, 3);
});

test('canonical artifact aliases deduplicate, conflicting estimates remain unknown, and no denominator yields no rate', () => {
  const nodes = [{ id: 'a', required: true, weight: 1, artifact: 'relative.md' }, { id: 'b', required: true, weight: 2, artifact: 'C:/absolute.md' }];
  const summary = summarizeProgress({ nodes }, { a: { status: 'verified' }, b: { status: 'verified' } }, { a: 'same-real-file', b: 'same-real-file' });
  assert.equal(summary.groups.length, 1); assert.equal(summary.groups[0].status, 'weight-conflict'); assert.equal(summary.knownRate, null); assert.equal(summary.unknownWeightCount, 1);
  assert.equal(summarizeProgress({ nodes: [{ id: 'idea', domain: '世界' }] }).knownRate, null);
});
