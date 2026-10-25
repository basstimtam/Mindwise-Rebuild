"""Explicit retrieval instructions for sources inside a registered project."""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from .core import MindwiseError, Store, checked_path

SECRET_LITERAL = re.compile(
    r"(?i)(?:bearer\s+\S+|(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*\S+)"
)


def record_local(store: Store, *, subject_id: str, title: str, path: str,
                 method: str, conditions: str = "", read_range: str = "",
                 reason: str, op_id: str | None = None) -> dict[str, Any]:
    """Register a local retrieval recipe; never execute the method text."""
    store.node(subject_id)
    if not title.strip() or not method.strip() or not reason.strip():
        raise MindwiseError("A location needs a title, method, and reason")
    if SECRET_LITERAL.search(method) or SECRET_LITERAL.search(conditions):
        raise MindwiseError("Retrieval instructions must not contain credential values")
    target = checked_path(store.root, path)
    if not target.is_file():
        raise MindwiseError("Local source must be a file in the registered project")
    relative = str(target.relative_to(store.root))
    body = json.dumps({"type": "local_file", "path": relative, "method": method,
                       "conditions": conditions, "range": read_range},
                      ensure_ascii=False, sort_keys=True)
    operation = op_id or str(uuid.uuid4())
    location = store.upsert_node(
        kind="location", title=title, body=body, knowledge="observation",
        freshness="unverified", application="adopted", strategy_ref=subject_id,
        reason=reason, op_id=operation)
    store.link(location["id"], subject_id, "locates",
               evidence=reason, op_id=f"{operation}:subject")
    if not store.db.execute("SELECT 1 FROM anchors WHERE node_id=? AND path=?",
                            (location["id"], relative)).fetchone():
        store.anchor(location["id"], relative)
    return location
