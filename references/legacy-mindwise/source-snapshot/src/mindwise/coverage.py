"""Bounded coverage of explicitly registered artifacts, not project completion."""

from __future__ import annotations

from typing import Any

from .core import Store, utc_now


def report(store: Store) -> dict[str, Any]:
    counts = {"current_fingerprint": 0, "changed_fingerprint": 0,
              "unavailable": 0, "stored_state_disagreements": 0}
    anchors = store.db.execute("SELECT * FROM anchors ORDER BY node_id,path").fetchall()
    for row in anchors:
        observed = store.observe_anchor(row)
        key = {"current": "current_fingerprint", "stale": "changed_fingerprint",
               "unverified": "unavailable"}[observed]
        counts[key] += 1
        if observed != row["status"]:
            counts["stored_state_disagreements"] += 1
    unanchored = store.db.execute(
        "SELECT id,title FROM nodes WHERE kind='artifact' AND application!='retired' "
        "AND NOT EXISTS(SELECT 1 FROM anchors WHERE node_id=nodes.id) ORDER BY id"
    ).fetchall()
    return {"project_id": store.id, "measured_at": utc_now(),
            "scope": "explicitly_registered_anchors_only",
            "registered_anchor_denominator": len(anchors), **counts,
            "unanchored_artifact_nodes": {"count": len(unanchored),
                                          "sample": [dict(row) for row in unanchored[:50]],
                                          "sample_truncated": len(unanchored) > 50},
            "unregistered_artifact_scope": "unknown_not_enumerated",
            "semantic_understanding": "not_measured",
            "project_completion": "not_inferred"}
