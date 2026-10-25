"""Explicit declarations linking a recorded decision to observed file states."""

from __future__ import annotations

import json
from typing import Any

from .core import Conflict, MindwiseError, Store

SOURCE_LIMIT = 20
READ_LIMIT = 10
LINK_TYPE = "explicit_decision_change_link"


def _object(value: str | None) -> dict[str, Any]:
    try:
        parsed = json.loads(value or "null")
    except (ValueError, TypeError) as exc:
        raise MindwiseError("Invalid recorded change reference") from exc
    if not isinstance(parsed, dict):
        raise MindwiseError("Invalid recorded change reference")
    return parsed


def _event(store: Store, op_id: str) -> dict[str, Any]:
    if not isinstance(op_id, str) or not op_id.strip():
        raise MindwiseError("A change reference needs an event operation ID")
    row = store.db.execute("SELECT * FROM events WHERE op_id=?", (op_id,)).fetchone()
    if row is None:
        raise MindwiseError("Unknown change reference event")
    return dict(row)


def _decision(store: Store, decision_id: str, operation: str):
    event = _event(store, operation)
    snapshot = _object(event["after_json"])
    if (event["node_id"] != decision_id or event["kind"] != "node_upsert"
            or snapshot.get("id") != decision_id or snapshot.get("kind") != "decision"
            or snapshot.get("knowledge") != "decision"
            or not isinstance(snapshot.get("application"), str)
            or snapshot["application"] not in {"adopted", "implemented", "verified"}
            or not isinstance(snapshot.get("scope"), str) or not snapshot["scope"].strip()
            or not isinstance(snapshot.get("strategy_ref"), str) or not snapshot["strategy_ref"].strip()
            or type(snapshot.get("version")) is not int or snapshot["version"] < 1):
        raise MindwiseError("Reference must be a recorded typed decision")
    choice = _object(snapshot.get("body"))
    if any(not isinstance(choice.get(field), str) or not choice[field].strip()
           for field in ("choice", "reason")):
        raise MindwiseError("Reference must be a recorded typed decision")
    return event, snapshot, choice


def _sources(store: Store, operations: list[str]) -> list[dict[str, Any]]:
    if (not isinstance(operations, list) or not operations or len(operations) > SOURCE_LIMIT
            or any(not isinstance(item, str) or not item.strip() for item in operations)):
        raise MindwiseError(f"A change declaration needs 1 to {SOURCE_LIMIT} observation IDs")
    sources = []
    for operation in sorted(set(operations)):
        event = _event(store, operation)
        observation = _object(event["after_json"])
        if (event["kind"] != "anchor_observed" or not isinstance(event["node_id"], str)
                or not isinstance(observation.get("path"), str) or not observation["path"].strip()
                or not isinstance(observation.get("status"), str)
                or observation["status"] not in {"current", "stale", "unverified"}):
            raise MindwiseError("Change sources must be recorded anchor observations")
        sources.append(event)
    return sources


def _scope_receipt(store: Store, operation: str, target: str, decision: dict[str, Any]) -> None:
    event = _event(store, operation)
    edge = _object(event["after_json"])
    if (event["kind"] != "edge_add" or event["node_id"] != target
            or edge.get("source_id") != target or edge.get("target_id") != decision["id"]
            or edge.get("kind") != "applies_to" or edge.get("scope") != decision["scope"]):
        raise MindwiseError("Observation is outside the recorded decision application scope")


def _current_scope_receipt(store: Store, target: str, decision: dict[str, Any]) -> str:
    edge = store.db.execute(
        "SELECT scope FROM edges WHERE source_id=? AND target_id=? AND kind='applies_to'",
        (target, decision["id"])).fetchone()
    if edge is None or edge["scope"] != decision["scope"]:
        raise MindwiseError("Observation is outside the declared applies_to scope")
    for event in store.db.execute(
            "SELECT op_id FROM events WHERE node_id=? AND kind='edge_add' ORDER BY sequence DESC",
            (target,)):
        try:
            _scope_receipt(store, event["op_id"], target, decision)
        except MindwiseError:
            continue
        return event["op_id"]
    raise MindwiseError("Application scope needs a recorded relationship event")


def _resolve(store: Store, decision_id: str, payload: dict[str, Any]):
    if payload.get("type") != LINK_TYPE or payload.get("decision_id") != decision_id:
        raise MindwiseError("Invalid declaration payload")
    original, snapshot, choice = _decision(store, decision_id, payload.get("operation_id"))
    sources = _sources(store, payload.get("source_event_op_ids"))
    scopes = payload.get("application_scope_event_ids")
    if not isinstance(scopes, dict) or set(scopes) != {source["node_id"] for source in sources}:
        raise MindwiseError("Invalid application scope references")
    for source in sources:
        _scope_receipt(store, scopes[source["node_id"]], source["node_id"], snapshot)
    return original, snapshot, choice, sources, scopes


def record(store: Store, *, decision_id: str, decision_op_id: str,
           source_op_ids: list[str], reason: str, op_id: str,
           evidence: str | None = None, session_id: str | None = None) -> dict[str, Any]:
    """Persist a declaration, never a reconstructed observation reason or cause."""
    if (not isinstance(reason, str) or not reason.strip()
            or not isinstance(op_id, str) or not op_id.strip()):
        raise MindwiseError("A change declaration needs its reason and receipt operation ID")
    if (not isinstance(source_op_ids, list) or not source_op_ids
            or len(source_op_ids) > SOURCE_LIMIT
            or any(not isinstance(item, str) or not item.strip() for item in source_op_ids)):
        raise MindwiseError(f"A change declaration needs 1 to {SOURCE_LIMIT} observation IDs")
    references = {"type": LINK_TYPE, "decision_id": decision_id,
                  "operation_id": decision_op_id, "source_event_op_ids": sorted(set(source_op_ids))}
    previous = store.db.execute("SELECT * FROM events WHERE op_id=?", (op_id,)).fetchone()
    if previous is not None:
        payload = _object(previous["after_json"])
        if (previous["kind"] != "decision_change_link" or previous["node_id"] != decision_id
                or any(payload.get(field) != value for field, value in references.items())):
            raise Conflict("Operation ID belongs to a different change declaration")
        # Preserve the original scope receipt even if the live decision/edges changed.
        _resolve(store, decision_id, payload)
    else:
        if store.node(decision_id)["kind"] != "decision":
            raise MindwiseError("A change declaration needs a decision node")
        _, snapshot, _ = _decision(store, decision_id, decision_op_id)
        sources = _sources(store, source_op_ids)
        scopes = {source["node_id"]: _current_scope_receipt(store, source["node_id"], snapshot)
                  for source in sources}
        payload = {**references, "application_scope_event_ids": scopes}
    stored = store.record_event(op_id=op_id, kind="decision_change_link", actor="agent",
                                node_id=decision_id, session_id=session_id,
                                reason=reason, evidence=evidence, details=payload)
    return {"stored": stored, "event_op_id": op_id, "operation_id": decision_op_id,
            "decision_id": decision_id, "source_count": len(references["source_event_op_ids"]),
            "causal_validity": "not_established_by_declaration"}


def associations(store: Store, decision_id: str, *, limit: int = READ_LIMIT) -> dict[str, Any]:
    """Read immutable references; report malformed declarations without endorsing them."""
    if type(limit) is not int or not 1 <= limit <= 50:
        raise MindwiseError("Change association read limit must be between 1 and 50")
    current = store.node(decision_id)
    total = store.db.execute(
        "SELECT count(*) FROM events WHERE node_id=? AND kind='decision_change_link'",
        (decision_id,)).fetchone()[0]
    items = []
    for event in store.db.execute(
            "SELECT * FROM events WHERE node_id=? AND kind='decision_change_link' "
            "ORDER BY sequence DESC LIMIT ?", (decision_id, limit)).fetchall():
        item = {"event_op_id": event["op_id"], "actor": event["actor"],
                "session_id": event["session_id"], "reason": event["reason"],
                "evidence": event["evidence"], "occurred_at": event["occurred_at"],
                "editing_order": "not_inferred_from_observation_order",
                "causal_validity": "not_established_by_declaration"}
        try:
            if (event["actor"] != "agent" or not isinstance(event["reason"], str)
                    or not event["reason"].strip() or not event["op_id"].strip()):
                raise MindwiseError("Invalid typed declaration receipt")
            payload = _object(event["after_json"])
            original, snapshot, choice, sources, scopes = _resolve(store, decision_id, payload)
            facts = []
            for source in sources:
                observation = _object(source["after_json"])
                facts.append({"event_op_id": source["op_id"], "target_id": source["node_id"],
                              "path": observation["path"], "status": observation["status"],
                              "sha256": observation.get("sha256"), "reason": source["reason"],
                              "session_id": source["session_id"], "occurred_at": source["occurred_at"],
                              "recording_order": ("decision_before_observation"
                                                  if original["sequence"] < source["sequence"]
                                                  else "observation_before_decision")})
            item.update(status="declared", operation_id=original["op_id"], sources=facts,
                        decision_snapshot={"node_id": decision_id, "version": snapshot["version"],
                                           "choice": choice["choice"], "reason": choice["reason"],
                                           "session_id": original["session_id"],
                                           "occurred_at": original["occurred_at"]},
                        matches_current_decision_version=snapshot["version"] == current["version"],
                        application_scope_event_ids=scopes)
        except (MindwiseError, TypeError, KeyError, ValueError):
            item.update(status="invalid_declaration", reference_validity="unconfirmed")
        items.append(item)
    return {"total": total, "items": items, "limit": limit,
            "omitted_count": max(0, total - len(items)), "source_limit": SOURCE_LIMIT,
            "causal_validity": "not_established_by_declaration"}
