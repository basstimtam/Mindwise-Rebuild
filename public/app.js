const $ = (q, parent = document) => parent.querySelector(q);
const $$ = (q, parent = document) => [...parent.querySelectorAll(q)];
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const svgEl = (tag, attrs = {}, text) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text !== undefined) e.textContent = text; return e; };
const statuses = { planned: '未着手', active: '制作中', blocked: '再確認待ち', done: '作業完了' };
const relations = { depends_on: '依存する', relates_to: '関連する', precedes: '工程の前にある', applies_to: '仕様を適用する', exception_to: 'この仕様で相手の設定を置き換える', realizes: '実現する', verifies: '検証する' };
const views = { map: ['全体を考える', '枝を動かして整理。関係は意味を分けてつなげます。'], hierarchy: ['構想を具体化する', '表示の親子です。移動だけで仕様の適用範囲は変わりません。'], lanes: ['領域と、具体化の深さ', '横軸は時間ではありません。必要な深さへ自由に展開します。'], process: ['仕事のつながり', '明示した工程関係を表示します。地図の配置とは独立しています。'], tasks: ['いま取り組むこと', '作業状態と成果物の確認結果を分けて扱います。'], gantt: ['予定を見渡す', '日付のある対象を並べます。日付未定も残します。'], numbers: ['数値と根拠', '同じ対象の値・単位・式を扱います。未計算を確定値にしません。'] };
let state = { revision: 0, nodes: [], links: [], runs: [], history: [] }, token = '', selected = localStorage.getItem('mindwise.selected'), view = localStorage.getItem('mindwise.view') || 'map', domain = '', query = '', activePanel = 'detail', busy = false;
let camera = { x: 20, y: 30, scale: 1 }, toastTimer, aiEvents = [], aiRun = null, aiThreads = {}, aiRequestPending = false, polling = false;
const freshConversationTargets = new Set();
const detailDrafts = new Map(), relationDrafts = new Map();
let analysis = null, analysisTarget = null, analysisSequence = 0, analysisFetch = null, analysisAt = 0, analysisError = '', reviewedArtifact = null, verificationPending = false;
function currentAnalysis() { return analysis?.revision === state.revision && analysisTarget === (selected || '') ? analysis : null; }
function verificationText(id) { return ({verified:'現物確認済み',stale:'変更後の再確認が必要',missing:'成果物が見つかりません',conflict:'仕様の衝突を解決してください',unverified:'受入は未確認'})[currentAnalysis()?.verificationById?.[id]?.status] || '現物との照合待ち'; }
async function refreshAnalysis() {
 const targetId = selected || '', revision = state.revision, key = `${targetId}@${revision}`;
 if (analysisFetch?.key === key) return analysisFetch.promise;
 const sequence = ++analysisSequence;
 const promise = (async () => {
  try {
   const result = await api(`/api/analysis${targetId ? '?targetId=' + encodeURIComponent(targetId) : ''}`);
   if (sequence !== analysisSequence || targetId !== (selected || '') || revision !== state.revision || result.revision !== state.revision) return;
   analysis = result; analysisTarget = targetId; analysisAt = Date.now(); analysisError = '';
   renderSpecification(); renderVerification(); renderProgress(); renderAiTarget(); updateVerificationLabels();
  } catch (error) {
   if (sequence !== analysisSequence) return;
   analysisError = error.message; analysis = null;
   renderSpecification(); renderVerification(); renderProgress(); renderAiTarget(); updateVerificationLabels();
  } finally { if (analysisFetch?.sequence === sequence) analysisFetch = null; }
 })();
 analysisFetch = {key,sequence,promise};
 return promise;
}
function toast(message, error = false) { const t = $('#toast'); t.textContent = message; t.classList.toggle('error', error); t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, error ? 7000 : 3200); }
async function api(path, data, method) { const r = await fetch(path, { method: method || (data === undefined ? 'GET' : 'POST'), headers: { 'Content-Type': 'application/json', 'X-Mindwise-Token': token }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) }); const result = await r.json().catch(() => ({})); if (!r.ok) { if (r.status === 409) { state = await api('/api/state'); render(); } throw new Error(result.error?.message || result.error || result.message || `処理できませんでした (${r.status})`); } return result; }
function node(id = selected) { return state.nodes.find(n => n.id === id); }
function nodes() { return state.nodes.filter(n => (!domain || n.domain === domain) && (!query || `${n.title} ${n.body || ''}`.toLowerCase().includes(query.toLowerCase()))); }
function title(id) { return node(id)?.title || '対象がありません'; }
async function change(ops) {
 if (busy) return false;
 busy = true; let saved = false, cancelled = false;
 $('#saveState').textContent = '○ 変更を確認中';
 try {
  const payload = {baseRevision:state.revision,operationId:crypto.randomUUID(),ops};
  const substantive = ops.some(op => op.type === 'link' || op.type === 'unlink' || op.type === 'delete' || op.type === 'update' && Object.keys(op.patch).some(key => !['x','y','parentId','depth','domain','start','due','status','progress'].includes(key)));
  if (substantive) {
   const preview = await api('/api/preview', payload);
   const edited = new Set(ops.flatMap(op => op.id ? [op.id] : op.link ? [op.link.from] : []));
   const impact = preview.impact || {};
   const meaningful = (impact.details || []).filter(row => row.effect !== 'unchanged' && !edited.has(row.targetId));
   if ((meaningful.length || impact.conflicts?.length) && !await confirmImpact(impact, edited)) { cancelled = true; return false; }
  }
  $('#saveState').textContent = '○ 保存中';
  state = await api('/api/change', payload);
  if (!node()) selected = state.nodes[0]?.id || null;
  render(); await refreshAnalysis(); saved = true; return true;
 } catch (error) { toast(error.message, true); return false; }
 finally { busy = false; $('#saveState').textContent = saved ? '● 保存済み' : cancelled ? '○ 変更は未保存' : '○ 保存できませんでした'; }
}
function confirmImpact(impact, edited) {
 const dialog = $('#impactDialog'), list = $('#impactList'); list.replaceChildren();
 const labels = {affected:'設定が変わる対象',exempt:'例外を保つ対象',unknown:'影響の再確認が必要',unchanged:'設定は変わりません'};
 const rows = (impact.details || []).filter(row => row.effect !== 'unchanged');
 for (const row of rows.slice(0,100)) {
  const item = el('div', `impact-item ${row.effect}`);
  item.append(el('strong','',`${row.title || title(row.targetId)}${edited.has(row.targetId) ? '（直接の変更）' : ''}`),el('small','',labels[row.effect] || row.effect));
  if (row.reasons?.length) item.append(el('p','',row.reasons.join(' / ')));
  list.append(item);
 }
 if (rows.length > 100) list.append(el('p','small-note',`ほか ${rows.length - 100} 件。保存後に対象ごとの設定を確認できます。`));
 if (impact.conflicts?.length) list.prepend(el('p','conflict-note',`仕様の未解決が ${impact.conflicts.length} 件あります。変更を保存しても、該当対象の制作は解決まで保留されます。`));
 if (!rows.length) list.append(el('p','small-note','判明している明示関係の範囲を確認しました。未知の関係の影響は断定しません。'));
 return new Promise(resolve => {
  let choice = false;
  $('#impactContinue').onclick = () => {choice = true;dialog.close();};
  $('#impactCancel').onclick = () => dialog.close();
  dialog.onclose = () => {dialog.onclose = null;resolve(choice);};
  dialog.showModal();
 });
}
function choose(id) { selected = id; localStorage.setItem('mindwise.selected', id || ''); render(); }
function button(text, fn, cls = '') { const b = el('button', cls, text); b.type = 'button'; b.addEventListener('click', fn); return b; }
function badge(n) { return el('span', `badge ${n.status || 'planned'}`, statuses[n.status] || n.status || '未着手'); }
function field(label, name, value, type = 'text', options) { const l = el('label', 'field'); l.append(el('span', '', label)); const i = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input'); i.name = name; if (options) { for (const [v, text] of options) { const o = el('option', '', text); o.value = v; i.append(o); } } else if (type !== 'textarea') i.type = type; i.value = value ?? ''; l.append(i); return l; }
function empty(message, detail, action) { const e = el('div', 'empty'); e.append(el('div', 'empty-icon', '◇'), el('strong', '', message), el('p', '', detail)); if (action) e.append(action); return e; }
function render() { if (!views[view]) view = 'map'; renderDomains(); renderView(); renderInspector(); renderProgress(); renderAiTarget(); renderSpecification(); renderVerification(); if (!currentAnalysis()) void refreshAnalysis(); $$('.tabs button').forEach(b => { b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-selected', String(b.dataset.view === view)); }); $('#scopeLabel').textContent = domain || '全領域'; $('#viewLabel').textContent = views[view][0]; $('#viewHint').textContent = views[view][1]; $('#mapControls').hidden = view !== 'map'; $('#modelSummary').textContent = `表示 ${nodes().length} 対象 / 全 ${state.nodes.length} 対象 · 保存版 ${state.revision}`; $('#undo').disabled = !state.history?.length; }
function renderDomains() { const d = $('#domains'); d.replaceChildren(); for (const name of [...new Set(state.nodes.map(n => n.domain).filter(Boolean))]) { const b = button('', () => { domain = domain === name ? '' : name; render(); }, 'nav-item'); b.classList.toggle('active', domain === name); b.append(el('span', 'domain-dot'), el('span', '', name), el('span', 'count', String(state.nodes.filter(n => n.domain === name).length))); d.append(b); } $('#allDomains').classList.toggle('active', !domain); const result = $('#searchResults'); result.replaceChildren(); if (query) { const matched = nodes(); result.append(el('div', 'search-caption', `${matched.length} 件`)); for (const n of matched.slice(0, 12)) result.append(button(n.title, () => choose(n.id))); } }
function renderView() { const v = $('#view'); v.replaceChildren(); v.className = view; if (!state.nodes.length) { v.append(empty('最初の枝から、地図がはじまる。', '作りたいものを置いて、領域や仕様へ広げましょう。制作した結果も同じ地図に戻ります。', button('＋ 最初の枝をつくる', () => addNode(false), 'primary'))); v.firstChild.append(button('ゲームのサンプルで試す', createSample, 'text-button')); return; } if (!nodes().length) { v.append(empty('この範囲に対象はありません', '領域や検索条件を変えると、ほかの枝へ戻れます。', button('全体へ戻る', () => { domain = ''; query = ''; $('#search').value = ''; render(); }))); return; } if (view === 'map') drawMap(); else if (view === 'hierarchy') drawHierarchy(); else if (view === 'lanes') drawLanes(); else if (view === 'tasks') drawTasks(); else if (view === 'process') drawProcess(); else if (view === 'gantt') drawGantt(); else drawNumbers(); }
function position(n, i = state.nodes.indexOf(n)) { return { x: Number.isFinite(n.x) ? n.x : 70 + (Number(n.depth) || 0) * 240, y: Number.isFinite(n.y) ? n.y : 60 + i * 100 }; }
function drawMap() { const host = $('#view'), svg = svgEl('svg', { role: 'img', 'aria-label': '枝をドラッグして整理できる地図' }), layer = svgEl('g'); svg.append(layer); host.append(svg); const visible = nodes(), ids = new Set(visible.map(n => n.id)); const transforms = () => { layer.setAttribute('transform', `translate(${camera.x} ${camera.y}) scale(${camera.scale})`); $('#zoomLabel').textContent = `${Math.round(camera.scale * 100)}%`; };
 const draw = () => { layer.replaceChildren(); for (const n of visible) if (n.parentId && ids.has(n.parentId)) edge(node(n.parentId), n, false); for (const l of state.links || []) if (ids.has(l.from) && ids.has(l.to)) edge(node(l.from), node(l.to), true); for (const n of visible) { const p = position(n), g = svgEl('g', { class: `map-node ${selected === n.id ? 'selected' : ''} ${!n.parentId ? 'root' : ''}`, transform: `translate(${p.x} ${p.y})`, 'data-id': n.id, tabindex: '0', role: 'button', 'aria-label': n.title }); g.append(svgEl('rect', { class: 'node-box', width: 195, height: 74, rx: 10 })); g.append(svgEl('text', { class: 'node-title', x: 15, y: 28 }, n.title.length > 15 ? n.title.slice(0, 15) + '…' : n.title)); g.append(svgEl('text', { class: 'node-subtitle', x: 15, y: 49 }, `${n.domain || '領域未設定'} · 深さ ${n.depth ?? 0}`)); g.append(svgEl('circle', { cx: 16, cy: 63, r: 2, fill: n.status === 'done' ? '#69a992' : n.status === 'active' ? '#6e9fdc' : '#b0bcbf' })); g.append(svgEl('text', { class: 'node-status', x: 24, y: 66 }, statuses[n.status] || '未着手')); layer.append(g); g.addEventListener('pointerdown', e => beginNodeDrag(e, n, g)); g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(n.id); } }); } transforms(); };
 function edge(a, b, semantic) { if (!a || !b) return; const pa = position(a), pb = position(b), x1 = pa.x + 195, y1 = pa.y + 37, x2 = pb.x, y2 = pb.y + 37; layer.append(svgEl('path', { class: `map-edge${semantic ? ' semantic' : ''}`, d: `M${x1},${y1} C${x1 + 65},${y1} ${x2 - 65},${y2} ${x2},${y2}` })); }
 function beginNodeDrag(e, n, g) { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); const start = { x: e.clientX, y: e.clientY, ...position(n) }, oldX = n.x, oldY = n.y; let moved = false; g.setPointerCapture(e.pointerId); g.style.cursor = 'grabbing'; const move = evt => { const dx = (evt.clientX - e.clientX) / camera.scale, dy = (evt.clientY - e.clientY) / camera.scale; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true; n.x = start.x + dx; n.y = start.y + dy; g.setAttribute('transform', `translate(${n.x} ${n.y})`); }; const up = async () => { g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); g.removeEventListener('pointercancel', cancel); g.style.cursor = ''; selected = n.id; localStorage.setItem('mindwise.selected', selected); if (moved) { const x = n.x, y = n.y; n.x = oldX; n.y = oldY; await change([{ type: 'update', id: n.id, patch: { x, y } }]); } else render(); }; const cancel = () => { n.x = oldX; n.y = oldY; g.removeEventListener('pointermove', move); g.removeEventListener('pointerup', up); renderView(); }; g.addEventListener('pointermove', move); g.addEventListener('pointerup', up); g.addEventListener('pointercancel', cancel); }
 svg.addEventListener('pointerdown', e => { if (e.target.closest('.map-node') || e.button !== 0) return; const x = e.clientX, y = e.clientY, origin = { ...camera }; svg.setPointerCapture(e.pointerId); const move = ev => { camera.x = origin.x + ev.clientX - x; camera.y = origin.y + ev.clientY - y; transforms(); }; const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); }; svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up); });
 svg.addEventListener('wheel', e => { e.preventDefault(); const rect = svg.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top, old = camera.scale; camera.scale = Math.min(2.5, Math.max(.25, old * (e.deltaY < 0 ? 1.08 : .92))); camera.x = px - (px - camera.x) * camera.scale / old; camera.y = py - (py - camera.y) * camera.scale / old; transforms(); }, { passive: false }); draw(); }
function content(titleText, note) { const wrap = el('div', 'view-content'); wrap.append(el('h2', 'view-heading', titleText), el('p', 'view-note', note)); $('#view').append(wrap); return wrap; }
function nodeCard(n) { const b = button('', () => choose(n.id), `node-card ${selected === n.id ? 'selected' : ''}`), description = el('small', '', `${n.domain || '領域未設定'} · ${statuses[n.status] || '未着手'}`); if(n.artifact) { const proof = el('span', '', ' · ' + verificationText(n.id)); proof.dataset.verificationId = n.id; description.append(proof); } b.append(el('strong', '', n.title), description); return b; }
function updateVerificationLabels() { for(const label of $$('[data-verification-id]')) label.textContent = ' · ' + verificationText(label.dataset.verificationId); }
function drawHierarchy() { const wrap = content('全体から、個別の仕事へ', '切り離した枝も、この一覧から探してつなぎ直せます。'), visible = nodes(), ids = new Set(visible.map(n => n.id)), visited = new Set(); function walk(n, depth) { if (visited.has(n.id)) return; visited.add(n.id); const r = el('div', `hierarchy-row ${n.id === selected ? 'selected' : ''}`); r.style.paddingLeft = `${18 + depth * 22}px`; r.append(el('span', '', depth ? '└' : '◇'), el('strong', '', n.title), el('small', '', n.domain || '領域未設定'), badge(n)); r.addEventListener('click', () => choose(n.id)); wrap.append(r); visible.filter(c => c.parentId === n.id).forEach(c => walk(c, depth + 1)); } visible.filter(n => !n.parentId || !ids.has(n.parentId)).forEach(n => walk(n, 0)); visible.filter(n => !visited.has(n.id)).forEach(n => walk(n, 0)); }
function drawLanes() { const wrap = content('完成に必要な領域を、並べる', '具体化の深さは自由です。空欄は未探索・未具体化を表し、完成済みには数えません。'), ns = nodes(), domains = [...new Set(ns.map(n => n.domain || '領域未設定'))], depths = [...new Set(ns.map(n => Number(n.depth) || 0))].sort((a,b) => a-b), grid = el('div', 'lanes'); grid.style.gridTemplateColumns = `130px repeat(${depths.length}, minmax(180px, 1fr))`; grid.append(el('div', 'lane-cell header', '領域 / 具体化')); depths.forEach(d => grid.append(el('div', 'lane-cell header', `深さ ${d}`))); for (const domainName of domains) { grid.append(el('div', 'lane-cell domain', domainName)); for (const depth of depths) { const cell = el('div', 'lane-cell'), matched = ns.filter(n => (n.domain || '領域未設定') === domainName && (Number(n.depth) || 0) === depth); matched.forEach(n => cell.append(nodeCard(n))); if (!matched.length) cell.append(el('span', 'lane-empty', '未具体化')); grid.append(cell); } } wrap.append(grid); }
function drawTasks() { const wrap = content('作業の状態と、成果の確認を分ける', '「作業完了」でも、受入条件と現物の確認が済むまでは確認済み成果にはなりません。'), board = el('div', 'board'); for (const [status, label] of Object.entries(statuses)) { const col = el('div', 'board-column'), list = nodes().filter(n => (n.status || 'planned') === status), h = el('h3', '', label); h.append(el('span', '', String(list.length))); col.append(h); list.forEach(n => col.append(nodeCard(n))); board.append(col); } wrap.append(board); }
function drawProcess() { const wrap = content('工程の前後と、意味のある依存', '工程関係を明示してつなぎます。並びや親子だけから順序を推定しません。'), visible = new Set(nodes().map(n => n.id)), links = state.links.filter(l => ['precedes', 'depends_on'].includes(l.type) && visible.has(l.from) && visible.has(l.to)); if (!links.length) wrap.append(el('div', 'no-process', '工程関係はまだありません。枝の詳細から「工程の前にある」または「依存する」をつなげてください。')); const connected = new Set(); for (const l of links) { connected.add(l.from); connected.add(l.to); const row = el('div', 'process-chain'); row.append(nodeCard(node(l.from)), el('span', 'process-arrow', l.type === 'precedes' ? '→' : '⇢'), nodeCard(node(l.to)), el('span', 'muted', relations[l.type])); wrap.append(row); } const free = nodes().filter(n => !connected.has(n.id)); if (free.length) { wrap.append(el('h3', 'section-title', '工程未設定の対象')); const row = el('div', 'process-chain'); free.forEach(n => row.append(nodeCard(n))); wrap.append(row); } }
function drawGantt() { const wrap = content('日付を持つ仕事の見通し', '予定と確認済み成果は別です。バーを選ぶと、同じ対象の詳細へ戻れます。'), ns = nodes(), dates = ns.flatMap(n => [n.start, n.due]).filter(Boolean).map(d => Date.parse(d)).filter(Number.isFinite), min = dates.length ? Math.min(...dates) : Date.now(), max = dates.length ? Math.max(...dates) : min + 7 * 864e5, span = Math.max(max - min, 864e5), header = el('div', 'gantt-header'); header.append(el('span', '', new Date(min).toLocaleDateString('ja-JP')), el('span', '', new Date(min + span).toLocaleDateString('ja-JP'))); wrap.append(header); ns.forEach(n => { const row = el('div', `gantt-row ${n.id === selected ? 'selected' : ''}`), track = el('div', 'gantt-track'); row.append(el('div', '', n.title), track); const start = Date.parse(n.start), due = Date.parse(n.due); if (Number.isFinite(start) && Number.isFinite(due)) { const bar = el('div', 'gantt-bar'); bar.style.left = `${Math.max(0, (start - min) / span * 94)}%`; bar.style.width = `${Math.max(1, (due - start) / span * 94)}%`; bar.title = `${n.start} → ${n.due}`; track.append(bar); } else track.append(el('div', 'gantt-undated', n.due ? `期限 ${n.due} / 開始未定` : n.start ? `開始 ${n.start} / 期限未定` : '日程未定')); row.addEventListener('click', () => choose(n.id)); wrap.append(row); }); }
function drawNumbers() { const wrap = content('値・単位・式を、対象につなぐ', '空欄は未定義です。計算結果が提供されていない式は「未計算」と表示します。'), table = el('table', 'data-table'), head = el('thead'), hr = el('tr'); ['対象', '入力値', '単位', '式', '計算結果 / 鮮度'].forEach(t => hr.append(el('th', '', t))); head.append(hr); table.append(head); const body = el('tbody'); nodes().forEach(n => { const row = el('tr', n.id === selected ? 'selected' : ''); for (const value of [n.title, n.value ?? '未定義', n.unit || '—', n.formula || '—', n.formula ? (n.computedValue ?? '未計算') : '入力値']) row.append(el('td', '', String(value))); row.addEventListener('click', () => choose(n.id)); body.append(row); }); table.append(body); wrap.append(table); }
function checkField(label, name, checked) {
 const holder = el('label','check-field'), input = el('input'); input.type = 'checkbox'; input.name = name; input.checked = Boolean(checked); holder.append(input,el('span','',label)); return holder;
}
function formValues(form) { const values = Object.fromEntries(new FormData(form)); const required = $('[name="required"]', form); if (required) values.required = required.checked; return values; }
function parseSpecs(text) {
 const specs = [], keys = new Set();
 for (const [index,line] of text.split(/\r?\n/).entries()) {
  if (!line.trim()) continue;
  const equals = line.indexOf('=');
  if (equals < 1 || !line.slice(equals+1).trim()) throw new Error(`設定の ${index+1} 行目は「項目 = 値」で入力してください。`);
  const key = line.slice(0,equals).trim(), value = line.slice(equals+1).trim();
  if (keys.has(key)) throw new Error(`「${key}」が重複しています。同じ枝では一つの値にしてください。`);
  keys.add(key);specs.push({key,value});
 }
 return specs;
}
function renderInspector() {
 const box = $('#inspector'); box.replaceChildren(); const n = node();
 if (!n) { box.append(empty('対象を選ぶ','地図や一覧から枝を選ぶと、同じ対象の仕様・成果物・関係を編集できます。'));return; }
 const kicker = el('div','detail-kicker');kicker.append(el('span','',n.domain || '領域未設定'),el('span','',`版 ${n.version ?? '—'}`));box.append(kicker,el('h2','detail-title',n.title),badge(n));
 const form = el('form');form.id = 'detailForm';
 form.append(field('タイトル','title',n.title),field('構想・仕様・判断の内容','body',n.body,'textarea'));
 const row1 = el('div','field-row');row1.append(field('領域','domain',n.domain),field('具体化の深さ','depth',n.depth ?? 0,'number'));form.append(row1);
 const row2 = el('div','field-row');row2.append(field('作業状態','status',n.status || 'planned','select',Object.entries(statuses)),field('用途','kind',n.kind || 'concept','select',[['concept','構想・仕様'],['task','タスク'],['artifact','成果物'],['metric','数値']]));form.append(row2);
 form.append(field('表示上の親（仕様の適用とは別）','parentId',n.parentId || '','select',[['','切り離す / 独立した枝'],...state.nodes.filter(x=>x.id!==n.id).map(x=>[x.id,x.title])]));
 const row3 = el('div','field-row');row3.append(field('開始予定','start',n.start,'date'),field('期限','due',n.due,'date'));form.append(row3,field('計画進捗 %（成果確認とは別）','progress',n.progress,'number'));
 form.append(el('div','section-title','この枝が持つ設定'),field('1行に「項目 = 値」','specsText',(n.specs || []).map(spec=>`${spec.key} = ${spec.value}`).join('\n'),'textarea'),el('p','small-note','例：主人公 = ユイ。共有設定は「仕様を適用する」でつなぎます。局所設定も自動で優先せず、異なる値は明示した例外で解決します。'));
 form.append(el('div','section-title','成果物と確認条件'),field('成果物の参照先','artifact',n.artifact),field('受入条件','criteria',n.criteria,'textarea'),checkField('完成に必要な成果として数える','required',n.required),field('成果の重み（未定なら空欄）','weight',n.weight,'number'),el('p','small-note','重みは相対的な大きさです。未定は未見積りとして残し、計画進捗 % とは分けます。'));
 const weightInput = $('[name="weight"]',form);weightInput.min = '0.000001';weightInput.step = 'any';
 form.append(el('div','section-title','数値・式'));
 const row4 = el('div','field-row');row4.append(field('入力値','value',n.value,'number'),field('単位','unit',n.unit));form.append(row4,field('式','formula',n.formula));
 const save = el('button','primary','変更を保存');save.type = 'submit';const actions = el('div','button-row');actions.append(save,button('子の枝を追加',()=>addNode(true)));form.append(actions);
 form.addEventListener('submit',async event=>{
  event.preventDefault();
  if(node(n.id)?.version !== (detailDrafts.get(n.id)?.baseVersion ?? n.version))return toast('別の変更があります。入力は保持しています。必要なら入力を控えてから「入力を取り消して最新へ」で最新内容を確認してください。',true);
  const data = formValues(form), patch = {};
  try {
   for(const [rawKey,raw] of Object.entries(data)) {
    let key = rawKey, value = raw;
    if(key === 'specsText'){key = 'specs';value = parseSpecs(raw);}
    if(['depth','progress','value','weight'].includes(key))value = raw === '' ? null : Number(raw);
    if(key === 'weight' && value !== null && (!Number.isFinite(value) || value <= 0))throw new Error('重みは正の数、または未定の空欄にしてください。');
    if(key === 'parentId')value = raw || null;
    if(key === 'title' && !raw.trim())throw new Error('タイトルを入力してください');
    const fallback = key === 'specs' ? [] : key === 'required' ? false : ['parentId','progress','value','weight'].includes(key) ? null : '';
    if(JSON.stringify(value) !== JSON.stringify(n[key] ?? fallback))patch[key] = value;
   }
  } catch(error){toast(error.message,true);return;}
  const draft = detailDrafts.get(n.id);
  if(!Object.keys(patch).length){detailDrafts.delete(n.id);renderInspector();return;}
  // Retain draft during preview and confirmation so background refresh cannot lose input.
  if(await change([{type:'update',id:n.id,patch}])) {detailDrafts.delete(n.id);if(selected===n.id)renderInspector();toast('同じ対象のすべての表示へ反映しました');}
  else if(draft){detailDrafts.set(n.id,draft);if(selected===n.id)renderInspector();}
 });
 const draft = detailDrafts.get(n.id);
 if(draft){for(const input of $$('[name]',form))if(input.name in draft.values){if(input.type==='checkbox')input.checked = Boolean(draft.values[input.name]);else input.value = draft.values[input.name];}box.append(el('p','small-note',draft.baseVersion===n.version?'未保存の入力を保持しています。':'別の更新があります。未保存の入力は保持しています。保存前に最新内容を確認してください。'));}
 form.addEventListener('input',()=>detailDrafts.set(n.id,{baseVersion:detailDrafts.get(n.id)?.baseVersion ?? n.version,values:formValues(form)}));
 box.append(form);
 const specificationBox = el('section','analysis-section');specificationBox.id = 'specificationDetails';box.append(specificationBox);
 const verificationBox = el('section','analysis-section');verificationBox.id = 'verificationDetails';box.append(verificationBox);
 const actions2 = el('div','button-row');actions2.append(button('入力を取り消して最新へ',()=>{if(!detailDrafts.has(n.id)||confirm('未保存の入力を取り消し、最新の保存内容を表示しますか？')){detailDrafts.delete(n.id);renderInspector();renderSpecification();renderVerification();}}),button('切り離す',()=>change([{type:'update',id:n.id,patch:{parentId:null}}])),button('枝を削除',async()=>{if(confirm(`「${n.title}」を削除します。モデルの変更は取り消せます。`))await change([{type:'delete',id:n.id}]);},'danger'));box.append(actions2);renderRelations(box,n);renderSpecification();renderVerification();
}
function renderSpecification() {
 const box = $('#specificationDetails');if(!box)return;box.replaceChildren(el('div','section-title','この対象で有効な設定'));
 const current = currentAnalysis(), specification = current?.specification;
 if(!current){box.append(el('p','small-note',analysisError ? `設定を照合できません：${analysisError}` : '設定と出所を照合中です。'));return;}
 if(!specification){box.append(el('p','small-note','対象を選ぶと、有効な設定を確認できます。'));return;}
 if(specification.status === 'conflict')box.append(el('p','conflict-note','設定が未解決です。この対象の制作は、衝突や循環を解決してから開始できます。'));
 for(const conflict of specification.conflicts || []) {
  const item = el('div','spec-conflict');item.append(el('strong','',conflict.key || '未解決の設定'));
  for(const candidate of conflict.candidates || [])item.append(el('p','',`${title(candidate.sourceId)}：${candidate.value}`));box.append(item);
 }
 if(specification.cycles?.length)box.append(el('p','conflict-note','仕様の適用・例外関係に循環があります。関係を確認してください。'));
 if(!specification.effective?.length && specification.status !== 'conflict')box.append(el('p','small-note','明示された設定はありません。本文に書いた構想は設定の優先順位として自動解釈しません。'));
 for(const spec of specification.effective || []) {
  const item = el('div','effective-spec');item.append(el('strong','',`${spec.key} = ${spec.value}`));
  const sources = el('div','spec-sources');for(const id of spec.sourceIds || [])sources.append(button(title(id),()=>choose(id),'source-button'));item.append(sources);box.append(item);
 }
 if(specification.exceptions?.length)box.append(el('p','small-note',`明示した例外 ${specification.exceptions.length} 件を適用しています。相手の設定を一括で上書きしません。`));
}
function renderVerification() {
 const box = $('#verificationDetails'), n = node();if(!box||!n)return;box.replaceChildren(el('div','section-title','現物の受入確認'),el('p','verification-state',verificationText(n.id)));
 if(n.artifact){box.append(button('成果物と受入条件を確認',()=>openNodeArtifact(n.id),'artifact-button'));if(detailDrafts.has(n.id))box.append(el('p','small-note','保存済みの参照先と受入条件を確認します。未保存の入力は含みません。'));}
 else box.append(el('p','small-note','成果物の参照先を保存すると、現物と受入条件を並べて確認できます。'));
}
function renderRelations(box,n) {
 box.append(el('div','section-title','明示した関係'));
 const links = state.links.filter(link=>link.from===n.id||link.to===n.id);
 if(!links.length)box.append(el('p','small-note','関係はまだありません。位置や親子から依存を推定しません。'));
 for(const link of links){const row = el('div','relation'),other = link.from===n.id?link.to:link.from, description = el('span','',`${link.from===n.id?'→':'←'} ${relations[link.type]||link.type}：${title(other)}`);if(link.reason)description.append(el('small','',`理由：${link.reason}`));row.append(description,button('開く',()=>choose(other)),button('解除',()=>change([{type:'unlink',id:link.id}])));box.append(row);}
 const form = el('form'), target = field('つなぐ対象','to','','select',[['','対象を選択'],...state.nodes.filter(x=>x.id!==n.id).map(x=>[x.id,x.title])]), type = field('関係の意味','type','relates_to','select',Object.entries(relations)), reason = field('この設定を優先する理由','reason','','textarea');
 const typeInput = $('[name="type"]',type), reasonInput = $('[name="reason"]',reason), note = el('p','small-note','両方が適用される項目について、この枝の設定で相手の設定を置き換えます。局所設定を優先したい枝から、共通設定の枝へつなぎます。');
 const updateType = ()=>{const exception = typeInput.value==='exception_to';reason.hidden = !exception;note.hidden = !exception;reasonInput.required = exception;};
 const submit = el('button','','関係をつなぐ');submit.type = 'submit';form.append(target,type,note,reason,submit);
 const draft = relationDrafts.get(n.id);if(draft)for(const input of $$('[name]',form))input.value = draft[input.name] || '';
 typeInput.addEventListener('change',updateType);updateType();
 const remember = ()=>relationDrafts.set(n.id,Object.fromEntries(new FormData(form)));form.addEventListener('input',remember);form.addEventListener('change',remember);
 form.addEventListener('submit',async event=>{event.preventDefault();const data = Object.fromEntries(new FormData(form));if(!data.to)return;if(data.type==='exception_to'&&!data.reason.trim())return toast('この設定を優先する理由を入力してください。',true);const link = {id:crypto.randomUUID(),from:n.id,to:data.to,type:data.type,...(data.type==='exception_to'?{reason:data.reason.trim()}: {})};if(await change([{type:'link',link}])){relationDrafts.delete(n.id);if(selected===n.id)renderInspector();}});
 box.append(form);
}
function rateText(value) { return typeof value==='number'&&Number.isFinite(value) ? `${Math.round(value*10)/10}%` : '未見積り'; }
function renderProgress() {
 const current = currentAnalysis(), progress = current?.progress;
 $('#progressSummary').textContent = progress ? `見積り済み範囲 ${rateText(progress.knownRate)} · 確認済み重み ${progress.verifiedWeight ?? 0} / ${progress.knownWeight ?? 0}` : analysisError ? '成果の照合が必要です' : '成果と現物を照合中';
 $('#progressDetail').textContent = progress ? `全体完成は未判定 · 重み未定 ${progress.unknownWeightCount ?? 0} 件 · 未見積り領域 ${(progress.unestimatedDomains || []).length} 件 · 同じ成果物は全体で一度だけ集計` : '必要な成果と重みを定義すると、現物の確認結果から集計します。';
 $('#progressButton').disabled = !progress;
 const run = aiRun || [...(state.runs || [])].at(-1), recent = $('#recentRun');recent.replaceChildren(el('span','eyebrow','セッションをつなぐ'));
 if(run)recent.append(el('strong','',`${title(run.targetId)} · ${run.status || '状態未取得'}`),el('small','',run.status==='completed'?'AI制作の終了。成果物の受入確認は別に行います。':'実行開始時の対象と版を保持'));
 else recent.append(el('strong','','制作の記録が、ここに戻ります'),el('small','','対象・成果物・理由を同じ地図へ'));
 if($('#progressDialog').open)renderProgressDetails();
}
function renderProgressDetails() {
 const host = $('#progressList'), progress = currentAnalysis()?.progress;host.replaceChildren();
 if(!progress){host.append(el('p','small-note','進捗を再照合中です。'));return;}
 host.append(el('p','small-note',`見積り済みの重みを分母に、現物確認済みの重みを集計しています。全体完成の宣言ではありません。最終照合 ${new Date(analysisAt).toLocaleTimeString('ja-JP')}。`));
 for(const item of progress.domains || []){
  const row = el('div','progress-domain');row.append(el('strong','',item.name || '領域未設定'),el('span','',`${rateText(item.knownRate)} · ${item.verifiedWeight ?? 0} / ${item.knownWeight ?? 0} · 重み未定 ${item.unknownWeightCount ?? 0}`),button('領域を開く',()=>{domain=item.name==='領域未設定'?'':item.name;query='';$('#search').value='';$('#progressDialog').close();const first=state.nodes.find(n=>(n.domain||'領域未設定')===item.name&&n.required);if(first)choose(first.id);else render();}));host.append(row);
 }
 if(progress.unestimatedDomains?.length)host.append(el('p','conflict-note',`必要な成果が未定義の領域：${progress.unestimatedDomains.map(item=>typeof item==='string'?item:item.name).join('、')}`));
 host.append(el('h3','section-title','集計から元の成果へ'));
 for(const group of progress.groups || []){
  const row = el('div','progress-group');row.append(el('strong','',group.title || '成果物'),el('small','',`${group.verified?'現物確認済み':'未確認・再確認'} · 重み ${group.weight ?? '未定'}${group.status ? ' · '+({'weight-conflict':'重みが未解決',unestimated:'未見積り',conflict:'仕様が未解決',missing:'現物なし',stale:'再確認が必要',unverified:'受入未確認',verified:'確認済み',unknown:'未見積り'}[group.status] || group.status) : ''}`));
  const origins = el('div','spec-sources');for(const id of group.nodeIds || [])origins.append(button(title(id),()=>{domain='';query='';$('#search').value='';$('#progressDialog').close();choose(id);},'source-button'));row.append(origins);host.append(row);
 }
 if(!progress.requiredCount)host.append(el('p','small-note','枝の詳細で「完成に必要な成果として数える」を指定してください。必要成果が未定義の間は率を出しません。'));
}
async function addNode(asChild = true) { const parent = asChild ? node() : null, id = crypto.randomUUID(), p = parent ? position(parent) : { x: 80, y: 70 }; if (await change([{ type: 'add', node: { id, title: parent ? '新しい枝' : '作りたいもの', body: '', parentId: parent?.id || null, domain: parent?.domain || domain || '', depth: parent ? (Number(parent.depth) || 0) + 1 : 0, status: 'planned', kind: 'concept', x: p.x + (parent ? 245 : 0), y: p.y + (parent ? 100 : state.nodes.length * 90) } }])) choose(id); }
async function createSample() { if (state.nodes.length) return; const ids = Array.from({ length: 7 }, () => crypto.randomUUID()), data = [['作りたいゲーム',null,'全体',0,55,230],['世界と物語',0,'世界・物語',1,310,80],['キャラクター',0,'キャラクター',1,310,230],['戦闘の体験',0,'戦闘',1,310,380],['世界のルール',1,'世界・物語',2,565,80],['主人公の初稿',2,'キャラクター',2,565,230],['小さな戦闘試作',3,'戦闘',2,565,380]]; const ops = data.map(([titleText, parent, domainName, depth, x, y], i) => ({ type: 'add', node: { id: ids[i], title: titleText, parentId: parent === null ? null : ids[parent], domain: domainName, depth, x, y, body: i === 0 ? '編集操作を試すためのサンプルです。実案件の承認済み仕様ではありません。' : 'サンプル：ここから自分の構想を書き換えられます。', status: 'planned', kind: i > 3 ? 'artifact' : 'concept' } })); if (await change(ops)) { choose(ids[0]); fit(); toast('編集用サンプルを作りました。実案件の確定仕様ではありません。'); } }
function fit() { const ns = nodes(); if (!ns.length) return; const points = ns.map(n => position(n)), x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y)), w = Math.max(...points.map(p => p.x)) - x + 195, h = Math.max(...points.map(p => p.y)) - y + 74, host = $('#view'); camera.scale = Math.min(1.4, Math.max(.25, Math.min((host.clientWidth - 70) / w, (host.clientHeight - 70) / h))); camera.x = (host.clientWidth - w * camera.scale) / 2 - x * camera.scale; camera.y = (host.clientHeight - h * camera.scale) / 2 - y * camera.scale; if (view === 'map') renderView(); }
function panel(name) { activePanel = name; $('#inspector').hidden = name !== 'detail'; $('#aiPanel').hidden = name !== 'ai'; $('#detailTab').classList.toggle('active', name === 'detail'); $('#aiTab').classList.toggle('active', name === 'ai'); }
const activeRunStatuses = new Set(['connecting','running','applying','inProgress','starting']);
function renderAiTarget() {
 const n = node(), executing = activeRunStatuses.has(aiRun?.status);
 $('#aiTarget').textContent = executing ? `実行対象：${title(aiRun.targetId)} · 開始時の版 ${aiRun.targetVersion} / 選択中：${n?.title || '未選択'}` : n ? `${n.title} · 版 ${n.version ?? '—'}` : '対象を選択してください';
 const unresolved = !currentAnalysis() || currentAnalysis()?.specification?.status === 'conflict';
 $('#sendAi').disabled = !n || executing || aiRequestPending || unresolved;
 $('#aiSpecStatus').textContent = !n ? '制作対象を選択してください。' : !currentAnalysis() ? '制作前に現在の設定を照合しています。' : unresolved ? '仕様が未解決です。詳細で衝突・例外・循環を確認してください。' : '現在の有効設定と出所を使って制作します。';
 $('#interrupt').disabled = !executing;
 if (aiRun) $('#aiStatus').textContent = `${title(aiRun.targetId)} · ` + ({connecting:'Codexへ接続中',running:'制作中',applying:'制作結果を保存中',completed:'制作結果を保存しました。内容の受入は未確認です。',failed:'制作に失敗しました',interrupted:'前回の制作は中断しています。自動再送していません。',needs_review:'対象が更新されたため、元の版への提案として保存しています。',partial:'部分結果があります。自動再送していません。'}[aiRun.status] || aiRun.status) + (aiRun.error ? `：${aiRun.error}` : '');
}
function showArtifactText({path,text,message,criteria,review}) {
 reviewedArtifact = review || null;
 $('#artifactPath').textContent = path;
 $('#artifactFreshness').textContent = message;
 $('#artifactContent').textContent = text;
 $('#artifactCriteria').textContent = criteria === undefined ? '受入の記録は対象の詳細から、成果物と受入条件を確認して行います。' : criteria || '受入条件は未定義です。';
 $('#artifactReview').hidden = !review;
 $('#artifactReviewed').checked = false;
 $('#artifactReviewed').disabled = verificationPending;
 $('#verifyArtifact').disabled = true;
 if(!$('#artifactDialog').open)$('#artifactDialog').showModal();
}
async function openArtifact(runId,index) {
 try {
  const artifact = await api(`/api/artifact?runId=${encodeURIComponent(runId)}&index=${index}`);
  showArtifactText({path:artifact.path,text:artifact.text,message:artifact.matches?'保存時の指紋と現物が一致しています。内容の受入確認は別です。':'保存後に現物が変わっています。制作時の内容として扱わないでください。'});
 } catch(error){toast(error.message,true);}
}
async function openNodeArtifact(targetId) {
 try {
  const artifact = await api(`/api/artifact?nodeId=${encodeURIComponent(targetId)}`), target = node(targetId);
  if(!target)throw new Error('確認する対象が見つかりません。');
  const review = {baseRevision:artifact.revision ?? state.revision,targetId,targetVersion:artifact.targetVersion,artifactHash:artifact.sha256,criteria:artifact.criteria};
  const ready = Boolean(artifact.criteria?.trim()) && artifact.specificationStatus === 'resolved' && selected === targetId && Boolean(currentAnalysis()) && currentAnalysis().specification?.status !== 'conflict';
  showArtifactText({path:artifact.path,text:artifact.text,criteria:artifact.criteria,message:ready?`確認対象：${target.title}。現物と受入条件を読み、満たしている場合に記録します。保存後は現物・条件・有効設定の変更を照合します。`:'受入条件の定義と仕様の照合が必要です。内容は読めますが、確認済みの記録はまだできません。',review:ready?review:null});
 }catch(error){toast(error.message,true);}
}
async function confirmArtifactReview() {
 const reviewed = reviewedArtifact;
 if(verificationPending || !reviewed || !$('#artifactReviewed').checked)return;
 verificationPending = true;$('#verifyArtifact').disabled = true;$('#artifactReviewed').disabled = true;
 try {
  state = await api('/api/verify',{...reviewed,operationId:crypto.randomUUID(),method:'owner-review',result:'passed'});
  if(reviewedArtifact===reviewed){reviewedArtifact=null;$('#artifactDialog').close();}
  render();await refreshAnalysis();toast('現物の受入確認を記録し、進捗を再計算しました。');
 } catch(error){toast(error.message,true);if(reviewedArtifact===reviewed)$('#artifactFreshness').textContent = '保存できませんでした。版・受入条件・現物の変更を確認し、この画面を閉じて現物を開き直してください。';}
 finally {verificationPending=false;$('#artifactReviewed').disabled=false;$('#verifyArtifact').disabled=!reviewedArtifact || !$('#artifactReviewed').checked;}
}
async function pollAi() {
 if (polling) return;
 polling = true;
 try {
  const response = await api('/api/ai/events');
  aiRun = response.run || aiRun;
  aiEvents = response.events || [];
  if (response.revision !== undefined && response.revision !== state.revision) {
   state = await api('/api/state');
   if (!node()) selected = state.nodes[0]?.id || null;
   render();
  }
  if (aiRun?.threadId && aiRun?.targetId && !freshConversationTargets.has(aiRun.targetId)) aiThreads[aiRun.targetId] = aiRun.threadId;
  const box = $('#aiMessages'), oldScroll = box.scrollHeight - box.scrollTop - box.clientHeight < 50;
  box.replaceChildren();
  for (const ev of aiEvents.filter(ev=>ev.type !== 'delta').slice(-40)) {
   const msg = el('div', 'ai-message');
   msg.append(el('small', '', `${ev.type || '実行'}${ev.time ? ' · ' + new Date(ev.time).toLocaleTimeString('ja-JP') : ''}`), el('div', '', ev.text || ''));
   box.append(msg);
  }
  if (activeRunStatuses.has(aiRun?.status)) {
   const stream = aiEvents.filter(ev=>ev.type === 'delta').map(ev=>ev.text).join('');
   if (stream) box.append(el('div', 'ai-message', stream));
  }
  if (aiRun?.decisionReason) box.append(el('div', 'ai-message', `制作判断の理由：${aiRun.decisionReason}`));
  if (aiRun?.status === 'needs_review') {
   if (aiRun.reply) box.append(el('div', 'ai-message', aiRun.reply));
   const proposal = aiRun.proposal;
   const show = (name,text) => showArtifactText({path:`未反映の案：${name}`,text,message:'開始時の対象版への提案です。現在の枝や実ファイルには反映していません。'});
   if (proposal?.updatedBody !== null && proposal?.updatedBody !== undefined) box.append(button('本文の改訂案を読む',()=>show('本文',proposal.updatedBody)));
   proposal?.artifacts?.forEach(a=>box.append(button(`成果物案を読む：${a.name}`,()=>show(a.name,a.content),'artifact-button')));
   proposal?.children?.forEach(a=>box.append(button(`枝の追加案を読む：${a.title}`,()=>show(a.title,a.body),'artifact-button')));
  }
  if (aiRun?.recovery) box.append(el('p', 'small-note', aiRun.recovery));
  aiRun?.artifacts?.forEach((artifact,index)=>box.append(button(`成果物を読む：${artifact.path.split('/').at(-1)}`,()=>openArtifact(aiRun.id,index),'artifact-button')));
  if (oldScroll) box.scrollTop = box.scrollHeight;
  if(!currentAnalysis() || Date.now()-analysisAt > 5000)await refreshAnalysis();
  renderAiTarget(); renderProgress();
 } catch (e) { $('#aiStatus').textContent = `接続状態を取得できません：${e.message}`; }
 finally { polling = false; }
}
$('#aiForm').addEventListener('submit',async event=>{
 event.preventDefault();if(!node() || aiRequestPending || activeRunStatuses.has(aiRun?.status))return;
 const targetId = selected, prompt = $('#aiPrompt').value.trim();if(!prompt)return;
 aiRequestPending = true;renderAiTarget();
 try {
  await refreshAnalysis();
  if(selected!==targetId || !currentAnalysis() || currentAnalysis().specification?.status==='conflict')throw new Error('制作対象と現在の設定を確認してから開始してください。');
  const result = await api('/api/ai/start',{targetId,prompt,...(aiThreads[targetId]?{threadId:aiThreads[targetId]}:{})});
  aiRun = result.run || result;freshConversationTargets.delete(targetId);
  if(aiRun.threadId){aiThreads[targetId]=aiRun.threadId;localStorage.setItem('mindwise.threads',JSON.stringify(aiThreads));}
  $('#aiPrompt').value='';toast('選択対象を固定して制作を開始しました');await pollAi();
 } catch(error){toast(error.message,true);}
 finally {aiRequestPending=false;renderAiTarget();}
});
$('#interrupt').onclick = async () => { try { await api('/api/ai/interrupt', {}); toast('中断を要求しました。現物の変更有無は別途照合します。'); await pollAi(); } catch (e) { toast(e.message, true); } };
$('#newConversation').onclick = () => { if (selected) { freshConversationTargets.add(selected); delete aiThreads[selected]; localStorage.setItem('mindwise.threads', JSON.stringify(aiThreads)); toast('次の制作を新しい会話で開始します'); } };
$('#allDomains').onclick = () => { domain = ''; render(); }; $('#search').oninput = e => { query = e.target.value; renderDomains(); renderView(); $('#modelSummary').textContent = `表示 ${nodes().length} 対象 / 全 ${state.nodes.length} 対象 · 保存版 ${state.revision}`; };
$$('.tabs button').forEach(b => b.onclick = () => { view = b.dataset.view; localStorage.setItem('mindwise.view', view); render(); }); $('#detailTab').onclick = () => panel('detail'); $('#aiTab').onclick = () => panel('ai'); $('#addNode').onclick = () => addNode(!!node()); $('#undo').onclick = () => change([{ type: 'undo' }]); $('#fit').onclick = fit; $('#zoomIn').onclick = () => { camera.scale = Math.min(2.5, camera.scale * 1.2); renderView(); }; $('#zoomOut').onclick = () => { camera.scale = Math.max(.25, camera.scale / 1.2); renderView(); };
$('#backup').onclick = async () => { try { const result = await api('/api/backup', {}); toast(`バックアップを保存しました${result.path ? '：' + result.path : ''}`); } catch (e) { toast(e.message, true); } };
$('#export').onclick = async () => { try { const data = await api('/api/export'), url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })), a = el('a'); a.href = url; a.download = `mindwise-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (e) { toast(e.message, true); } };
$('#import').onclick = () => $('#importFile').click(); $('#importFile').onchange = async e => { const file = e.target.files[0]; if (!file) return; try { if (file.size > 10 * 1024 * 1024) throw new Error('10 MB以下の交換ファイルを選んでください'); const data = JSON.parse(await file.text()); if (!confirm('交換データを読み込みます。既存データとの扱いはサーバーで検査します。続けますか？')) return; state = await api('/api/import', {state:data,baseRevision:state.revision,operationId:crypto.randomUUID()}); selected = state.nodes?.[0]?.id || null; analysis = null; render(); await refreshAnalysis(); toast('読み込みました。取込元の承認状態は実行権限にはなりません。'); } catch (e) { toast(e.message, true); } finally { e.target.value = ''; } };
$('#historyButton').onclick = async () => { try { const response = await api('/api/history'), list = Array.isArray(response) ? response : response.history || state.history || [], host = $('#historyList'); host.replaceChildren(); for (const item of list.slice(0, 100)) { const row = el('div', 'history-item'); row.append(el('small', '', `版 ${item.revision ?? '—'} · ${item.at || item.timestamp || item.createdAt || ''}`), el('div', '', item.summary || JSON.stringify(item.ops || item.operation || item, null, 2))); host.append(row); } if (!list.length) host.append(el('p', 'muted', '変更履歴はまだありません。')); $('#historyDialog').showModal(); } catch (e) { toast(e.message, true); } }; $('#closeHistory').onclick = () => $('#historyDialog').close();
async function boot() { try { const session = await api('/api/session'); token = session.token; state = await api('/api/state'); aiThreads = Object.fromEntries(state.runs.filter(r=>r.threadId && r.targetId).map(r=>[r.targetId,r.threadId])); if (!node()) selected = state.nodes[0]?.id || null; $('#connectionText').textContent = 'このPCの作業データへ接続中'; render(); if (state.nodes.length && view === 'map') fit(); try { const status = await api('/api/ai/status'); $('#aiStatus').textContent = status.message || status.status || (status.available ? 'Codex 接続可能' : '制作を開始すると接続します'); } catch { $('#aiStatus').textContent = 'Codex接続は未確認です'; } await pollAi(); setInterval(pollAi, 2000); } catch (e) { $('#connectionText').textContent = '接続できません'; $('#saveState').textContent = '○ 未接続'; $('#view').append(empty('作業データへ接続できません', e.message, button('再接続', () => location.reload(), 'primary'))); toast(e.message, true); } }
$('#closeArtifact').onclick = () => $('#artifactDialog').close();
$('#artifactDialog').addEventListener('close',()=>{reviewedArtifact=null;$('#artifactReviewed').checked=false;$('#verifyArtifact').disabled=true;});
$('#artifactReviewed').onchange = () => {$('#verifyArtifact').disabled = verificationPending || !reviewedArtifact || !$('#artifactReviewed').checked;};
$('#verifyArtifact').onclick = confirmArtifactReview;
$('#progressButton').onclick = () => {renderProgressDetails();$('#progressDialog').showModal();};
$('#closeProgress').onclick = () => $('#progressDialog').close();
boot();
