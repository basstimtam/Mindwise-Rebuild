import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compare = (a, b) => String(a).localeCompare(String(b), 'en');
const sorted = values => [...values].sort(compare);
const mapOf = state => new Map((state.nodes || []).map(node => [node.id, node]));
const application = link => link.type === 'applies_to' || link.type === 'applies';
const contentFields = ['title', 'body', 'specs', 'kind', 'unit', 'value', 'formula', 'artifact', 'criteria', 'source', 'scope', 'sourceRefs'];

// Iterative DFS keeps a valid, very deep map from exhausting the JS call stack.
function walkGraph(startIds, adjacency) {
  const colors = new Map(), reached = new Set(), cycles = [], seenCycles = new Set();
  for (const start of startIds) {
    if (colors.get(start) === 2) continue;
    const stack = [{ id: start, next: 0 }], active = [];
    colors.set(start, 1); reached.add(start); active.push(start);
    while (stack.length) {
      const frame = stack.at(-1), neighbors = adjacency.get(frame.id) || [];
      if (frame.next >= neighbors.length) { colors.set(frame.id, 2); stack.pop(); active.pop(); continue; }
      const next = neighbors[frame.next++];
      reached.add(next);
      if (colors.get(next) === 1) {
        const cycle = [...active.slice(active.indexOf(next)), next];
        const signature = sorted(new Set(cycle)).join('\0');
        if (!seenCycles.has(signature)) { cycles.push(cycle); seenCycles.add(signature); }
      } else if (colors.get(next) !== 2) {
        colors.set(next, 1); stack.push({ id: next, next: 0 }); active.push(next);
      }
    }
  }
  return { reached, cycles };
}

function addEdge(adjacency, from, to) {
  if (!adjacency.has(from)) adjacency.set(from, []);
  if (!adjacency.get(from).includes(to)) adjacency.get(from).push(to);
}

/** Resolve only explicitly applicable settings. Display ancestry grants no applicability. */
export function resolveSpecifications(state, targetId) {
  const nodes = mapOf(state), links = state.links || [], incoming = new Map();
  const result = { targetId, status: 'resolved', effective: [], conflicts: [], sources: [], fingerprint: '', exceptions: [], cycles: [] };
  if (!nodes.has(targetId)) {
    result.status = 'conflict'; result.conflicts.push({ key: null, candidates: [], type: 'missing-target' });
    result.fingerprint = hash({ effective: [], conflicts: result.conflicts, cycles: [] }); return result;
  }
  for (const link of links) if (application(link)) addEdge(incoming, link.to, link.from);
  const reachable = walkGraph([targetId], incoming);
  result.cycles = reachable.cycles.map(nodeIds => ({ type: 'application', nodeIds }));
  const candidates = new Map();
  for (const id of sorted(reachable.reached)) {
    const source = nodes.get(id);
    if (!source) { result.conflicts.push({ key: null, candidates: [{ sourceId: id }], type: 'missing-source' }); continue; }
    if (source.specs?.length || source.body?.trim() || source.sourceRefs?.length) result.sources.push({ id, title: source.title || id });
    for (const spec of source.specs || []) {
      if (typeof spec.key !== 'string' || !spec.key.trim() || typeof spec.value !== 'string') {
        result.conflicts.push({ key: null, candidates: [{ sourceId: id }], type: 'invalid-specification' }); continue;
      }
      if (!candidates.has(spec.key)) candidates.set(spec.key, []);
      candidates.get(spec.key).push({ sourceId: id, value: spec.value });
    }
  }
  for (const key of sorted(candidates.keys())) {
    const rows = candidates.get(key), sourceIds = new Set(rows.map(row => row.sourceId)), precedence = new Map(), suppressed = new Set();
    let invalidPriority = false;
    for (const link of links) {
      if (link.type !== 'exception_to' || !sourceIds.has(link.from) || !sourceIds.has(link.to)) continue;
      if (typeof link.reason !== 'string' || !link.reason.trim()) {
        invalidPriority = true; result.conflicts.push({ key, candidates: rows, type: 'exception-reason-missing' }); continue;
      }
      addEdge(precedence, link.from, link.to); suppressed.add(link.to);
      result.exceptions.push({ key, from: link.from, to: link.to, reason: link.reason });
    }
    const priorityCycles = walkGraph(sourceIds, precedence).cycles;
    if (priorityCycles.length) {
      result.cycles.push(...priorityCycles.map(nodeIds => ({ type: 'exception', key, nodeIds })));
      result.conflicts.push({ key, candidates: rows, type: 'exception-cycle' }); continue;
    }
    if (invalidPriority) continue;
    const remaining = rows.filter(row => !suppressed.has(row.sourceId));
    const values = new Set(remaining.map(row => row.value));
    if (values.size !== 1) result.conflicts.push({ key, candidates: remaining, type: 'different-values' });
    else result.effective.push({ key, value: remaining[0].value, sourceIds: sorted(new Set(remaining.map(row => row.sourceId))) });
  }
  result.exceptions.sort((a, b) => compare(a.key, b.key) || compare(a.from, b.from) || compare(a.to, b.to));
  result.status = result.conflicts.length || result.cycles.length ? 'conflict' : 'resolved';
  // Overridden values, layout, timestamps and mutable model versions are not effective settings.
  result.fingerprint = hash({ effective: result.effective, conflicts: result.conflicts, exceptions: result.exceptions, cycles: result.cycles });
  return result;
}

function contentValue(node, field) {
  if (field === 'specs') return [...(node?.specs || [])].sort((a, b) => compare(a.key, b.key) || compare(a.value, b.value));
  return node?.[field] ?? null;
}

function changedSpecificationKeys(before, after) {
  const a = new Map((before?.specs || []).map(spec => [spec.key, spec.value]));
  const b = new Map((after?.specs || []).map(spec => [spec.key, spec.value]));
  return new Set([...new Set([...a.keys(), ...b.keys()])].filter(key => a.get(key) !== b.get(key)));
}

function dependencyPair(link) {
  if (link.type === 'depends_on') return [link.to, link.from];
  if (['depends', 'implements', 'realizes', 'verifies', '依存'].includes(link.type)) return [link.from, link.to];
  return null;
}

function hasFreeBody(node) {
  return typeof node?.body === 'string' && node.body.trim().length > 0;
}

// An empty intermediary can still carry prose from an explicitly applied source.
// This tracks only known applicability; display ancestry is never followed.
function proseApplications(state) {
  const reached = new Set((state.nodes || []).filter(hasFreeBody).map(node => node.id)), graph = new Map();
  for (const link of state.links || []) if (application(link)) addEdge(graph, link.from, link.to);
  const queue = [...reached];
  for (let index = 0; index < queue.length; index++) for (const next of graph.get(queue[index]) || []) {
    if (!reached.has(next)) { reached.add(next); queue.push(next); }
  }
  return reached;
}

/** A bounded explanation of recorded relationships, never a claim about undiscovered links. */
export function analyzeChange(before, after) {
  const oldNodes = mapOf(before), newNodes = mapOf(after), ids = sorted(new Set([...oldNodes.keys(), ...newNodes.keys()]));
  const fieldsById = new Map(), candidateIds = new Set(), unknownIds = new Set(), graph = new Map();
  for (const id of ids) {
    const a = oldNodes.get(id), b = newNodes.get(id);
    const fields = !a || !b ? ['existence'] : contentFields.filter(field => JSON.stringify(contentValue(a, field)) !== JSON.stringify(contentValue(b, field)));
    if (fields.length) { fieldsById.set(id, fields); candidateIds.add(id); }
  }
  for (const link of [...(before.links || []), ...(after.links || [])]) {
    if (application(link)) { if (!graph.has(link.from)) graph.set(link.from, []); graph.get(link.from).push({ to: link.to, dependency: false }); }
    const pair = dependencyPair(link);
    if (pair) { if (!graph.has(pair[0])) graph.set(pair[0], []); graph.get(pair[0]).push({ to: pair[1], dependency: true }); }
  }
  const oldLinks = new Map((before.links || []).map(link => [link.id, link])), newLinks = new Map((after.links || []).map(link => [link.id, link]));
  const linkSeeds = new Set(), unknownSeeds = new Set();
  const oldProse = proseApplications(before), newProse = proseApplications(after);
  for (const id of new Set([...oldLinks.keys(), ...newLinks.keys()])) {
    const a = oldLinks.get(id), b = newLinks.get(id);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    for (const link of [a, b].filter(Boolean)) {
      if (application(link) || link.type === 'exception_to') { linkSeeds.add(link.from); linkSeeds.add(link.to); }
      if (application(link) && (oldProse.has(link.from) || newProse.has(link.from))) unknownSeeds.add(link.to);
      const pair = dependencyPair(link); if (pair) { linkSeeds.add(pair[0]); linkSeeds.add(pair[1]); unknownSeeds.add(pair[1]); }
    }
  }
  const queue = [], seen = new Set();
  for (const [id, fields] of fieldsById) queue.push({ id, unknown: fields.some(field => !['specs', 'existence'].includes(field)) || fields.includes('existence') && (hasFreeBody(oldNodes.get(id)) || hasFreeBody(newNodes.get(id))) });
  for (const id of linkSeeds) queue.push({ id, unknown: unknownSeeds.has(id) });
  while (queue.length) {
    const { id, unknown } = queue.shift(), signature = `${id}\0${unknown}`;
    if (seen.has(signature)) continue;
    seen.add(signature); candidateIds.add(id);
    if (unknown) unknownIds.add(id);
    for (const edge of graph.get(id) || []) queue.push({ id: edge.to, unknown: unknown || edge.dependency });
  }
  const result = { changed: sorted(fieldsById.keys()), affected: [], exempt: [], unknown: [], conflicts: [], details: [] };
  for (const id of ids) {
    const target = newNodes.get(id) || oldNodes.get(id);
    let effect = 'unchanged', reasons = ['明示された影響経路なし。未記録の影響は保証しません。'], beforeSpecHash = null, afterSpecHash = null;
    if (candidateIds.has(id)) {
      const previous = resolveSpecifications(before, id), current = resolveSpecifications(after, id), fields = fieldsById.get(id) || [];
      beforeSpecHash = previous.fingerprint; afterSpecHash = current.fingerprint;
      if (current.status === 'conflict') result.conflicts.push({ targetId: id, conflicts: current.conflicts, cycles: current.cycles });
      if (fields.some(field => field !== 'specs') || beforeSpecHash !== afterSpecHash) {
        effect = 'affected'; reasons = fields.some(field => field !== 'specs') ? ['対象の内容・条件・参照が変更されます。'] : ['有効な設定または明示された適用・例外が変わります。'];
      } else if (unknownIds.has(id)) {
        effect = 'unknown'; reasons = ['関連元の本文や意味上の依存が変わります。内容への影響は再確認が必要です。'];
      } else if (current.exceptions.some(exception => fieldsById.get(exception.to)?.includes('specs') && changedSpecificationKeys(oldNodes.get(exception.to), newNodes.get(exception.to)).has(exception.key))) {
        effect = 'exempt'; reasons = ['明示した局所例外により、有効な設定は変わりません。'];
      } else reasons = ['記録済みの設定・関係では有効な内容は変わりません。未記録の影響は保証しません。'];
    }
    if (effect !== 'unchanged') result[effect].push(id);
    result.details.push({ targetId: id, title: target.title || id, domain: target.domain || '', effect, reasons, beforeSpecHash, afterSpecHash });
  }
  return result;
}

function artifactKey(node, keys) {
  const supplied = keys instanceof Map ? keys.get(node.id) : keys[node.id];
  if (typeof supplied === 'string' && supplied) return `artifact:${supplied}`;
  const ref = typeof node.artifact === 'string' ? node.artifact.trim() : '';
  return ref ? `artifact:${ref.replaceAll('\\', '/').replace(/\/\.\//g, '/').toLowerCase()}` : `node:${node.id}`;
}
const verification = (values, id) => values instanceof Map ? values.get(id) : values[id];
function progressNumbers(groups) {
  const known = groups.filter(group => group.weight !== null), knownWeight = known.reduce((sum, group) => sum + group.weight, 0);
  const verifiedWeight = known.filter(group => group.verified).reduce((sum, group) => sum + group.weight, 0);
  return { knownRate: knownWeight > 0 ? verifiedWeight / knownWeight * 100 : null, knownWeight, verifiedWeight, unknownWeightCount: groups.length - known.length, requiredCount: groups.length };
}

/** Progress of declared, estimated deliverables; never an automatic whole-project completion claim. */
export function summarizeProgress(state, verificationById = {}, artifactKeys = {}) {
  const nodes = state.nodes || [], required = nodes.filter(node => node.required === true), grouped = new Map();
  for (const node of required) {
    const key = artifactKey(node, artifactKeys);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(node);
  }
  const groups = [];
  for (const [key, aliases] of grouped) {
    const estimates = new Set(aliases.filter(node => Number.isFinite(node.weight) && node.weight > 0).map(node => node.weight));
    const weight = estimates.size === 1 ? [...estimates][0] : null;
    const statuses = aliases.map(node => verification(verificationById, node.id)?.status || 'unverified');
    const verified = statuses.every(status => status === 'verified');
    const status = estimates.size > 1 ? 'weight-conflict' : weight === null ? 'unestimated' : verified ? 'verified' : statuses.includes('conflict') ? 'conflict' : statuses.includes('missing') ? 'missing' : statuses.includes('stale') ? 'stale' : 'unverified';
    groups.push({ key, nodeIds: sorted(aliases.map(node => node.id)), title: aliases[0].title || aliases[0].id, domains: sorted(new Set(aliases.map(node => node.domain || '領域未設定'))), weight, verified, status });
  }
  groups.sort((a, b) => compare(a.key, b.key));
  const names = sorted(new Set(nodes.map(node => node.domain || '領域未設定')));
  const domains = names.map(name => ({ name, ...progressNumbers(groups.filter(group => group.domains.includes(name))) }));
  return { ...progressNumbers(groups), requiredNodeCount: required.length, groups, domains, unestimatedDomains: domains.filter(domain => domain.requiredCount === 0).map(domain => domain.name) };
}
