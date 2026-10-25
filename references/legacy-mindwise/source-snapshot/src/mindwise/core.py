"""Storage and project-boundary rules for Mindwise.

The database is a local operational store, separate from the project checkout. Its
schema and exports are documented and do not depend on a viewer or Codex internals.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


class MindwiseError(Exception):
    """Expected user-visible error."""


class Conflict(MindwiseError):
    """The caller based a change on an old version."""


class BoundaryError(MindwiseError):
    """An operation would leave the registered project."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def canonical_root(root: str | Path) -> Path:
    path = Path(root).expanduser().resolve(strict=True)
    if not path.is_dir():
        raise BoundaryError(f"Project root is not a directory: {path}")
    return path


def project_id(root: Path) -> str:
    # casefold is appropriate for this Windows-first product; it prevents the same
    # checkout from acquiring two stores through differently-cased registrations.
    return hashlib.sha256(str(root).casefold().encode("utf-8")).hexdigest()[:24]


def local_data_home() -> Path:
    base = os.environ.get("MINDWISE_DATA_HOME")
    if base:
        return Path(base).expanduser().resolve()
    base = os.environ.get("LOCALAPPDATA")
    if base:
        return Path(base) / "Mindwise"
    return Path.home() / ".local" / "share" / "mindwise"


def checked_path(root: Path, candidate: str | Path, *, must_exist: bool = True) -> Path:
    """Resolve symlinks and reject traversal outside the explicitly chosen root."""
    boundary = canonical_root(root)
    raw = Path(candidate)
    path = raw if raw.is_absolute() else boundary / raw
    resolved = path.resolve(strict=must_exist)
    try:
        resolved.relative_to(boundary)
    except ValueError as exc:
        raise BoundaryError(f"Path is outside the registered project: {candidate}") from exc
    return resolved


SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS active_sessions (
 session_id TEXT PRIMARY KEY, activation TEXT NOT NULL, activated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nodes (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
 authority TEXT NOT NULL, knowledge TEXT NOT NULL, freshness TEXT NOT NULL,
 application TEXT NOT NULL, scope TEXT, strategy_ref TEXT, version INTEGER NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
 source_id TEXT NOT NULL REFERENCES nodes(id), target_id TEXT NOT NULL REFERENCES nodes(id),
 kind TEXT NOT NULL, scope TEXT, evidence TEXT, created_at TEXT NOT NULL,
 PRIMARY KEY(source_id,target_id,kind)
);
CREATE TABLE IF NOT EXISTS anchors (
 node_id TEXT NOT NULL REFERENCES nodes(id), path TEXT NOT NULL, sha256 TEXT,
 checked_at TEXT, status TEXT NOT NULL, PRIMARY KEY(node_id,path)
);
CREATE TABLE IF NOT EXISTS events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE,
 node_id TEXT, actor TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL,
 before_json TEXT, after_json TEXT, reason TEXT, evidence TEXT,
 occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id,sequence DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_title ON nodes(title);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
"""

MIGRATION_2 = """
CREATE TABLE IF NOT EXISTS event_distillations (
 event_op_id TEXT NOT NULL REFERENCES events(op_id),
 insight_id TEXT NOT NULL REFERENCES nodes(id),
 created_at TEXT NOT NULL,
 PRIMARY KEY(event_op_id,insight_id)
);
CREATE INDEX IF NOT EXISTS idx_distillations_insight ON event_distillations(insight_id);
"""

INDEXES = {
    "idx_events_node": "CREATE INDEX IF NOT EXISTS idx_events_node ON events(node_id,sequence DESC)",
    "idx_nodes_title": "CREATE INDEX IF NOT EXISTS idx_nodes_title ON nodes(title)",
    "idx_edges_target": "CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id)",
    "idx_distillations_insight": "CREATE INDEX IF NOT EXISTS idx_distillations_insight ON event_distillations(insight_id)",
}

NODE_STATES = {
    "authority": {"contract", "owner", "agent", "proposal"},
    "knowledge": {"observation", "decision", "hypothesis", "unknown"},
    "freshness": {"current", "stale", "unverified"},
    "application": {"proposed", "adopted", "implemented", "verified", "retired"},
}
EDGE_KINDS = {
    "contributes", "specifies", "depends_on", "applies_to", "exception_to",
    "implements", "verifies", "replaces", "contradicts", "parent_of", "locates",
}

PENDING_EVENT_FILTER = (
    "(((e.node_id IS NULL AND e.kind NOT IN "
    "('session_start','session_end','SessionStart','SessionEnd','PostToolUse',"
    "'context_offered','context_acknowledged')) OR e.kind='anchor_observed') "
    "AND NOT EXISTS (SELECT 1 FROM event_distillations d WHERE d.event_op_id=e.op_id)"
    " AND e.kind NOT IN ('projection_reviewed','projection_resolved','projection_resolution_requested',"
    "'projection_resolution_cancelled','decision_recording_requested'))"
    " OR (e.kind='decision_recording_requested' AND substr(e.op_id,-7)=':intent'"
    " AND NOT EXISTS (SELECT 1 FROM events completed"
    " JOIN event_distillations d ON d.event_op_id=e.op_id AND d.insight_id=completed.node_id"
    " JOIN events purpose ON purpose.op_id=completed.op_id||':purpose' AND purpose.kind='edge_add'"
    " WHERE completed.kind='node_upsert'"
    " AND json_extract(completed.after_json,'$.kind')='decision'"
    " AND json_extract(purpose.after_json,'$.kind')='specifies'"
    " AND json_extract(purpose.after_json,'$.source_id')=completed.node_id"
    " AND json_extract(purpose.after_json,'$.target_id')=json_extract(e.after_json,'$.purpose_id')"
    " AND completed.op_id=substr(e.op_id,1,length(e.op_id)-7)))"
    " OR (e.kind='projection_resolution_requested' AND substr(e.op_id,-7)=':intent'"
    " AND NOT EXISTS (SELECT 1 FROM events completed WHERE completed.kind='projection_resolved'"
    " AND completed.op_id=substr(e.op_id,1,length(e.op_id)-7))"
    " AND NOT EXISTS (SELECT 1 FROM events cancelled WHERE cancelled.kind='projection_resolution_cancelled'"
    " AND cancelled.op_id=substr(e.op_id,1,length(e.op_id)-7)||':cancelled'))"
)


class Store:
    def __init__(self, root: str | Path, *, data_home: str | Path | None = None,
                 create: bool = False, read_only: bool = False):
        if create and read_only:
            raise MindwiseError("Read-only access cannot register a project")
        self.root = canonical_root(root)
        self.id = project_id(self.root)
        home = Path(data_home).expanduser().resolve() if data_home else local_data_home()
        self.db_path = home / "projects" / self.id / "mindwise.sqlite3"
        if not create and not self.db_path.is_file():
            raise MindwiseError("Project is not registered in Mindwise")
        if create:
            self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db = (sqlite3.connect(self.db_path.as_uri() + "?mode=ro", uri=True, timeout=10)
                   if read_only else sqlite3.connect(self.db_path, timeout=10))
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        if create:
            self.db.executescript(SCHEMA)
            with self.db:
                row = self.db.execute("SELECT value FROM metadata WHERE key='root'").fetchone()
                if row and row["value"] != str(self.root):
                    raise BoundaryError("A different root is registered under this project ID")
                self.db.execute("INSERT OR IGNORE INTO metadata VALUES('root', ?)", (str(self.root),))
                self.db.execute("INSERT OR IGNORE INTO metadata VALUES('schema', '1')")
        else:
            row = self.db.execute("SELECT value FROM metadata WHERE key='root'").fetchone()
            if not row or row["value"] != str(self.root):
                raise BoundaryError("Database root does not match the requested project")
        schema = self.db.execute("SELECT value FROM metadata WHERE key='schema'").fetchone()
        if not schema or schema["value"] not in {"1", "2"}:
            raise MindwiseError("Unsupported Mindwise schema")
        if schema["value"] == "1":
            if read_only:
                self.db.close()
                raise MindwiseError("Read-only access requires schema 2; migrate through the existing write path")
            self.db.executescript(MIGRATION_2)
            with self.db:
                self.db.execute("UPDATE metadata SET value='2' WHERE key='schema'")

    def close(self) -> None:
        self.db.close()

    def index_status(self) -> dict[str, Any]:
        present = {row["name"] for row in self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        )}
        missing = sorted(set(INDEXES) - present)
        return {"expected": sorted(INDEXES), "missing": missing,
                "status": "current" if not missing else "incomplete"}

    def rebuild_indexes(self) -> dict[str, Any]:
        """Restore only known derived indexes after checking database integrity."""
        integrity = self.db.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise MindwiseError(f"Database integrity check failed: {integrity}")
        before = self.index_status()
        with self.db:
            for statement in INDEXES.values():
                self.db.execute(statement)
        after = self.index_status()
        if after["missing"]:
            raise MindwiseError("Some Mindwise indexes could not be rebuilt")
        return {"recreated": before["missing"], "status": after["status"],
                "semantic_sequence": self.semantic_sequence()}

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @contextmanager
    def _transaction(self):
        """Lock outer writes and isolate nested writes without committing their caller."""
        outer = not self.db.in_transaction
        savepoint = f"mindwise_{uuid.uuid4().hex}"
        self.db.execute("BEGIN IMMEDIATE" if outer else f"SAVEPOINT {savepoint}")
        try:
            yield
        except BaseException:
            if outer:
                self.db.rollback()
            else:
                self.db.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                self.db.execute(f"RELEASE SAVEPOINT {savepoint}")
            raise
        else:
            if outer:
                self.db.commit()
            else:
                self.db.execute(f"RELEASE SAVEPOINT {savepoint}")

    def _event(self, op_id: str, node_id: str | None, actor: str,
               session_id: str | None, kind: str, before: Any, after: Any,
               reason: str | None, evidence: str | None) -> None:
        self.db.execute(
            "INSERT INTO events(op_id,node_id,actor,session_id,kind,before_json,"
            "after_json,reason,evidence,occurred_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (op_id, node_id, actor, session_id, kind,
             json.dumps(before, ensure_ascii=False, sort_keys=True) if before is not None else None,
             json.dumps(after, ensure_ascii=False, sort_keys=True) if after is not None else None,
             reason, evidence, utc_now()),
        )

    def _seen(self, op_id: str) -> bool:
        return self.db.execute("SELECT 1 FROM events WHERE op_id=?", (op_id,)).fetchone() is not None

    def repeated_upsert(self, op_id: str, node_id: str, *, title: str, body: str,
                        base_version: int, reason: str | None,
                        evidence: str | None = None) -> dict[str, Any] | None:
        """Accept a retry only for the exact earlier node change."""
        event = self.db.execute("SELECT * FROM events WHERE op_id=?", (op_id,)).fetchone()
        if not event:
            return None
        before = json.loads(event["before_json"] or "null")
        after = json.loads(event["after_json"] or "null")
        if (event["kind"] != "node_upsert" or event["node_id"] != node_id
                or not before or not after or before["version"] != base_version
                or after["title"] != title or after["body"] != body
                or event["reason"] != reason or event["evidence"] != evidence):
            raise Conflict("Operation ID belongs to a different node change")
        return self.node(node_id)

    def _invalidate_dependents(self, node_id: str, op_id: str, reason: str) -> None:
        """Keep downstream work visible, but require it to be checked again."""
        for item in self.impact(node_id):
            dependent = item["node"]
            if dependent["authority"] == "contract" or dependent["application"] == "retired":
                continue
            if dependent["freshness"] == "stale":
                continue
            application = ("implemented" if dependent["application"] == "verified"
                           else dependent["application"])
            self.db.execute(
                "UPDATE nodes SET freshness='stale',application=?,version=version+1,updated_at=? WHERE id=?",
                (application, utc_now(), dependent["id"]),
            )
            self._event(f"{op_id}:invalidate:{dependent['id']}", dependent["id"],
                        "mindwise", None, "dependency_stale", dependent,
                        self.node(dependent["id"]), reason, node_id)

    def node(self, node_id: str) -> dict[str, Any]:
        row = self.db.execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()
        if not row:
            raise MindwiseError(f"Unknown node: {node_id}")
        return dict(row)

    def upsert_node(self, *, node_id: str | None = None, kind: str, title: str,
                    body: str = "", authority: str = "agent",
                    knowledge: str = "hypothesis", freshness: str = "unverified",
                    application: str = "proposed", scope: str | None = None,
                    strategy_ref: str | None = None, actor: str = "agent",
                    session_id: str | None = None, reason: str | None = None,
                    evidence: str | None = None, base_version: int | None = None,
                    op_id: str | None = None,
                    formula_inputs: dict[str, str] | None = None) -> dict[str, Any]:
        for field, value in (("authority", authority), ("knowledge", knowledge),
                             ("freshness", freshness), ("application", application)):
            if value not in NODE_STATES[field]:
                raise MindwiseError(f"Invalid {field}: {value}")
        if not title.strip():
            raise MindwiseError("A node needs a title")
        if application == "verified" and (freshness != "current" or not (evidence or "").strip()):
            raise MindwiseError("Verified content requires current evidence")
        if formula_inputs is not None and kind != "metric":
            raise MindwiseError("Formula dependencies require a metric node")
        requested_node_id = node_id
        node_id = node_id or str(uuid.uuid4())
        op_id = op_id or str(uuid.uuid4())
        if authority == "contract" and actor != "contract_import":
            raise BoundaryError("Contract projections require a contract import")
        if authority == "owner" and actor != "owner":
            raise BoundaryError("Owner-confirmed content requires an owner change")
        with self._transaction():
            previous = self.db.execute("SELECT * FROM events WHERE op_id=?", (op_id,)).fetchone()
            if previous:
                after = json.loads(previous["after_json"] or "null")
                expected = {"kind": kind, "title": title, "body": body,
                            "authority": authority, "knowledge": knowledge,
                            "freshness": freshness, "application": application,
                            "scope": scope, "strategy_ref": strategy_ref}
                if (previous["kind"] != "node_upsert" or not after
                        or (requested_node_id is not None
                            and requested_node_id != previous["node_id"])
                        or any(after[field] != value for field, value in expected.items())
                        or previous["actor"] != actor
                        or previous["session_id"] != session_id
                        or previous["reason"] != reason
                        or previous["evidence"] != evidence):
                    raise Conflict("Operation ID belongs to a different node change")
                return self.node(previous["node_id"])
            old = self.db.execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()
            if old:
                before = dict(old)
                if base_version is None or base_version != old["version"]:
                    raise Conflict(f"Expected version {base_version}; current version is {old['version']}")
                if old["authority"] == "contract" and actor != "contract_import":
                    raise BoundaryError("Contract projections are read-only")
                if old["authority"] == "owner" and actor != "owner":
                    raise BoundaryError("Owner-confirmed content requires an owner change")
                if old["authority"] != authority and actor not in {"owner", "contract_import"}:
                    raise BoundaryError("Changing authority requires owner approval")
                version = old["version"] + 1
                self.db.execute(
                    "UPDATE nodes SET kind=?,title=?,body=?,authority=?,knowledge=?,freshness=?,"
                    "application=?,scope=?,strategy_ref=?,version=?,updated_at=? WHERE id=?",
                    (kind, title, body, authority, knowledge, freshness, application,
                     scope, strategy_ref, version, utc_now(), node_id),
                )
            else:
                before = None
                version = 1
                stamp = utc_now()
                self.db.execute(
                    "INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (node_id, kind, title, body, authority, knowledge, freshness,
                     application, scope, strategy_ref, version, stamp, stamp),
                )
            after = self.node(node_id)
            self._event(op_id, node_id, actor, session_id, "node_upsert", before,
                        after, reason, evidence)
            if formula_inputs is not None:
                self._sync_formula_edges(node_id, formula_inputs, op_id, actor)
            if before and any(before[key] != after[key] for key in
                              ("kind", "title", "body", "authority", "knowledge",
                               "scope", "application")):
                self._invalidate_dependents(node_id, op_id, "Prerequisite changed")
        return after

    def _sync_formula_edges(self, node_id: str, inputs: dict[str, str],
                            op_id: str, actor: str) -> None:
        """Replace formula-only dependencies in the node update transaction."""
        desired = {target: f"formula input {name}" for name, target in inputs.items()}
        old = self.db.execute(
            "SELECT * FROM edges WHERE source_id=? AND kind='depends_on' "
            "AND evidence LIKE 'formula input %' ORDER BY target_id",
            (node_id,),
        ).fetchall()
        for row in old:
            if desired.get(row["target_id"]) == row["evidence"]:
                continue
            self.db.execute("DELETE FROM edges WHERE source_id=? AND target_id=? "
                            "AND kind='depends_on'", (node_id, row["target_id"]))
            self._event(f"{op_id}:input-remove:{row['target_id']}", node_id, actor,
                        None, "edge_remove", dict(row), None,
                        "Formula input changed", row["target_id"])
        for target_id, label in desired.items():
            existing = self.db.execute(
                "SELECT * FROM edges WHERE source_id=? AND target_id=? "
                "AND kind='depends_on'", (node_id, target_id),
            ).fetchone()
            if existing:
                if existing["evidence"] != label:
                    raise Conflict("Formula input conflicts with another dependency")
                continue
            edge = {"source_id": node_id, "target_id": target_id,
                    "kind": "depends_on", "scope": None, "evidence": label,
                    "created_at": utc_now()}
            self.db.execute("INSERT INTO edges VALUES(?,?,?,?,?,?)", tuple(edge.values()))
            self._event(f"{op_id}:input-add:{target_id}", node_id, actor,
                        None, "edge_add", None, edge, "Formula input changed", target_id)

    def link(self, source_id: str, target_id: str, kind: str, *, scope: str | None = None,
             evidence: str | None = None, actor: str = "agent", op_id: str | None = None) -> None:
        if kind not in EDGE_KINDS:
            raise MindwiseError(f"Invalid edge kind: {kind}")
        if kind == "exception_to" and not (evidence or "").strip():
            raise MindwiseError("An exception needs a recorded reason or evidence")
        self.node(source_id)
        self.node(target_id)
        op_id = op_id or str(uuid.uuid4())
        with self._transaction():
            previous = self.db.execute("SELECT * FROM events WHERE op_id=?", (op_id,)).fetchone()
            if previous:
                after = json.loads(previous["after_json"] or "null")
                if (previous["kind"] != "edge_add" or not after
                        or previous["actor"] != actor
                        or any(after[field] != value for field, value in
                               {"source_id": source_id, "target_id": target_id,
                                "kind": kind, "scope": scope,
                                "evidence": evidence}.items())):
                    raise Conflict("Operation ID belongs to a different relationship")
                return
            old = self.db.execute("SELECT * FROM edges WHERE source_id=? AND target_id=? AND kind=?",
                                  (source_id, target_id, kind)).fetchone()
            if old:
                raise Conflict("The relationship already exists")
            after = {"source_id": source_id, "target_id": target_id, "kind": kind,
                     "scope": scope, "evidence": evidence, "created_at": utc_now()}
            self.db.execute("INSERT INTO edges VALUES(?,?,?,?,?,?)", tuple(after.values()))
            self._event(op_id, source_id, actor, None, "edge_add", None, after, None, evidence)

    def record_decision(self, *, title: str, purpose_id: str, choice: str,
                        reason: str, scope: str, applies_to: list[str] | None = None,
                        alternatives: list[dict[str, str]] | None = None,
                        reconsider_when: str | None = None,
                        evidence: str | None = None, session_id: str | None = None,
                        op_id: str | None = None) -> dict[str, Any]:
        """Record a design choice with its strategic reason and explicit scope."""
        if not choice.strip() or not reason.strip() or not scope.strip():
            raise MindwiseError("A decision needs a choice, reason, and scope")
        self.node(purpose_id)
        targets = list(dict.fromkeys(applies_to or []))
        for target in targets:
            self.node(target)
        details = {"choice": choice, "reason": reason,
                   "alternatives": alternatives or [],
                   "reconsider_when": reconsider_when}
        op_id = op_id or str(uuid.uuid4())
        intent_id = f"{op_id}:intent"
        self.record_event(
            op_id=intent_id, kind="decision_recording_requested", actor="agent",
            session_id=session_id, reason=reason, evidence=evidence,
            details={"title": title, "purpose_id": purpose_id, "scope": scope,
                     "applies_to": sorted(targets), **details},
        )
        with self._transaction():
            if self._seen(op_id):
                prefix = f"{op_id}:target:"
                recorded = self.db.execute(
                    "SELECT after_json FROM events WHERE substr(op_id,1,?)=? AND kind='edge_add'",
                    (len(prefix), prefix),
                ).fetchall()
                if {json.loads(row["after_json"])["source_id"] for row in recorded} != set(targets):
                    raise Conflict("Operation ID belongs to a different decision application")
            decision = self.upsert_node(
                kind="decision", title=title,
                body=json.dumps(details, ensure_ascii=False, sort_keys=True),
                knowledge="decision", freshness="unverified", application="adopted",
                scope=scope, strategy_ref=purpose_id, session_id=session_id,
                reason=reason, evidence=evidence, op_id=op_id,
            )
            self.link(decision["id"], purpose_id, "specifies", scope=scope,
                      evidence=evidence, op_id=f"{op_id}:purpose")
            for target in targets:
                self.link(target, decision["id"], "applies_to", scope=scope,
                          evidence=evidence, op_id=f"{op_id}:target:{target}")
            self.db.execute("INSERT OR IGNORE INTO event_distillations VALUES(?,?,?)",
                            (intent_id, decision["id"], utc_now()))
        return decision

    def retarget_decision(self, node_id: str, purpose_id: str, *,
                          base_version: int, reason: str,
                          evidence: str | None = None,
                          op_id: str | None = None) -> dict[str, Any]:
        """Correct a decision's purpose and its graph edge in one audited change."""
        if not reason.strip():
            raise MindwiseError("Retargeting needs a reason")
        purpose = self.node(purpose_id)
        if purpose["kind"] not in {"strategy", "deliverable"}:
            raise MindwiseError("A decision purpose must be a strategy or deliverable")
        op_id = op_id or str(uuid.uuid4())
        with self.db:
            previous = self.db.execute("SELECT * FROM events WHERE op_id=?", (op_id,)).fetchone()
            if previous:
                before = json.loads(previous["before_json"] or "null")
                after = json.loads(previous["after_json"] or "null")
                if (previous["kind"] != "node_upsert" or previous["node_id"] != node_id
                        or not before or not after or before["version"] != base_version
                        or after["strategy_ref"] != purpose_id
                        or previous["reason"] != reason
                        or previous["evidence"] != evidence):
                    raise Conflict("Operation ID belongs to a different decision correction")
                return self.node(node_id)
            node = self.node(node_id)
            if node["kind"] != "decision" or node["authority"] != "agent":
                raise BoundaryError("Only an operational decision may be retargeted")
            if node["version"] != base_version:
                raise Conflict(f"Expected version {base_version}; current version is {node['version']}")
            old_purpose = node["strategy_ref"]
            if old_purpose == purpose_id:
                return node
            old_edge = self.db.execute(
                "SELECT * FROM edges WHERE source_id=? AND target_id=? AND kind='specifies'",
                (node_id, old_purpose),
            ).fetchone()
            if not old_edge:
                raise Conflict("Decision purpose edge is missing")
            if self.db.execute(
                "SELECT 1 FROM edges WHERE source_id=? AND target_id=? AND kind='specifies'",
                (node_id, purpose_id),
            ).fetchone():
                raise Conflict("New decision purpose edge already exists")
            self.db.execute("UPDATE nodes SET strategy_ref=?,version=version+1,updated_at=? WHERE id=?",
                            (purpose_id, utc_now(), node_id))
            updated = self.node(node_id)
            self._event(op_id, node_id, "agent", None, "node_upsert", node,
                        updated, reason, evidence)
            self.db.execute(
                "DELETE FROM edges WHERE source_id=? AND target_id=? AND kind='specifies'",
                (node_id, old_purpose),
            )
            self._event(f"{op_id}:old-purpose", node_id, "agent", None,
                        "edge_remove", dict(old_edge), None, reason, evidence)
            new_edge = {"source_id": node_id, "target_id": purpose_id,
                        "kind": "specifies", "scope": node["scope"],
                        "evidence": evidence or old_edge["evidence"],
                        "created_at": utc_now()}
            self.db.execute("INSERT INTO edges VALUES(?,?,?,?,?,?)", tuple(new_edge.values()))
            self._event(f"{op_id}:new-purpose", node_id, "agent", None,
                        "edge_add", None, new_edge, reason, evidence)
        return updated

    def update_decision(self, node_id: str, *, title: str, choice: str,
                        reason: str, alternatives: list[dict[str, str]],
                        reconsider_when: str | None, base_version: int,
                        op_id: str | None = None,
                        preview: bool = False, actor: str = "agent") -> dict[str, Any]:
        node = self.node(node_id)
        if node["kind"] != "decision":
            raise MindwiseError("Selected node is not a decision")
        if not choice.strip() or not reason.strip():
            raise MindwiseError("A decision needs a choice and reason")
        if not isinstance(alternatives, list) or any(
            not isinstance(item, dict) or
            not isinstance(item.get("option"), str) or
            not isinstance(item.get("reason"), str) or
            not item["option"].strip() or not item["reason"].strip()
            for item in alternatives
        ):
            raise MindwiseError("Each alternative needs an option and rejection reason")
        body = json.dumps({"choice": choice, "reason": reason,
                           "alternatives": alternatives,
                           "reconsider_when": reconsider_when},
                          ensure_ascii=False, sort_keys=True)
        if op_id and not preview:
            repeated = self.repeated_upsert(
                op_id, node_id, title=title, body=body,
                base_version=base_version, reason=reason)
            if repeated is not None:
                return repeated
        proposed = self.preview_text_update(node_id, title=title, body=body,
                                            base_version=base_version,
                                            allow_structured=True)
        if preview or not proposed["changes"]:
            return proposed if preview else node
        return self.upsert_node(
            node_id=node_id, kind="decision", title=title, body=body,
            authority=node["authority"], knowledge="decision", freshness="unverified",
            application="adopted", scope=node["scope"],
            strategy_ref=node["strategy_ref"], actor=actor, reason=reason,
            base_version=base_version, op_id=op_id)

    def preview_text_update(self, node_id: str, *, title: str, body: str,
                            base_version: int,
                            allow_structured: bool = False) -> dict[str, Any]:
        old = self.node(node_id)
        if old["version"] != base_version:
            raise Conflict(f"Expected version {base_version}; current version is {old['version']}")
        if old["authority"] == "contract":
            raise BoundaryError("Contract changes must be made through the source contract")
        if old["kind"] in {"task", "metric", "decision", "location", "verification"} and not allow_structured:
            raise MindwiseError("Structured nodes require their typed update command")
        changes = {key: {"before": old[key], "after": value}
                   for key, value in (("title", title), ("body", body))
                   if old[key] != value}
        impact = self.impact_report(node_id)
        return {"node_id": node_id, "base_version": base_version,
                "changes": changes, "affected": impact["affected"],
                "exceptions": impact["exceptions"],
                "map_only": True,
                "next_application": "adopted" if old["application"] in
                {"implemented", "verified"} else old["application"]}

    def update_text(self, node_id: str, *, title: str, body: str,
                    base_version: int, reason: str, evidence: str | None = None,
                    actor: str = "agent", op_id: str | None = None) -> dict[str, Any]:
        if not reason.strip():
            raise MindwiseError("An update needs a reason")
        if op_id:
            repeated = self.repeated_upsert(
                op_id, node_id, title=title, body=body,
                base_version=base_version, reason=reason, evidence=evidence)
            if repeated is not None:
                return repeated
        preview = self.preview_text_update(node_id, title=title, body=body,
                                           base_version=base_version)
        if not preview["changes"]:
            return self.node(node_id)
        old = self.node(node_id)
        return self.upsert_node(
            node_id=node_id, kind=old["kind"], title=title, body=body,
            authority=old["authority"], knowledge=old["knowledge"],
            freshness="unverified", application=preview["next_application"],
            scope=old["scope"], strategy_ref=old["strategy_ref"],
            actor=actor, reason=reason, evidence=evidence,
            base_version=base_version, op_id=op_id)

    def search(self, query: str, *, limit: int = 20) -> list[dict[str, Any]]:
        if not query.strip():
            return []
        escaped = query.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        rows = self.db.execute(
            "SELECT * FROM nodes WHERE application != 'retired' AND "
            "(title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\') "
            "ORDER BY CASE WHEN title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, updated_at DESC LIMIT ?",
            (f"%{escaped}%", f"%{escaped}%", f"%{escaped}%", limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def neighbors(self, node_id: str) -> list[dict[str, Any]]:
        self.node(node_id)
        rows = self.db.execute(
            "SELECT * FROM edges WHERE source_id=? OR target_id=? ORDER BY kind,target_id",
            (node_id, node_id),
        ).fetchall()
        return [dict(row) for row in rows]

    def trace(self, node_id: str, *, max_depth: int = 6,
              max_nodes: int = 100) -> dict[str, Any]:
        """Follow explicit design links toward reasons and toward realizations."""
        if not 1 <= max_depth <= 12 or not 1 <= max_nodes <= 500:
            raise MindwiseError("Trace limits are out of range")
        start = self.node(node_id)
        kinds = ("contributes", "specifies", "depends_on", "applies_to",
                 "implements", "verifies", "locates")
        result: dict[str, Any] = {"start": self._trace_node(start),
                                  "upstream": [], "downstream": [],
                                  "truncated": False, "depth_limited": False}
        remaining = max_nodes
        for direction in ("upstream", "downstream"):
            visited = {node_id}
            queue: list[tuple[str, list[dict[str, Any]]]] = [(node_id, [])]
            while queue and remaining:
                current, path = queue.pop(0)
                column = "source_id" if direction == "upstream" else "target_id"
                edges = self.db.execute(
                    f"SELECT * FROM edges WHERE {column}=? AND kind IN "
                    "('contributes','specifies','depends_on','applies_to',"
                    "'implements','verifies','locates') ORDER BY kind,source_id,target_id",
                    (current,),
                ).fetchall()
                if len(path) >= max_depth:
                    if edges:
                        result["depth_limited"] = True
                    continue
                for edge in edges:
                    if edge["kind"] not in kinds:
                        continue
                    other = edge["target_id"] if direction == "upstream" else edge["source_id"]
                    if other in visited:
                        continue
                    if not remaining:
                        result["truncated"] = True
                        break
                    visited.add(other)
                    next_path = path + [{"source_id": edge["source_id"],
                                         "target_id": edge["target_id"],
                                         "kind": edge["kind"], "scope": edge["scope"],
                                         "evidence": edge["evidence"]}]
                    result[direction].append({"node": self._trace_node(self.node(other)),
                                              "path": next_path})
                    queue.append((other, next_path))
                    remaining -= 1
            if queue and not remaining:
                result["truncated"] = True
        return result

    @staticmethod
    def _trace_node(node: dict[str, Any]) -> dict[str, Any]:
        details = None
        if node["kind"] == "decision":
            try:
                details = json.loads(node["body"])
            except (json.JSONDecodeError, TypeError):
                pass
        return {"id": node["id"], "title": node["title"], "kind": node["kind"],
                "knowledge": node["knowledge"], "freshness": node["freshness"],
                "application": node["application"],
                "strategy_ref": node["strategy_ref"],
                "reason": details.get("reason") if isinstance(details, dict) else None}

    def history(self, node_id: str) -> list[dict[str, Any]]:
        self.node(node_id)
        return [dict(row) for row in self.db.execute(
            "SELECT * FROM events WHERE node_id=? ORDER BY sequence DESC", (node_id,))]

    def record_event(self, *, op_id: str, kind: str, actor: str,
                     session_id: str | None = None, node_id: str | None = None,
                     reason: str | None = None, evidence: str | None = None,
                     details: dict[str, Any] | None = None) -> bool:
        """Receive a durable fact without inventing a decision or rationale.

        Returns True only if this operation was newly persisted. A hook can retry
        the same operation after an uncertain transport result.
        """
        if not op_id.strip() or not kind.strip():
            raise MindwiseError("An event needs an operation ID and kind")
        if node_id is not None:
            self.node(node_id)
        with self._transaction():
            previous = self.db.execute("SELECT * FROM events WHERE op_id=?",
                                       (op_id,)).fetchone()
            if previous:
                if (previous["kind"] != kind or previous["actor"] != actor
                        or previous["session_id"] != session_id
                        or previous["node_id"] != node_id
                        or previous["reason"] != reason
                        or previous["evidence"] != evidence
                        or json.loads(previous["after_json"] or "null") != (details or {})):
                    raise Conflict("Operation ID belongs to a different event")
                return False
            self._event(op_id, node_id, actor, session_id, kind, None,
                        details or {}, reason, evidence)
        return True

    def recent_events(self, limit: int = 10) -> list[dict[str, Any]]:
        return [dict(row) for row in self.db.execute(
            "SELECT * FROM events ORDER BY sequence DESC LIMIT ?", (limit,))]

    def pending_events(self, limit: int = 50) -> list[dict[str, Any]]:
        return [dict(row) for row in self.db.execute(
            f"SELECT e.* FROM events e WHERE {PENDING_EVENT_FILTER} "
            "ORDER BY e.sequence LIMIT ?", (limit,))]

    @staticmethod
    def validate_pending_page(limit: int, after_sequence: int) -> None:
        if type(limit) is not int or not 1 <= limit <= 200:
            raise MindwiseError("Pending event limit must be an integer from 1 to 200")
        if type(after_sequence) is not int or not 0 <= after_sequence <= 2**63 - 1:
            raise MindwiseError("after-sequence must be a nonnegative SQLite sequence integer")

    def pending_events_for_subject(self, subject_id: str, *, limit: int = 50,
                                   after_sequence: int = 0) -> dict[str, Any]:
        """Page pending observations by their recorded node ID, without inference.

        The total covers the whole subject; remaining_count covers the unread tail.
        Counts and events share a read snapshot. Raw event fields stay untouched.
        """
        self.validate_pending_page(limit, after_sequence)
        predicate = f"({PENDING_EVENT_FILTER}) AND e.node_id=?"
        with self._transaction():
            self.node(subject_id)
            counts = self.db.execute(
                "SELECT count(*), coalesce(sum(e.sequence > ?),0) FROM events e "
                f"WHERE {predicate}", (after_sequence, subject_id)).fetchone()
            events = [dict(row) for row in self.db.execute(
                f"SELECT e.* FROM events e WHERE {predicate} AND e.sequence > ? "
                "ORDER BY e.sequence LIMIT ?", (subject_id, after_sequence, limit))]
        remaining = int(counts[1]) - len(events)
        next_sequence = events[-1]["sequence"] if remaining else None
        return {"subject_id": subject_id, "total_pending": int(counts[0]),
                "events": events, "limit": limit, "after_sequence": after_sequence,
                "returned_count": len(events), "remaining_count": remaining,
                "truncated": remaining > 0, "next_after_sequence": next_sequence,
                "retrieve_more": ({"command": "pending-events", "topic": subject_id,
                                   "limit": limit, "after_sequence": next_sequence}
                                  if remaining else None)}

    def distill_events(self, *, title: str, summary: str,
                       source_op_ids: list[str], reason: str,
                       topic_id: str | None = None, op_id: str | None = None,
                       actor: str = "agent") -> dict[str, Any]:
        sources = list(dict.fromkeys(source_op_ids))
        if not title.strip() or not summary.strip() or not reason.strip() or not sources:
            raise MindwiseError("Distillation needs a title, summary, reason, and source events")
        if topic_id:
            self.node(topic_id)
        for source in sources:
            event = self.db.execute("SELECT kind FROM events WHERE op_id=?", (source,)).fetchone()
            if not event or event["kind"] in {
                "context_offered", "context_acknowledged", "node_upsert", "edge_add"
            }:
                raise MindwiseError(f"Not a source observation event: {source}")
        op_id = op_id or str(uuid.uuid4())
        body = json.dumps({"summary": summary, "source_events": sources,
                           "topic_id": topic_id}, ensure_ascii=False, sort_keys=True)
        previous = self.db.execute(
            "SELECT node_id,kind FROM events WHERE op_id=?", (op_id,)
        ).fetchone()
        if previous:
            if previous["kind"] != "node_upsert" or not previous["node_id"]:
                raise Conflict("Operation ID belongs to a different event")
            original = self.node(previous["node_id"])
            if original["kind"] != "insight" or original["title"] != title or original["body"] != body:
                raise Conflict("Operation ID belongs to a different insight")
        with self._transaction():
            insight = self.upsert_node(
                kind="insight", title=title, body=body,
                knowledge="hypothesis", freshness="unverified", application="proposed",
                actor=actor, reason=reason, evidence=",".join(sources), op_id=op_id)
            for source in sources:
                self.db.execute(
                    "INSERT OR IGNORE INTO event_distillations VALUES(?,?,?)",
                    (source, insight["id"], utc_now()))
            if topic_id:
                self.link(topic_id, insight["id"], "parent_of",
                          evidence="Subject grouping from source events",
                          actor=actor, op_id=f"{op_id}:topic")
        return insight

    def semantic_sequence(self) -> int:
        row = self.db.execute(
            "SELECT coalesce(max(sequence),0) FROM events WHERE kind IN "
            "('node_upsert','edge_add','edge_remove','dependency_stale','anchor_stale',"
            "'anchor_node_status',"
            "'anchor_registered')"
        ).fetchone()
        return int(row[0])

    def _handoff_snapshot(self) -> tuple[str, str]:
        path = checked_path(self.root, "HANDOFF.md", must_exist=False)
        try:
            raw = path.read_bytes()
            return raw.decode("utf-8-sig"), hashlib.sha256(raw).hexdigest()
        except (OSError, UnicodeError):
            return "", "unavailable"

    def context_generation(self, handoff_fingerprint: str | None = None) -> str:
        """Track map and pending fact changes, excluding delivery bookkeeping."""
        row = self.db.execute(
            "SELECT coalesce(max(sequence),0) FROM events WHERE kind NOT IN "
            "('session_start','session_end','SessionStart','SessionEnd','PostToolUse',"
            "'context_offered','context_acknowledged','selection_requested',"
            "'selection_offered','selection_acknowledged')"
        ).fetchone()
        if handoff_fingerprint is None:
            _, handoff_fingerprint = self._handoff_snapshot()
        return hashlib.sha256(json.dumps([int(row[0]), handoff_fingerprint]).encode()).hexdigest()[:24]

    def activate_session(self, session_id: str, activation: str) -> str:
        # Keep one run token while the session is active. A resumed Codex session
        # gets a new token after SessionEnd removes its previous row.
        generation = f"{activation}|{uuid.uuid4().hex}"
        with self.db:
            self.db.execute(
                "INSERT INTO active_sessions VALUES(?,?,?) ON CONFLICT(session_id) "
                "DO UPDATE SET activated_at=excluded.activated_at",
                (session_id, generation, utc_now()))
            row = self.db.execute(
                "SELECT activation FROM active_sessions WHERE session_id=?",
                (session_id,)).fetchone()
        return str(row["activation"])

    def session_generation(self, session_id: str | None) -> str | None:
        if not self.is_active_session(session_id):
            return None
        row = self.db.execute(
            "SELECT activation FROM active_sessions WHERE session_id=?",
            (session_id,)).fetchone()
        return str(row["activation"]) if row else None

    def deactivate_session(self, session_id: str) -> None:
        with self.db:
            self.db.execute("DELETE FROM active_sessions WHERE session_id=?", (session_id,))

    def active_session_ids(self) -> list[str]:
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)).isoformat(timespec="seconds")
        return [row["session_id"] for row in self.db.execute(
            "SELECT session_id FROM active_sessions WHERE activated_at>=? "
            "ORDER BY activated_at DESC,session_id", (cutoff,))]

    def is_active_session(self, session_id: str | None) -> bool:
        return bool(session_id and session_id in self.active_session_ids())

    def offer_context(self, *, bundle_id: str, session_id: str | None,
                      node_ids: list[str], generation: str | None = None,
                      epoch: str | None = None) -> None:
        self.record_event(op_id=f"context-offer:{bundle_id}",
                          kind="context_offered", actor="mindwise",
                          session_id=session_id,
                          details={"bundle_id": bundle_id, "node_ids": node_ids,
                                   "session_generation": self.session_generation(session_id),
                                   "generation": generation or self.context_generation(), "epoch": epoch,
                                   "node_versions": {node_id: self.node(node_id)["version"]
                                                     for node_id in node_ids}})

    def deliver_context(self, *, session_id: str | None = None,
                        request_id: str | None = None, query: str | None = None,
                        max_chars: int = 2400, epoch: str | None = None) -> dict[str, Any]:
        """Return a bounded, version-bound offer that the receiver can acknowledge."""
        with self._transaction():
            context = self.context(query=query, max_chars=max_chars, bundle_id="0" * 24,
                                   epoch=epoch)
            identity = json.dumps([self.id, session_id, request_id, query, max_chars,
                                   context["generation"], epoch, self.session_generation(session_id)], ensure_ascii=False)
            bundle_id = (hashlib.sha256(identity.encode()).hexdigest()[:24]
                         if request_id is not None else uuid.uuid4().hex[:24])
            context["bundle_id"] = bundle_id
            self.offer_context(bundle_id=bundle_id, session_id=session_id,
                               node_ids=[item["id"] for item in context["items"]],
                               generation=context["generation"], epoch=epoch)
        return context

    def acknowledge_context(self, *, bundle_id: str) -> bool:
        offered = self.db.execute(
            "SELECT session_id FROM events WHERE op_id=? AND kind='context_offered'",
            (f"context-offer:{bundle_id}",)
        ).fetchone()
        if not offered:
            raise MindwiseError("Unknown context bundle")
        return self.record_event(op_id=f"context-ack:{bundle_id}",
                                 kind="context_acknowledged", actor="codex",
                                 session_id=offered["session_id"],
                                 details={"bundle_id": bundle_id})

    def context_delivery_status(self, session_id: str | None = None) -> dict[str, Any]:
        offered = self.db.execute(
            "SELECT * FROM events WHERE kind='context_offered' "
            + ("AND session_id=? " if session_id is not None else "")
            + "ORDER BY sequence DESC LIMIT 1",
            (session_id,) if session_id is not None else (),
        ).fetchone()
        if not offered:
            return {"status": "never_offered"}
        details = json.loads(offered["after_json"])
        bundle_id = details["bundle_id"]
        acknowledged = self.db.execute(
            "SELECT occurred_at FROM events WHERE kind='context_acknowledged' "
            "AND json_extract(after_json,'$.bundle_id')=? ORDER BY sequence DESC LIMIT 1",
            (bundle_id,),
        ).fetchone()
        return {"status": "acknowledged" if acknowledged else "offered_unconfirmed",
                "session_id": offered["session_id"], "generation": details.get("generation"),
                "epoch": details.get("epoch"),
                "bundle_id": bundle_id, "offered_at": offered["occurred_at"],
                "acknowledged_at": acknowledged["occurred_at"] if acknowledged else None}

    def health(self) -> dict[str, Any]:
        hook = self.db.execute(
            "SELECT kind,occurred_at FROM events WHERE actor='codex_hook' "
            "ORDER BY sequence DESC LIMIT 1"
        ).fetchone()
        schema = self.db.execute(
            "SELECT value FROM metadata WHERE key='schema'"
        ).fetchone()[0]
        return {"project_id": self.id, "root": str(self.root),
                "storage": str(self.db_path), "schema": schema,
                "integrity": self.db.execute("PRAGMA integrity_check").fetchone()[0],
                "last_hook_event": dict(hook) if hook else None,
                "active_session_count": len(self.active_session_ids()),
                "context_delivery": self.context_delivery_status(),
                "pending_events": self.db.execute(
                    f"SELECT count(*) FROM events e WHERE {PENDING_EVENT_FILTER}"
                ).fetchone()[0],
                "plugin_trust": "not_observable_from_project_store"}

    def impact(self, node_id: str) -> list[dict[str, Any]]:
        return self.impact_report(node_id)["affected"]

    def impact_report(self, node_id: str) -> dict[str, list[dict[str, Any]]]:
        """Find branches that need rechecking after this node changes.

        Edges point from a derived/dependent branch to its prerequisite. Explicit
        exceptions are excluded from automatic propagation and listed separately.
        """
        self.node(node_id)
        visited = {node_id}
        frontier = [node_id]
        result: list[dict[str, Any]] = []
        exceptions: list[dict[str, Any]] = []
        while frontier:
            target = frontier.pop(0)
            for row in self.db.execute(
                "SELECT source_id,kind,scope FROM edges WHERE target_id=? AND kind IN "
                "('depends_on','specifies','contributes','implements','verifies','applies_to') "
                "ORDER BY kind,source_id",
                (target,),
            ):
                source = row["source_id"]
                exception = (self.db.execute(
                    "SELECT evidence FROM edges WHERE source_id=? AND target_id=? "
                    "AND kind='exception_to'", (source, target)
                ).fetchone() if row["kind"] == "applies_to" else None)
                if exception:
                    exceptions.append({"node": self.node(source), "via": target,
                                       "relation": row["kind"], "scope": row["scope"],
                                       "reason": exception["evidence"]})
                    continue
                if source in visited:
                    continue
                visited.add(source)
                frontier.append(source)
                result.append({"node": self.node(source), "via": target,
                               "relation": row["kind"], "scope": row["scope"]})
        return {"affected": result, "exceptions": exceptions}

    def context(self, *, query: str | None = None, max_chars: int = 2400,
                bundle_id: str | None = None, epoch: str | None = None) -> dict[str, Any]:
        """Bound the starting bundle independently of total map size."""
        if max_chars < 500:
            raise MindwiseError("The context budget must be at least 500 characters")
        total_active = self.db.execute(
            "SELECT count(*) FROM nodes WHERE application != 'retired'"
        ).fetchone()[0]
        goal_candidates = [dict(row) for row in self.db.execute(
            "SELECT * FROM nodes WHERE authority='contract' AND kind='strategy' "
            "AND application='adopted' AND strategy_ref LIKE 'GOAL.md:%'"
        )]
        goal = min(goal_candidates, key=lambda node: int(
            node["strategy_ref"].split(":", 1)[1].split("@", 1)[0]
        )) if goal_candidates else None
        candidates = self.search(query, limit=30) if query else [dict(row) for row in self.db.execute(
            "SELECT * FROM nodes WHERE application != 'retired' "
            "ORDER BY CASE WHEN kind='decision' THEN 0 WHEN kind='insight' THEN 1 "
            "WHEN freshness='stale' THEN 2 WHEN authority='contract' THEN 3 ELSE 4 END, "
            "updated_at DESC LIMIT 30"
        )]
        if goal and not query:
            candidates = [goal] + [item for item in candidates if item["id"] != goal["id"]]
        candidates = candidates[:12]
        position = next_action = None
        handoff_text, handoff_fingerprint = self._handoff_snapshot()
        if handoff_text:
            try:
                found = re.search(r"^\s*-\s*\*\*現在地\*\*:\s*(.+)$",
                                  handoff_text, re.MULTILINE)
                position = found.group(1).strip()[:120] if found else None
                found = re.search(r"^##\s*次の一手\s*\n+\s*(.+)$",
                                  handoff_text, re.MULTILINE)
                next_action = found.group(1).strip()[:120] if found else None
            except (OSError, UnicodeError):
                pass
        latest = self.db.execute(
            "SELECT kind,node_id,reason FROM events WHERE kind IN "
            "('node_upsert','dependency_stale','anchor_stale','anchor_node_status') "
            "AND actor != 'contract_import' "
            "ORDER BY sequence DESC LIMIT 1"
        ).fetchone()
        goal_text = (next((line.strip() for line in goal["body"].splitlines()
                           if line.strip()), goal["title"]) if goal else None)
        orientation = {"goal": goal_text[:160] if goal_text else None,
                       "goal_source": goal["strategy_ref"] if goal else None,
                       "position": position, "next_action": next_action,
                       "stale_count": self.db.execute(
                           "SELECT count(*) FROM nodes WHERE freshness='stale' "
                           "AND application != 'retired'").fetchone()[0],
                       "recent_change": ({"kind": latest["kind"], "node_id": latest["node_id"],
                                          "reason": (latest["reason"] or "")[:80]}
                                         if latest else None)}
        bundle: list[dict[str, Any]] = []
        used = 0
        # Leave room for envelope fields and a short pointer to omitted results.
        item_budget = max_chars - 480
        for node in candidates:
            item = {"id": node["id"], "title": node["title"],
                    "version": node["version"],
                    "summary": node["body"][:220], "freshness": node["freshness"],
                    "knowledge": node["knowledge"], "source": node["strategy_ref"]}
            serialized = json.dumps(item, ensure_ascii=False)
            if used + len(serialized) <= item_budget:
                bundle.append(item)
                used += len(serialized)
        omitted_count = max(0, total_active - len(bundle))
        pending = self.db.execute(
            f"SELECT count(*) FROM events e WHERE {PENDING_EVENT_FILTER}"
        ).fetchone()[0]
        output = {"project_id": self.id, "generation": self.context_generation(handoff_fingerprint),
                "orientation": orientation,
                "items": bundle, "total_active": total_active,
                "omitted_count": omitted_count,
                "retrieve_more": "search or show by node ID" if omitted_count else None,
                "unorganized_events": pending, "size_characters": used,
                "max_characters": max_chars}
        if bundle_id is not None:
            output["bundle_id"] = bundle_id
        if epoch is not None:
            output["epoch"] = epoch
        # JSON representation, rather than only item text, is the actual context cost.
        while bundle and len(json.dumps(output, ensure_ascii=False)) > max_chars:
            bundle.pop()
            output["omitted_count"] += 1
            output["retrieve_more"] = "search or show by node ID"
            output["size_characters"] = sum(len(json.dumps(item, ensure_ascii=False)) for item in bundle)
        for field in ("recent_change", "position", "next_action", "goal_source", "goal", "stale_count"):
            if len(json.dumps(output, ensure_ascii=False)) <= max_chars:
                break
            orientation[field] = None
        return output

    def anchor(self, node_id: str, relative_path: str) -> dict[str, Any]:
        self.node(node_id)
        path = checked_path(self.root, relative_path)
        if not path.is_file():
            raise MindwiseError("Anchors currently require a file")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rel = str(path.relative_to(self.root))
        stamp = utc_now()
        with self.db:
            old = self.db.execute(
                "SELECT * FROM anchors WHERE node_id=? AND path=?", (node_id, rel)
            ).fetchone()
            self.db.execute(
                "INSERT INTO anchors VALUES(?,?,?,?,?) ON CONFLICT(node_id,path) DO UPDATE "
                "SET sha256=excluded.sha256,checked_at=excluded.checked_at,status=excluded.status",
                (node_id, rel, digest, stamp, "current"),
            )
            if old is None or old["sha256"] != digest or old["status"] != "current":
                self._event("anchor:" + str(uuid.uuid4()), node_id, "agent", None,
                            "anchor_registered", dict(old) if old else None,
                            {"path": rel, "sha256": digest, "status": "current"},
                            "Explicit file anchor registration", rel)
        return {"node_id": node_id, "path": rel, "sha256": digest,
                "checked_at": stamp, "status": "current"}

    def rebind_anchor(self, node_id: str, old_path: str, new_path: str, *,
                      reason: str, op_id: str | None = None) -> dict[str, Any]:
        """Follow a moved file only when its content matches the recorded file."""
        self.node(node_id)
        if not reason.strip():
            raise MindwiseError("Moving an anchor needs a reason")
        old = str(checked_path(self.root, old_path, must_exist=False).relative_to(self.root))
        target = checked_path(self.root, new_path)
        if not target.is_file():
            raise MindwiseError("New anchor target is not a file")
        new = str(target.relative_to(self.root))
        if old == new:
            raise MindwiseError("Old and new anchor paths are the same")
        if op_id:
            previous = self.db.execute("SELECT * FROM events WHERE op_id=?", (op_id,)).fetchone()
            if previous:
                before = json.loads(previous["before_json"] or "null")
                after = json.loads(previous["after_json"] or "null")
                if (previous["kind"] != "anchor_rebound" or previous["node_id"] != node_id
                        or previous["reason"] != reason or not before or not after
                        or before["path"] != old or after["path"] != new):
                    raise Conflict("Operation ID belongs to a different anchor change")
                return after
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        row = self.db.execute("SELECT * FROM anchors WHERE node_id=? AND path=?",
                              (node_id, old)).fetchone()
        if not row:
            raise MindwiseError("Original anchor is not registered")
        if digest != row["sha256"]:
            raise Conflict("Moved file content differs from the recorded anchor")
        if self.db.execute("SELECT 1 FROM anchors WHERE node_id=? AND path=?",
                           (node_id, new)).fetchone():
            raise Conflict("New anchor path is already registered")
        stamp = utc_now()
        after = {"node_id": node_id, "path": new, "sha256": digest,
                 "checked_at": stamp, "status": "current"}
        with self.db:
            self.db.execute("UPDATE anchors SET path=?,checked_at=?,status='current' "
                            "WHERE node_id=? AND path=?", (new, stamp, node_id, old))
            self._event(op_id or "anchor-rebind:" + str(uuid.uuid4()), node_id,
                        "agent", None, "anchor_rebound", dict(row), after,
                        reason, new)
        return after

    def observe_anchor(self, row: sqlite3.Row | dict[str, Any]) -> str:
        """Read the current fingerprint without changing stored evidence."""
        return self._observe_anchor(row)["status"]

    def _observe_anchor(self, row: sqlite3.Row | dict[str, Any]) -> dict[str, Any]:
        try:
            path = checked_path(self.root, row["path"])
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            return {"sha256": digest,
                    "status": "current" if digest == row["sha256"] else "stale"}
        except (BoundaryError, FileNotFoundError, OSError):
            return {"sha256": None, "status": "unverified"}

    def reconcile_anchors(self, *, session_id: str | None = None) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM anchors ORDER BY node_id,path").fetchall()
        observed = [(row, self._observe_anchor(row)) for row in rows]
        results = [{"node_id": row["node_id"], "path": row["path"],
                    "status": snapshot["status"]} for row, snapshot in observed]
        grouped: dict[str, list[str]] = {}
        for row, snapshot in observed:
            grouped.setdefault(row["node_id"], []).append(snapshot["status"])
        with self._transaction():
            for row, snapshot in observed:
                # Compare with the last observation, not only the approved anchor:
                # another edit while stale must still remain recoverable.
                last = self.db.execute(
                    "SELECT after_json FROM events WHERE node_id=? AND evidence=? "
                    "AND kind IN ('anchor_registered','anchor_rebound','anchor_observed') "
                    "ORDER BY sequence DESC LIMIT 1", (row["node_id"], row["path"]),
                ).fetchone()
                previous = json.loads(last["after_json"]) if last else None
                if not isinstance(previous, dict):
                    previous = {"sha256": row["sha256"], "status": "current"}
                before = {key: previous.get(key) for key in ("sha256", "status")}
                if before != snapshot:
                    self._event(
                        "anchor-observed:" + str(uuid.uuid4()), row["node_id"],
                        "mindwise", session_id, "anchor_observed", before,
                        {**snapshot, "path": row["path"],
                         "recorded_sha256": row["sha256"], "reason_status": "unknown"},
                        None, row["path"],
                    )
                status = snapshot["status"]
                if status == row["status"]:
                    continue
                self.db.execute("UPDATE anchors SET status=? WHERE node_id=? AND path=?",
                                (status, row["node_id"], row["path"]))
                self._event("anchor-change:" + str(uuid.uuid4()), row["node_id"],
                            "mindwise", None, "anchor_stale", dict(row),
                            {"status": status}, "Linked file status changed", row["path"])
            for node_id, statuses in grouped.items():
                desired = ("unverified" if "unverified" in statuses else
                           "stale" if "stale" in statuses else "current")
                if desired == "current":
                    # A restored fingerprint does not revalidate its meaning.
                    continue
                old = self.node(node_id)
                if old["authority"] == "contract":
                    continue
                application = ("implemented" if old["application"] == "verified"
                               else old["application"])
                if old["freshness"] == desired and old["application"] == application:
                    continue
                self.db.execute(
                    "UPDATE nodes SET freshness=?,application=?,version=version+1,updated_at=? "
                    "WHERE id=?", (desired, application, utc_now(), node_id),
                )
                op_id = "anchor-node:" + str(uuid.uuid4())
                self._event(op_id, node_id, "mindwise", None,
                            "anchor_node_status", old, self.node(node_id),
                            "Registered file changed or became inaccessible", None)
                self._invalidate_dependents(node_id, op_id,
                                            "Registered file changed or became inaccessible")
        return results

    def export(self) -> dict[str, Any]:
        return {
            "schema": 2, "project_id": self.id, "root": str(self.root),
            "nodes": [dict(row) for row in self.db.execute("SELECT * FROM nodes ORDER BY id")],
            "edges": [dict(row) for row in self.db.execute(
                "SELECT * FROM edges ORDER BY source_id,target_id,kind")],
            "anchors": [dict(row) for row in self.db.execute(
                "SELECT * FROM anchors ORDER BY node_id,path")],
            "events": [dict(row) for row in self.db.execute(
                "SELECT * FROM events ORDER BY sequence")],
            "event_distillations": [dict(row) for row in self.db.execute(
                "SELECT * FROM event_distillations ORDER BY event_op_id,insight_id")],
        }

    def import_snapshot(self, payload: dict[str, Any]) -> dict[str, int]:
        """Import a public JSON export only into an empty registered store."""
        if (not isinstance(payload, dict) or type(payload.get("schema")) is not int
                or payload.get("schema") not in {1, 2}
                or payload.get("project_id") != self.id
                or payload.get("root") != str(self.root)):
            raise MindwiseError("Export belongs to a different project or schema")
        tables = {
            "nodes": ("id", "kind", "title", "body", "authority", "knowledge",
                      "freshness", "application", "scope", "strategy_ref", "version",
                      "created_at", "updated_at"),
            "edges": ("source_id", "target_id", "kind", "scope", "evidence", "created_at"),
            "anchors": ("node_id", "path", "sha256", "checked_at", "status"),
            "events": ("sequence", "op_id", "node_id", "actor", "session_id", "kind",
                       "before_json", "after_json", "reason", "evidence", "occurred_at"),
            "event_distillations": ("event_op_id", "insight_id", "created_at"),
        }
        rows: dict[str, list[dict[str, Any]]] = {}
        for table, fields in tables.items():
            incoming = payload.get(table, [] if table == "event_distillations" else None)
            if not isinstance(incoming, list) or len(incoming) > 1_000_000:
                raise MindwiseError(f"Invalid {table} export section")
            if any(not isinstance(item, dict) or set(item) != set(fields)
                   for item in incoming):
                raise MindwiseError(f"Invalid {table} export row")
            rows[table] = incoming
        for anchor in rows["anchors"]:
            if not isinstance(anchor["path"], str):
                raise MindwiseError("Invalid anchor path")
            checked_path(self.root, anchor["path"], must_exist=False)
        if (any(not isinstance(item["id"], str) for item in rows["nodes"])
                or any(not isinstance(item["op_id"], str) for item in rows["events"])):
            raise MindwiseError("Invalid export identifiers")
        if any(self.db.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone()
               for table in tables):
            raise MindwiseError("JSON import requires an empty registered store")
        try:
            with self.db:
                for table, fields in tables.items():
                    placeholders = ",".join("?" for _ in fields)
                    self.db.executemany(
                        f"INSERT INTO {table}({','.join(fields)}) VALUES({placeholders})",
                        [tuple(item[field] for field in fields) for item in rows[table]],
                    )
                violations = self.db.execute("PRAGMA foreign_key_check").fetchall()
                if violations:
                    raise MindwiseError("Export has broken references")
                if self.db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise MindwiseError("Export failed the database integrity check")
        except sqlite3.Error as exc:
            raise MindwiseError(f"Invalid export: {exc}") from exc
        return {table: len(items) for table, items in rows.items()}
