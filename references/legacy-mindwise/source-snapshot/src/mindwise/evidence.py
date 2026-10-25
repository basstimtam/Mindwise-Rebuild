"""A read-only evidence card for a single branch of the project map."""

from __future__ import annotations

import json
import re
from typing import Any

from .contract import inspect
from .core import Store, checked_path

DOCUMENT_REF = re.compile(r"^(GOAL\.md|DESIGN_STANDARD\.md):(\d+)@(.+)$")
PURPOSE_CHAIN_LIMIT = 16


def _purpose_chain(store: Store, node: dict[str, Any]) -> dict[str, Any]:
    """Follow recorded purpose references, without interpreting other edges."""
    visited: list[dict[str, Any]] = []
    seen: set[str] = set()
    current = node
    result: dict[str, Any] = {
        "outcome": None, "visited": visited, "terminal_contract": None,
        "current_approved_strategy_reference": False,
        "method": "recorded_strategy_ref_only", "limit": PURPOSE_CHAIN_LIMIT,
    }
    while True:
        visited.append({key: current[key] for key in
                        ("id", "kind", "authority", "freshness", "application",
                         "strategy_ref")})
        seen.add(current["id"])
        source = current["strategy_ref"]
        if not source:
            result["outcome"] = "no_reference"
            return result
        match = DOCUMENT_REF.fullmatch(source)
        if match:
            name, line, revision = match.groups()
            report = inspect(store.root)
            document = report["documents"][name]
            path = checked_path(store.root, name, must_exist=False)
            try:
                line_exists = (int(line) > 0 and path.is_file()
                               and int(line) <= len(path.read_text(
                                   encoding="utf-8-sig").splitlines()))
            except (OSError, UnicodeError):
                line_exists = False
            terminal = {"path": name, "line": int(line),
                        "recorded_revision": revision,
                        "current_revision": report["revision"],
                        "revision_match": revision == report["revision"],
                        "line_exists": line_exists,
                        "document_status": document["status"],
                        "contract_state": report["state"],
                        "approval_status": report["approval"]["status"]}
            result["terminal_contract"] = terminal
            result["outcome"] = "contract_reference"
            result["current_approved_strategy_reference"] = (
                current["authority"] == "contract"
                and current["application"] == "adopted"
                and current["freshness"] == "current"
                and all(item["freshness"] != "stale"
                        and item["application"] not in {"retired", "proposed"}
                        for item in visited)
                and terminal["revision_match"]
                and line_exists
                and report["compatible"]
                and report["approval"]["status"] == "confirmed"
                and report["state"] in {"APPROVED", "ACTIVE", "COMPLETE"}
            )
            return result
        if source in seen:
            result.update(outcome="cycle", cycle_at=source)
            return result
        if len(visited) >= PURPOSE_CHAIN_LIMIT:
            result.update(outcome="limit_reached", next_reference=source)
            return result
        linked = store.db.execute("SELECT * FROM nodes WHERE id=?", (source,)).fetchone()
        if linked is None:
            result.update(outcome="missing_reference", missing_reference=source)
            return result
        current = dict(linked)


def _anchors(store: Store, node_id: str) -> list[dict[str, Any]]:
    anchors: list[dict[str, Any]] = []
    for row in store.db.execute(
        "SELECT path,sha256,checked_at,status FROM anchors WHERE node_id=? ORDER BY path",
        (node_id,),
    ):
        observed = store.observe_anchor(row)
        anchors.append({"path": row["path"], "stored_status": row["status"],
                        "observed_status": observed, "recorded_sha256": row["sha256"],
                        "checked_at": row["checked_at"],
                        "method": "read registered project file, then verify its current content"})
    return anchors


def explain(store: Store, node_id: str) -> dict[str, Any]:
    """Expose provenance and retrieval steps without claiming semantic validity."""
    node = store.node(node_id)
    event = store.db.execute(
        "SELECT actor,occurred_at,reason,evidence,op_id FROM events "
        "WHERE node_id=? AND kind='node_upsert' ORDER BY sequence DESC LIMIT 1",
        (node_id,),
    ).fetchone()
    decision = None
    if node["kind"] == "decision":
        try:
            value = json.loads(node["body"])
            decision = value if isinstance(value, dict) else {"status": "invalid_payload"}
        except (TypeError, json.JSONDecodeError):
            decision = {"status": "invalid_payload"}

    reference = None
    source = node["strategy_ref"]
    match = DOCUMENT_REF.fullmatch(source or "")
    if match:
        name, line_number, revision = match.groups()
        path = checked_path(store.root, name, must_exist=False)
        current_line = None
        if path.is_file():
            try:
                lines = path.read_text(encoding="utf-8-sig").splitlines()
                position = int(line_number) - 1
                current_line = lines[position] if 0 <= position < len(lines) else None
            except (OSError, UnicodeError):
                pass
        contract = inspect(store.root)
        reference = {"type": "contract_document", "path": name,
                     "line": int(line_number), "recorded_revision": revision,
                     "current_revision": contract["revision"],
                     "revision_match": revision == contract["revision"],
                     "current_line": current_line,
                     "method": "read this line and surrounding context in the registered project"}
    elif source:
        linked = store.db.execute("SELECT id,title,kind FROM nodes WHERE id=?",
                                  (source,)).fetchone()
        reference = ({"type": "node", **dict(linked), "method": "explain this node ID"}
                     if linked else {"type": "unresolved", "value": source})

    locations: list[dict[str, Any]] = []
    for row in store.db.execute(
        "SELECT n.id,n.title,n.body FROM nodes n JOIN edges e ON e.source_id=n.id "
        "WHERE e.target_id=? AND e.kind='locates' AND n.kind='location' "
        "AND n.application!='retired' ORDER BY n.title,n.id", (node_id,),
    ):
        try:
            recipe = json.loads(row["body"])
        except (TypeError, json.JSONDecodeError):
            recipe = {"status": "invalid_recipe"}
        locations.append({"node_id": row["id"], "title": row["title"],
                          "recipe": recipe, "anchors": _anchors(store, row["id"])})

    verification = None
    if node["kind"] == "verification":
        from .verification import status
        verification = status(store, node_id)

    change_links = None
    if node["kind"] == "decision":
        from .changes import associations
        change_links = associations(store, node_id)

    return {"node": {key: node[key] for key in
                     ("id", "title", "kind", "authority", "knowledge", "freshness",
                      "application", "scope", "version")},
            "decision": decision, "verification": verification, "source": reference,
            "change_links": change_links,
            "purpose_chain": _purpose_chain(store, node),
            "last_change": dict(event) if event else None,
            "anchors": _anchors(store, node_id), "locations": locations,
            "connections": {"method": "trace", "node_id": node_id},
            "semantic_validity": "not_inferred_from_references"}
