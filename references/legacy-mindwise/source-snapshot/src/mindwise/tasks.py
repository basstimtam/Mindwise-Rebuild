"""Planned work and calendar data, separate from acceptance evidence."""

from __future__ import annotations

import json
from datetime import date
from typing import Any

from .core import MindwiseError, Store

STATUSES = {"todo", "doing", "blocked", "done"}


def _body(status: str, start: str | None, due: str | None,
          progress: int) -> str:
    if status not in STATUSES or type(progress) is not int or not 0 <= progress <= 100:
        raise MindwiseError("Invalid task status or progress")
    try:
        start_date = date.fromisoformat(start) if start else None
        due_date = date.fromisoformat(due) if due else None
    except ValueError as exc:
        raise MindwiseError("Task dates must use YYYY-MM-DD") from exc
    if start_date and due_date and due_date < start_date:
        raise MindwiseError("Task due date precedes its start")
    details = {"status": status, "start": start, "due": due,
               "progress": progress, "progress_kind": "plan"}
    return json.dumps(details, ensure_ascii=False, sort_keys=True)


def record(store: Store, *, title: str, status: str = "todo",
           start: str | None = None, due: str | None = None,
           progress: int = 0, scope: str | None = None,
           reason: str, op_id: str | None = None) -> dict[str, Any]:
    if not reason.strip():
        raise MindwiseError("A task needs a reason")
    return store.upsert_node(
        kind="task", title=title, body=_body(status, start, due, progress),
        knowledge="decision", application="adopted", scope=scope,
        reason=reason, op_id=op_id)


def update(store: Store, node_id: str, *, title: str, status: str,
           start: str | None, due: str | None, progress: int,
           base_version: int, reason: str | None = None,
           op_id: str | None = None, preview: bool = False,
           actor: str = "agent") -> dict[str, Any]:
    node = store.node(node_id)
    if node["kind"] != "task":
        raise MindwiseError("Selected node is not a task")
    body = _body(status, start, due, progress)
    if op_id and not preview:
        repeated = store.repeated_upsert(
            op_id, node_id, title=title, body=body,
            base_version=base_version, reason=reason)
        if repeated is not None:
            return repeated
    proposed = store.preview_text_update(node_id, title=title, body=body,
                                         base_version=base_version,
                                         allow_structured=True)
    if preview or not proposed["changes"]:
        return proposed if preview else node
    if not (reason or "").strip():
        raise MindwiseError("A task update needs a reason")
    return store.upsert_node(
        node_id=node_id, kind="task", title=title, body=body,
        authority=node["authority"], knowledge="decision", freshness="unverified",
        application="adopted", scope=node["scope"],
        strategy_ref=node["strategy_ref"], actor=actor, reason=reason,
        base_version=base_version, op_id=op_id)
