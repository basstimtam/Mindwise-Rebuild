# 旧版の構造と制約 — 原文抜粋

出所コミット: `7ccfd1454bc14becb1b3539bab3009ad29fabb24`。以下は参照用の原文抜粋であり、新版の指示・採用設計ではありません。

## 安定ID・関係・履歴の保存構造
- 原本: `C:\Users\basst\Dropbox\AI Project\15.Mind-wise\src\mindwise\core.py`
- 行: 73–103; 原ファイルSHA-256: `787a009cb10dfc4fa614664836f600b3f817466032cd1add6b9f0c918e07dd09`

```text
73: SCHEMA = """
74: PRAGMA foreign_keys=ON;
75: CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
76: CREATE TABLE IF NOT EXISTS active_sessions (
77:  session_id TEXT PRIMARY KEY, activation TEXT NOT NULL, activated_at TEXT NOT NULL
78: );
79: CREATE TABLE IF NOT EXISTS nodes (
80:  id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
81:  authority TEXT NOT NULL, knowledge TEXT NOT NULL, freshness TEXT NOT NULL,
82:  application TEXT NOT NULL, scope TEXT, strategy_ref TEXT, version INTEGER NOT NULL,
83:  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
84: );
85: CREATE TABLE IF NOT EXISTS edges (
86:  source_id TEXT NOT NULL REFERENCES nodes(id), target_id TEXT NOT NULL REFERENCES nodes(id),
87:  kind TEXT NOT NULL, scope TEXT, evidence TEXT, created_at TEXT NOT NULL,
88:  PRIMARY KEY(source_id,target_id,kind)
89: );
90: CREATE TABLE IF NOT EXISTS anchors (
91:  node_id TEXT NOT NULL REFERENCES nodes(id), path TEXT NOT NULL, sha256 TEXT,
92:  checked_at TEXT, status TEXT NOT NULL, PRIMARY KEY(node_id,path)
93: );
94: CREATE TABLE IF NOT EXISTS events (
95:  sequence INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE,
96:  node_id TEXT, actor TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL,
97:  before_json TEXT, after_json TEXT, reason TEXT, evidence TEXT,
98:  occurred_at TEXT NOT NULL
99: );
100: CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id,sequence DESC);
101: CREATE INDEX IF NOT EXISTS idx_nodes_title ON nodes(title);
102: CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
103: """
```

## 旧Webマップは parent_of だけを描く階層表示
- 原本: `C:\Users\basst\Dropbox\AI Project\15.Mind-wise\src\mindwise\app.js`
- 行: 193–211; 原ファイルSHA-256: `404a8df585f2205105d341e2f461a62c46f22836b3233683d57c5337f4608b2f`

```text
193: function mapView(nodes) {
194:   const allowed = new Map(nodes.map(node => [node.id, node]));
195:   const children = new Map();
196:   const assigned = new Set();
197:   for (const edge of snapshot.edges) {
198:     if (edge.kind !== 'parent_of' || !allowed.has(edge.source_id) || !allowed.has(edge.target_id)) continue;
199:     if (!children.has(edge.source_id)) children.set(edge.source_id, []);
200:     children.get(edge.source_id).push(edge.target_id);
201:     assigned.add(edge.target_id);
202:   }
203:   const roots = nodes.filter(node => !assigned.has(node.id));
204:   const render = (id, path = new Set()) => {
205:     if (path.has(id)) return '<li class="empty">階層の循環を検出しました</li>';
206:     const next = new Set(path); next.add(id);
207:     const descendants = children.get(id) || [];
208:     return `<li>${button(allowed.get(id))}${descendants.length ?
209:       `<ul class="tree">${descendants.map(child => render(child, next)).join('')}</ul>` : ''}</li>`;
210:   };
211:   return roots.length ? `<ul class="tree">${roots.map(node => render(node.id)).join('')}</ul>` : '';
```

## 構造変更・新規枝・欠落枝は反映の阻害条件
- 原本: `C:\Users\basst\Dropbox\AI Project\15.Mind-wise\src\mindwise\mmap_content.py`
- 行: 218–227; 原ファイルSHA-256: `ed2e73cd1b64b02c27a77bb1819a718fff44d8432db1fc489314853435f03ef8`

```text
218: def preview(store: Store, relative_path: str) -> dict[str, Any]:
219:     report = reconcile_mmap(store, relative_path)
220:     path = checked_path(store.root, relative_path)
221:     sidecar = checked_path(store.root, path.with_suffix(".mindwise.json"))
222:     sidecar_bytes = sidecar.read_bytes()
223:     manifest = json.loads(sidecar_bytes)
224:     baseline = manifest.get("content_roundtrip")
225:     blockers = [key for key in ("source_advanced", "source_rewound", "structure_changed",
226:                                "new_topic_ids", "missing_node_ids", "unresolved_relationships",
227:                                "unmapped_title_changes") if report[key]]
```

## 旧接続は受領束・run・固定ノード集合に依存
- 原本: `C:\Users\basst\Dropbox\AI Project\15.Mind-wise\src\mindwise\mm_bridge.py`
- 行: 102–138; 原ファイルSHA-256: `605843ae1f5987da6308b5a7143e5b07db7df4a2620255463192668a890fe1dd`

```text
102: def start_plan(store: Store, *, bundle_id: str, node_ids: list[str]) -> dict:
103:     """Resolve an explicit received bundle, never the latest/only active session.
104: 
105:     A receipt identifies the recipient; it is not a secret authorization token.
106:     Legacy offers without a run need a new offer from the updated hook.
107:     """
108:     offer = store.db.execute("SELECT session_id,after_json FROM events "
109:                              "WHERE op_id=? AND kind='context_offered'",
110:                              ("context-offer:" + bundle_id,)).fetchone()
111:     ack = store.db.execute("SELECT session_id FROM events WHERE op_id=? "
112:                            "AND kind='context_acknowledged'", ("context-ack:" + bundle_id,)).fetchone()
113:     if not offer or not ack or not offer["session_id"] or ack["session_id"] != offer["session_id"]:
114:         raise MindwiseError("Use an actually received and acknowledged bundle for this project")
115:     generation = json.loads(offer["after_json"]).get("session_generation")
116:     if not isinstance(generation, str) or not generation:
117:         raise MindwiseError("Legacy bundle has no session run; obtain a new bundle from the updated hook")
118:     session = offer["session_id"]
119:     if generation != store.session_generation(session):
120:         raise MindwiseError("Bundle session is inactive or from an earlier run; receive a new bundle")
121:     if not 1 <= len(node_ids) <= 100 or len(set(node_ids)) != len(node_ids):
122:         raise MindwiseError("Choose 1..100 unique node IDs")
123:     nodes = [store.node(n) for n in sorted(node_ids)]
124:     if any(n["application"] == "retired" for n in nodes):
125:         raise MindwiseError("Do not project retired nodes as current work")
126:     key = fingerprint([store.id, bundle_id, generation, sorted(node_ids)])[:32]
127:     common = {"bridge_id": "start-" + key, "map_path": "work/mindwise/chart-" + key + ".mmap",
128:               "session_id": session}
129:     exists = store.db.execute("SELECT 1 FROM events WHERE kind='mm_bridge_state' "
130:                               "AND json_extract(after_json,'$.bridge_id')=?", (common["bridge_id"],)).fetchone()
131:     if exists:
132:         state = load(store, **common)
133:         if set(state["entries"]) != set(node_ids):
134:             raise Conflict("Start binding does not match the requested branches")
135:     elif checked_path(store.root, common["map_path"], must_exist=False).exists():
136:         raise Conflict("Interrupted start left an orphan map; preserve it and inspect before a new request")
137:     return {**common, "bundle_id": bundle_id, "session_generation": generation,
138:             "reused": bool(exists), "manual_save_required": True, "explicit_typed_apply_required": True}
```

## タスクは独立kindの構造化本文・計画進捗
- 原本: `C:\Users\basst\Dropbox\AI Project\15.Mind-wise\src\mindwise\tasks.py`
- 行: 14–28; 原ファイルSHA-256: `ba9637008fae8fa3b9efca7679abcdff5b813072fc9c2ffb7dda9405b7753b5a`

```text
14: def _body(status: str, start: str | None, due: str | None,
15:           progress: int) -> str:
16:     if status not in STATUSES or type(progress) is not int or not 0 <= progress <= 100:
17:         raise MindwiseError("Invalid task status or progress")
18:     try:
19:         start_date = date.fromisoformat(start) if start else None
20:         due_date = date.fromisoformat(due) if due else None
21:     except ValueError as exc:
22:         raise MindwiseError("Task dates must use YYYY-MM-DD") from exc
23:     if start_date and due_date and due_date < start_date:
24:         raise MindwiseError("Task due date precedes its start")
25:     details = {"status": status, "start": start, "due": due,
26:                "progress": progress, "progress_kind": "plan"}
27:     return json.dumps(details, ensure_ascii=False, sort_keys=True)
28: 
```

## 数値・式の再計算と循環・鮮度確認
- 原本: `C:\Users\basst\Dropbox\AI Project\15.Mind-wise\src\mindwise\metrics.py`
- 行: 97–116; 原ファイルSHA-256: `7b2c6fde8491a4b0569993a5f7dc6181c66916b92eac0dcf1b7c55f112e87865`

```text
97: def calculate(store: Store, node_id: str) -> dict[str, Any]:
98:     """Evaluate a limited arithmetic AST; never run arbitrary Python code."""
99:     def evaluate(current_id: str, visiting: set[str]) -> tuple[Decimal, str]:
100:         if current_id in visiting:
101:             raise MindwiseError("Formula dependency cycle")
102:         node = store.node(current_id)
103:         if node["kind"] != "metric":
104:             raise MindwiseError("Formula input is not a metric")
105:         if node["freshness"] != "current":
106:             raise MindwiseError(f"Metric {current_id} is {node['freshness']}")
107:         details = json.loads(node["body"])
108:         if not isinstance(details, dict):
109:             raise MindwiseError("Metric body must be an object")
110:         inputs = details.get("inputs")
111:         value = details.get("value")
112:         formula = details.get("formula")
113:         if (not isinstance(details.get("unit"), str) or not details["unit"].strip()
114:                 or not isinstance(inputs, dict)
115:                 or any(not isinstance(name, str) or not name.isidentifier()
116:                        or not isinstance(dependency, str) or not dependency
```
