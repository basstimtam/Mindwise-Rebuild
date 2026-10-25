"""Version-bound test observations for registered project artifacts."""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from .core import Conflict, MindwiseError, Store, checked_path, utc_now
from .locations import SECRET_LITERAL


def record(store: Store, *, target_id: str, title: str, method: str,
           outcome: str, evidence_file: str, reason: str,
           op_id: str | None = None) -> dict[str, Any]:
    """Record a test result against the present target version and file fingerprints."""
    if not all(value.strip() for value in (title, method, evidence_file, reason)):
        raise MindwiseError("Verification needs a title, method, result file, and reason")
    if outcome not in {"pass", "fail"}:
        raise MindwiseError("Verification outcome must be pass or fail")
    if SECRET_LITERAL.search(method):
        raise MindwiseError("Verification method must not contain credential values")
    relative_file = str(checked_path(store.root, evidence_file, must_exist=False)
                        .relative_to(store.root))
    if op_id:
        previous = store.db.execute("SELECT * FROM events WHERE op_id=?", (op_id,)).fetchone()
        if previous:
            try:
                after = json.loads(previous["after_json"] or "null")
                body = json.loads(after["body"]) if isinstance(after, dict) else {}
            except (TypeError, KeyError, json.JSONDecodeError):
                after, body = None, {}
            if (previous["kind"] != "node_upsert" or not isinstance(after, dict)
                    or after["kind"] != "verification" or after["title"] != title
                    or previous["reason"] != reason
                    or body.get("target_id") != target_id
                    or body.get("method") != method or body.get("outcome") != outcome
                    or body.get("evidence_file") != relative_file):
                raise Conflict("Operation ID belongs to a different verification")
            return store.node(previous["node_id"])

    target = store.node(target_id)
    if target["freshness"] != "current" or target["application"] == "retired":
        raise MindwiseError("Target must be current before verification")
    anchors = store.db.execute(
        "SELECT * FROM anchors WHERE node_id=? ORDER BY path", (target_id,)
    ).fetchall()
    if not anchors or any(row["status"] != "current" or
                          store.observe_anchor(row) != "current" for row in anchors):
        raise MindwiseError("Target needs current registered file fingerprints")
    if relative_file in {row["path"] for row in anchors}:
        raise MindwiseError("Result file must be separate from the target file")
    result_path = checked_path(store.root, evidence_file)
    if not result_path.is_file():
        raise MindwiseError("Verification result must be a project file")
    result_digest = hashlib.sha256(result_path.read_bytes()).hexdigest()
    target_snapshot = [{"path": row["path"], "sha256": row["sha256"]} for row in anchors]
    body = json.dumps({"type": "versioned_file_verification", "target_id": target_id,
                       "target_version": target["version"],
                       "target_anchors": target_snapshot, "method": method,
                       "outcome": outcome, "evidence_file": relative_file,
                       "evidence_sha256": result_digest},
                      ensure_ascii=False, sort_keys=True)
    stamp = utc_now()
    node_id = str(uuid.uuid4())
    operation = op_id or str(uuid.uuid4())
    application = "verified" if outcome == "pass" else "implemented"
    with store.db:
        # Recheck the database version in the write transaction. Live files are
        # checked again by status(), so a later file change cannot reuse this pass.
        now = store.node(target_id)
        if now["version"] != target["version"]:
            raise Conflict("Target changed while verification was recorded")
        store.db.execute(
            "INSERT INTO nodes VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (node_id, "verification", title, body, "agent", "observation",
             "current", application, None, target_id, 1, stamp, stamp),
        )
        created = store.node(node_id)
        store._event(operation, node_id, "agent", None, "node_upsert", None,
                     created, reason, relative_file)
        edge = {"source_id": node_id, "target_id": target_id, "kind": "verifies",
                "scope": None, "evidence": relative_file, "created_at": stamp}
        store.db.execute("INSERT INTO edges VALUES(?,?,?,?,?,?)", tuple(edge.values()))
        store._event(f"{operation}:target", node_id, "agent", None, "edge_add",
                     None, edge, reason, relative_file)
        anchor = {"node_id": node_id, "path": relative_file,
                  "sha256": result_digest, "checked_at": stamp, "status": "current"}
        store.db.execute("INSERT INTO anchors VALUES(?,?,?,?,?)", tuple(anchor.values()))
        store._event(f"{operation}:result", node_id, "agent", None,
                     "anchor_registered", None, anchor, reason, relative_file)
    return created


def status(store: Store, node_id: str) -> dict[str, Any]:
    """Read current validity without mutating old result or target states."""
    node = store.node(node_id)
    if node["kind"] != "verification":
        raise MindwiseError("Selected node is not a verification")
    try:
        body = json.loads(node["body"])
    except (TypeError, json.JSONDecodeError):
        body = {}
    if not isinstance(body, dict) or body.get("type") != "versioned_file_verification":
        return {"node_id": node_id, "status": "unversioned",
                "eligible_for_acceptance_review": False,
                "reason": "No target-version snapshot"}
    if (not isinstance(body.get("target_id"), str)
            or not isinstance(body.get("evidence_file"), str)
            or not isinstance(body.get("target_anchors"), list)):
        return {"node_id": node_id, "status": "invalid_record",
                "eligible_for_acceptance_review": False,
                "reason": "Verification record is malformed"}
    problems: list[str] = []
    target_id = body.get("target_id")
    try:
        target = store.node(target_id)
    except MindwiseError:
        target = None
        problems.append("target_missing")
    if target is not None:
        if target["version"] != body.get("target_version"):
            problems.append("target_version_changed")
        if target["freshness"] != "current":
            problems.append("target_not_current")
        if target["application"] == "retired":
            problems.append("target_retired")
        snapshots = body.get("target_anchors")
        if not isinstance(snapshots, list) or not snapshots:
            snapshots = []
            problems.append("missing_target_fingerprint_snapshot")
        recorded_paths = {item.get("path") for item in snapshots
                          if isinstance(item, dict) and isinstance(item.get("path"), str)}
        current_paths = {row["path"] for row in store.db.execute(
            "SELECT path FROM anchors WHERE node_id=?", (target_id,)
        )}
        for path in sorted(current_paths - recorded_paths):
            problems.append(f"target_anchor_added:{path}")
        for expected in snapshots:
            if not isinstance(expected, dict) or not isinstance(expected.get("path"), str):
                problems.append("invalid_target_fingerprint_snapshot")
                continue
            row = store.db.execute(
                "SELECT * FROM anchors WHERE node_id=? AND path=?",
                (target_id, expected["path"]),
            ).fetchone()
            if not row or row["sha256"] != expected.get("sha256"):
                problems.append(f"target_anchor_replaced:{expected['path']}")
            elif store.observe_anchor(row) != "current":
                problems.append(f"target_file_changed:{expected['path']}")
    if not store.db.execute(
        "SELECT 1 FROM edges WHERE source_id=? AND target_id=? AND kind='verifies'",
        (node_id, target_id),
    ).fetchone():
        problems.append("target_connection_missing")
    evidence = store.db.execute(
        "SELECT * FROM anchors WHERE node_id=? AND path=?",
        (node_id, body.get("evidence_file")),
    ).fetchone()
    if (not evidence or evidence["sha256"] != body.get("evidence_sha256")
            or store.observe_anchor(evidence) != "current"):
        problems.append("result_file_changed_or_missing")
    if node["freshness"] != "current" or node["application"] not in {"verified", "implemented"}:
        problems.append("verification_record_not_current")
    result = "stale" if problems else "current"
    return {"node_id": node_id, "target_id": target_id,
            "recorded_target_version": body.get("target_version"),
            "current_target_version": target["version"] if target else None,
            "outcome": body.get("outcome"), "status": result,
            "problems": problems,
            "eligible_for_acceptance_review": result == "current"
                                              and body.get("outcome") == "pass"
                                              and node["application"] == "verified",
            "semantic_result_validity": "not_inferred_from_files_or_reported_outcome"}
