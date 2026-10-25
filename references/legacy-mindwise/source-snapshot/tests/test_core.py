from __future__ import annotations

import tempfile
import unittest
import json
import sqlite3
import os
import subprocess
import sys
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from mindwise.contract import inspect, project_sections
from mindwise.core import BoundaryError, Conflict, MindwiseError, Store, checked_path


class StoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / "project"
        self.root.mkdir()
        self.data = self.base / "data"

    def test_pending_subject_pages_use_only_recorded_node_and_preserve_raw_events(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            for subject in ("a", "b", "empty"):
                store.upsert_node(node_id=subject, kind="topic", title=subject)
            store.link("a", "b", "parent_of", evidence="Display only")
            # Neither a matching path nor a graph neighbor assigns a subject.
            for index in range(60):
                store.record_event(op_id=f"global-{index}", kind="file_observed",
                                   actor="hook", details={"path": "same.txt", "topic_id": "a"})
            for index in range(57):
                for subject in ("a", "b"):
                    store.record_event(
                        op_id=f"{subject}-{index}", node_id=subject, kind="anchor_observed",
                        actor="mindwise" if index % 2 else "fixture",
                        session_id="original-session" if index % 2 else None,
                        reason="Recorded reason" if index == 1 else None,
                        details={"path": "same.txt", "reason_status": "unknown", "sha256": None})
            store.record_event(op_id="a-nonpending", node_id="a", kind="node_upsert",
                               actor="fixture")
            store.distill_events(title="Already processed", summary="Recorded source",
                                 source_op_ids=["a-0", "b-0"], topic_id="a",
                                 reason="Fixture distillation")
            before = store.export()
            expected = [event for event in before["events"]
                        if event["node_id"] == "a" and event["kind"] == "anchor_observed"
                        and event["op_id"] != "a-0"]
            legacy = store.pending_events()
            self.assertEqual(len(legacy), 50)
            self.assertTrue(all(event["node_id"] is None for event in legacy))
            first = store.pending_events_for_subject("a")
            self.assertEqual(first["subject_id"], "a")
            self.assertEqual(first["total_pending"], 56)
            self.assertEqual(first["events"], expected[:50])
            self.assertEqual(first["returned_count"], 50)
            self.assertEqual(first["remaining_count"], 6)
            self.assertTrue(first["truncated"])
            self.assertEqual(first["retrieve_more"], {
                "command": "pending-events", "topic": "a", "limit": 50,
                "after_sequence": expected[49]["sequence"]})
            last = store.pending_events_for_subject("a", after_sequence=first["next_after_sequence"])
            self.assertEqual(last["total_pending"], 56)
            self.assertEqual(last["events"], expected[50:])
            self.assertEqual(last["remaining_count"], 0)
            self.assertFalse(last["truncated"])
            self.assertIsNone(last["next_after_sequence"])
            self.assertIsNone(last["retrieve_more"])
            beyond = store.pending_events_for_subject("a", after_sequence=2**63 - 1)
            self.assertEqual(beyond["events"], [])
            self.assertEqual(beyond["total_pending"], 56)
            empty = store.pending_events_for_subject("empty", limit=1)
            self.assertEqual(empty["total_pending"], 0)
            self.assertEqual(empty["events"], [])
            self.assertEqual(store.pending_events(), legacy)
            self.assertEqual(store.export(), before)
        with Store(self.root, data_home=self.data, read_only=True) as store:
            self.assertEqual(store.pending_events_for_subject("a", limit=200)["events"], expected)
            with self.assertRaises(sqlite3.OperationalError):
                store.db.execute("UPDATE events SET reason='invented'")

    def test_pending_subject_errors_do_not_write_or_register(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="a", kind="topic", title="Subject")
            before = store.export()
            changes = store.db.total_changes
            for limit in (0, -1, 201, True, None, 1.5, "2"):
                with self.subTest(limit=limit), self.assertRaises(MindwiseError):
                    store.pending_events_for_subject("a", limit=limit)
            for cursor in (-1, 2**63, True, None, "1"):
                with self.subTest(cursor=cursor), self.assertRaises(MindwiseError):
                    store.pending_events_for_subject("a", after_sequence=cursor)
            for subject in ("missing", "", "a' OR 1=1 --"):
                with self.subTest(subject=subject), self.assertRaises(MindwiseError):
                    store.pending_events_for_subject(subject)
            self.assertEqual(store.db.total_changes, changes)
            self.assertEqual(store.export(), before)
        missing_home = self.base / "unregistered"
        with self.assertRaises(MindwiseError):
            Store(self.root, data_home=missing_home, read_only=True)
        self.assertFalse(missing_home.exists())

    def record_contract_approval(self, revision: str = "Rev 1") -> None:
        path = self.root / "DISCOVERY_LOG.md"
        raw = path.read_text(encoding="utf-8")
        marker = raw.index("## ")
        path.write_text(
            raw[:marker] + f"- **承認根拠**: オーナーが{revision}を承認\n" + raw[marker:],
            encoding="utf-8",
        )

    def test_checked_path_canonicalizes_root_alias_and_keeps_boundary(self) -> None:
        inside = self.root / "inside.txt"
        inside.write_text("project data", encoding="utf-8")
        outside = self.base / "outside.txt"
        outside.write_text("outside data", encoding="utf-8")
        aliased_root = self.root / ".." / self.root.name

        self.assertEqual(checked_path(aliased_root, "inside.txt"), inside.resolve())
        self.assertEqual(checked_path(aliased_root, "new.txt", must_exist=False),
                         (self.root / "new.txt").resolve())
        with self.assertRaises(BoundaryError):
            checked_path(aliased_root, "../outside.txt")
        with self.assertRaises(BoundaryError):
            checked_path(aliased_root, outside)
        link = self.root / "escape.txt"
        try:
            link.symlink_to(outside)
        except OSError:
            pass  # Windows may not permit creating symlinks.
        else:
            with self.assertRaises(BoundaryError):
                checked_path(aliased_root, "escape.txt")

    def test_version_idempotency_and_owner_boundary(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            first = store.upsert_node(node_id="n1", kind="decision", title="Engine A",
                                      knowledge="decision", reason="Initial choice", op_id="op-1")
            same = store.upsert_node(node_id="n1", kind="decision", title="Engine A",
                                     knowledge="decision", reason="Initial choice", op_id="op-1")
            self.assertEqual(first["version"], same["version"])
            with self.assertRaises(Conflict):
                store.upsert_node(node_id="n1", kind="decision", title="Engine X",
                                  knowledge="decision", reason="Initial choice", op_id="op-1")
            with self.assertRaises(Conflict):
                store.upsert_node(node_id="n1", kind="decision", title="Engine B",
                                  base_version=0, reason="New evidence")
            second = store.upsert_node(node_id="n1", kind="decision", title="Engine B",
                                       knowledge="decision", base_version=1,
                                       reason="New evidence", actor="owner", authority="owner")
            self.assertEqual(second["version"], 2)
            with self.assertRaises(BoundaryError):
                store.upsert_node(node_id="n1", kind="decision", title="Engine C",
                                  base_version=2, reason="Agent preference")
            self.assertEqual(len(store.history("n1")), 2)
            generated = store.upsert_node(kind="note", title="Retryable", op_id="new-op")
            retried = store.upsert_node(kind="note", title="Retryable", op_id="new-op")
            self.assertEqual(generated["id"], retried["id"])
            with self.assertRaises(Conflict):
                store.upsert_node(kind="note", title="Different retry", op_id="new-op")
            with self.assertRaises(BoundaryError):
                store.upsert_node(node_id="fake-owner", kind="decision", title="Claim",
                                  authority="owner", actor="agent")

    def test_anchor_changes_and_refuses_outside(self) -> None:
        inside = self.root / "chapter.md"
        inside.write_text("one", encoding="utf-8")
        outside = self.base / "other.md"
        outside.write_text("private", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="chapter", kind="artifact", title="Chapter")
            before_anchor = store.semantic_sequence()
            store.anchor("chapter", "chapter.md")
            self.assertGreater(store.semantic_sequence(), before_anchor)
            self.assertEqual(store.reconcile_anchors()[0]["status"], "current")
            inside.write_text("two", encoding="utf-8")
            self.assertEqual(store.reconcile_anchors()[0]["status"], "stale")
            self.assertEqual(store.node("chapter")["freshness"], "stale")
            with self.assertRaises(BoundaryError):
                store.anchor("chapter", outside)
            link = self.root / "shortcut.md"
            try:
                link.symlink_to(outside)
            except OSError:
                pass  # Windows developer mode may not allow this test fixture.
            else:
                with self.assertRaises(BoundaryError):
                    store.anchor("chapter", "shortcut.md")

    def test_missing_and_changed_anchors_have_stable_combined_state(self) -> None:
        first = self.root / "first.txt"
        second = self.root / "second.txt"
        first.write_text("first", encoding="utf-8")
        second.write_text("second", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="artifact", kind="artifact", title="Two files",
                              freshness="current", application="verified",
                              evidence="review")
            store.upsert_node(node_id="check", kind="verification", title="Check",
                              freshness="current", application="verified",
                              evidence="review")
            store.link("check", "artifact", "verifies")
            store.anchor("artifact", "first.txt")
            store.anchor("artifact", "second.txt")
            first.unlink()
            second.write_text("changed", encoding="utf-8")
            statuses = {item["path"]: item["status"] for item in
                        store.reconcile_anchors()}
            self.assertEqual(set(statuses.values()), {"stale", "unverified"})
            self.assertEqual(store.node("artifact")["freshness"], "unverified")
            self.assertEqual(store.node("artifact")["application"], "implemented")
            self.assertEqual(store.node("check")["freshness"], "stale")
            first.write_text("first", encoding="utf-8")
            store.reconcile_anchors()
            self.assertEqual(store.node("artifact")["freshness"], "stale")
            second.write_text("second", encoding="utf-8")
            store.reconcile_anchors()
            self.assertEqual(store.node("artifact")["freshness"], "stale")

    def test_rebind_anchor_keeps_identity_for_exact_move_and_rejects_changed_file(self) -> None:
        original = self.root / "draft.txt"
        original.write_text("same artifact", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="artifact", kind="artifact", title="Draft",
                              freshness="current")
            store.anchor("artifact", "draft.txt")
            original.rename(self.root / "chapter.txt")
            moved = store.rebind_anchor("artifact", "draft.txt", "chapter.txt",
                                        reason="file renamed", op_id="move-1")
            self.assertEqual(moved["path"], "chapter.txt")
            self.assertEqual(store.rebind_anchor(
                "artifact", "draft.txt", "chapter.txt", reason="file renamed",
                op_id="move-1"), moved)
            self.assertEqual(store.reconcile_anchors()[0]["status"], "current")
            self.assertEqual(store.node("artifact")["freshness"], "current")
            (self.root / "changed.txt").write_text("other content", encoding="utf-8")
            with self.assertRaises(Conflict):
                store.rebind_anchor("artifact", "chapter.txt", "changed.txt",
                                    reason="different content")
            self.assertEqual(store.db.execute(
                "SELECT path FROM anchors WHERE node_id='artifact'").fetchone()[0],
                             "chapter.txt")

    def test_relationships_and_search(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="goal", kind="strategy", title="Readable book",
                              actor="contract_import", authority="contract")
            store.upsert_node(node_id="style", kind="specification", title="Style guide",
                              body="plain language", application="adopted")
            store.link("style", "goal", "contributes", evidence="editor review",
                       op_id="same-link")
            store.link("style", "goal", "contributes", evidence="editor review",
                       op_id="same-link")
            with self.assertRaises(Conflict):
                store.link("style", "goal", "contributes", evidence="different evidence",
                           op_id="same-link")
            self.assertEqual(store.neighbors("goal")[0]["source_id"], "style")
            self.assertEqual(store.search("plain")[0]["id"], "style")
            self.assertEqual(store.impact("goal")[0]["node"]["id"], "style")
            with self.assertRaises(BoundaryError):
                store.upsert_node(node_id="goal", kind="strategy", title="Different goal",
                                  base_version=1)

    def test_retarget_decision_corrects_purpose_atomically(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            for node_id in ("d5", "d6"):
                store.upsert_node(node_id=node_id, kind="strategy", title=node_id)
            decision = store.record_decision(
                title="Ack behavior", purpose_id="d5", choice="Keep unconfirmed",
                reason="No explicit receipt", scope="D6", op_id="record-ack")
            corrected = store.retarget_decision(
                decision["id"], "d6", base_version=1,
                reason="The choice concerns D6 receipt", op_id="correct-ack")
            self.assertEqual(corrected["strategy_ref"], "d6")
            self.assertEqual(corrected["version"], 2)
            self.assertEqual(
                [(edge["target_id"], edge["kind"]) for edge in store.neighbors(decision["id"])],
                [("d6", "specifies")])
            self.assertEqual(store.retarget_decision(
                decision["id"], "d6", base_version=1,
                reason="The choice concerns D6 receipt", op_id="correct-ack"), corrected)
            with self.assertRaises(Conflict):
                store.retarget_decision(decision["id"], "d5", base_version=1,
                                        reason="Wrong version")
            with self.assertRaises(Conflict):
                store.retarget_decision(decision["id"], "d5", base_version=2,
                                        reason="Conflicting operation", op_id="correct-ack")
            history = store.history(decision["id"])
            self.assertEqual({event["kind"] for event in history},
                             {"node_upsert", "edge_add", "edge_remove"})

    def test_decision_failure_rolls_back_and_retry_has_no_partial_or_duplicate_record(self) -> None:
        arguments = dict(title="Atomic receipt", purpose_id="purpose", choice="One commit",
                         reason="Avoid partial knowledge", scope="recording",
                         applies_to=["artifact"], op_id="atomic-decision")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="purpose", kind="strategy", title="Recording")
            store.upsert_node(node_id="artifact", kind="artifact", title="Implementation")
            original = store.link

            def interrupted(source, target, kind, **kwargs):
                original(source, target, kind, **kwargs)
                if kind == "applies_to":
                    raise OSError("Simulated failure after the last relation write")

            with patch.object(store, "link", side_effect=interrupted):
                with self.assertRaises(OSError):
                    store.record_decision(**arguments)
        crash_script = """
import json, os, sys
from mindwise.core import Store
with Store(sys.argv[1], data_home=sys.argv[2]) as store:
    original = store.link
    def interrupted(source, target, kind, **kwargs):
        original(source, target, kind, **kwargs)
        if kind == 'applies_to':
            os._exit(77)
    store.link = interrupted
    store.record_decision(**json.loads(sys.argv[3]))
"""
        crashed = subprocess.run([sys.executable, "-c", crash_script, str(self.root),
                                  str(self.data), json.dumps(arguments)], capture_output=True)
        self.assertEqual(crashed.returncode, 77, crashed.stderr)
        with Store(self.root, data_home=self.data) as store:
            self.assertEqual(store.db.execute("SELECT count(*) FROM nodes WHERE kind='decision'")
                             .fetchone()[0], 0)
            self.assertEqual(store.db.execute("SELECT count(*) FROM edges").fetchone()[0], 0)
            self.assertFalse(store._seen("atomic-decision"))
            pending = store.pending_events()
            self.assertEqual(len(pending), 1)
            self.assertEqual(pending[0]["kind"], "decision_recording_requested")
            self.assertEqual(json.loads(pending[0]["after_json"])["reason"], arguments["reason"])
            self.assertEqual(store.health()["pending_events"], 1)
            decision = store.record_decision(**arguments)
            self.assertEqual(store.record_decision(**arguments)["id"], decision["id"])
            self.assertEqual(store.db.execute("SELECT count(*) FROM edges").fetchone()[0], 2)
            self.assertEqual(store.pending_events(), [])
            self.assertEqual(store.health()["pending_events"], 0)
            with self.assertRaises(Conflict):
                store.record_decision(**{**arguments, "applies_to": []})

    def test_prerequisite_change_invalidates_only_dependents(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            for node_id in ("shared", "stage-a", "stage-b", "other", "artifact-a"):
                store.upsert_node(node_id=node_id, kind="specification", title=node_id,
                                  freshness="current", application="verified",
                                  evidence="test result")
            store.link("stage-a", "shared", "depends_on")
            store.link("stage-b", "shared", "depends_on")
            store.link("artifact-a", "stage-a", "implements")
            store.link("other", "shared", "applies_to")
            store.link("other", "shared", "exception_to", evidence="intentional local rule")
            local = store.impact_report("stage-a")
            self.assertEqual({item["node"]["id"] for item in local["affected"]},
                             {"artifact-a"})
            preview = store.preview_text_update("shared", title="shared changed",
                                                body="", base_version=1)
            self.assertEqual({item["node"]["id"] for item in preview["affected"]},
                             {"stage-a", "stage-b", "artifact-a"})
            self.assertEqual(preview["exceptions"][0]["node"]["id"], "other")
            self.assertEqual(preview["exceptions"][0]["reason"],
                             "intentional local rule")
            store.upsert_node(node_id="shared", kind="specification", title="shared changed",
                              freshness="current", application="adopted", base_version=1)
            self.assertEqual(store.node("stage-a")["freshness"], "stale")
            self.assertEqual(store.node("stage-b")["application"], "implemented")
            self.assertEqual(store.node("other")["freshness"], "current")

    def test_one_decision_model_covers_game_trading_and_book(self) -> None:
        examples = (
            ("game", "Input engine", "same controls", "later stages"),
            ("trading", "Data clock", "replayable timestamps", "market feed"),
            ("book", "Citation style", "traceable quotations", "chapter 3"),
        )
        with Store(self.root, data_home=self.data, create=True) as store:
            for domain, title, reason, target_name in examples:
                purpose = f"{domain}-purpose"
                target = f"{domain}-target"
                store.upsert_node(node_id=purpose, kind="strategy", title=domain,
                                  authority="contract", actor="contract_import")
                store.upsert_node(node_id=target, kind="area", title=target_name,
                                  freshness="current")
                first = store.record_decision(
                    title=title, purpose_id=purpose, choice=title + " v1",
                    reason=reason, scope=domain, applies_to=[target],
                    alternatives=[{"option": "Other", "reason": "less consistent"}],
                    evidence="design review", op_id=f"decision-{domain}")
                retry = store.record_decision(
                    title=title, purpose_id=purpose, choice=title + " v1",
                    reason=reason, scope=domain, applies_to=[target],
                    alternatives=[{"option": "Other", "reason": "less consistent"}],
                    evidence="design review", op_id=f"decision-{domain}")
                self.assertEqual(first["id"], retry["id"])
                with self.assertRaises(Conflict):
                    store.record_decision(
                        title=title, purpose_id=purpose, choice=title + " v1",
                        reason="changed reason", scope=domain, applies_to=[target],
                        alternatives=[{"option": "Other", "reason": "less consistent"}],
                        evidence="design review", op_id=f"decision-{domain}")
                self.assertEqual(store.impact(first["id"])[0]["node"]["id"], target)
                self.assertEqual(json.loads(first["body"])["reason"], reason)
            self.assertEqual(len(store.search("v1")), 3)
            with self.assertRaises(MindwiseError):
                store.preview_text_update(first["id"], title="Citation style",
                                          body="broken", base_version=1)
            preview = store.update_decision(
                first["id"], title="Citation style", choice="Revised citations",
                reason="source traceability", alternatives=[{"option": "No citations",
                                                               "reason": "untraceable"}],
                reconsider_when="new source policy", base_version=1, preview=True)
            self.assertTrue(preview["changes"])
            revised = store.update_decision(
                first["id"], title="Citation style", choice="Revised citations",
                reason="source traceability", alternatives=[{"option": "No citations",
                                                               "reason": "untraceable"}],
                reconsider_when="new source policy", base_version=1,
                op_id="decision-revised")
            self.assertEqual(json.loads(revised["body"])["choice"], "Revised citations")
            self.assertEqual(revised["id"], first["id"])

    def test_record_decision_link_failure_rolls_back_and_retry_completes(self) -> None:
        for failed_link in ("purpose", "second target"):
            with self.subTest(failed_link=failed_link):
                data_home = self.base / failed_link.replace(" ", "-")
                request = dict(
                    title="Input method", purpose_id="purpose", choice="Method A",
                    reason="Keeps input consistent", scope="game",
                    applies_to=["area-one", "area-two"], evidence="design review",
                    op_id="decision-with-links",
                )
                with Store(self.root, data_home=data_home, create=True) as store:
                    store.upsert_node(node_id="purpose", kind="strategy", title="Purpose")
                    for node_id in request["applies_to"]:
                        store.upsert_node(node_id=node_id, kind="area", title=node_id)
                    before = store.export()
                    original_link = store.link

                    def fail_after_link(source_id, target_id, kind, **kwargs):
                        original_link(source_id, target_id, kind, **kwargs)
                        if ((failed_link == "purpose" and kind == "specifies") or
                                (failed_link == "second target" and
                                 source_id == "area-two")):
                            raise RuntimeError("injected link failure")

                    with patch.object(store, "link", side_effect=fail_after_link):
                        with self.assertRaisesRegex(RuntimeError, "injected link failure"):
                            store.record_decision(**request)
                    interrupted = store.export()
                    durable = interrupted["events"][-1]
                    self.assertEqual(durable["kind"], "decision_recording_requested")
                    self.assertEqual(durable["reason"], request["reason"])
                    without_request = {**interrupted, "events": interrupted["events"][:-1]}
                    self.assertEqual(without_request, before)

                with Store(self.root, data_home=data_home) as reopened:
                    self.assertEqual(reopened.export(), interrupted)
                    decision = reopened.record_decision(**request)
                    self.assertEqual(decision["kind"], "decision")
                    self.assertEqual(
                        {(edge["source_id"], edge["target_id"], edge["kind"])
                         for edge in reopened.export()["edges"]},
                        {(decision["id"], "purpose", "specifies"),
                         ("area-one", decision["id"], "applies_to"),
                         ("area-two", decision["id"], "applies_to")},
                    )
                    completed = reopened.export()
                    self.assertEqual(len(completed["events"]),
                                     len(before["events"]) + 5)
                    self.assertEqual(reopened.record_decision(**request)["id"],
                                     decision["id"])
                    self.assertEqual(reopened.export(), completed)

    def test_failed_decision_stays_pending_after_distillation_and_retry(self) -> None:
        request = dict(title="Input choice", purpose_id="purpose", choice="Method A",
                       reason="Consistent input", scope="game", op_id="decision-pending")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="purpose", kind="strategy", title="Purpose")
            with patch.object(store, "link", side_effect=RuntimeError("interrupted")):
                with self.assertRaisesRegex(RuntimeError, "interrupted"):
                    store.record_decision(**request)
            original = dict(store.pending_events()[0])
            insight = store.distill_events(
                title="Failed recording", summary="Decision has not been saved",
                source_op_ids=["decision-pending:intent"], reason="Preserve failure",
                op_id="failure-insight")
            self.assertEqual(store.pending_events(), [original])
            self.assertEqual(store.context()["unorganized_events"], 1)
            self.assertEqual(insight["knowledge"], "hypothesis")
            self.assertFalse(any(node["kind"] == "decision" for node in store.export()["nodes"]))
        with Store(self.root, data_home=self.data) as store:
            self.assertEqual(store.pending_events(), [original])
            decision = store.record_decision(**request)
            self.assertEqual(store.pending_events(), [])
            self.assertEqual(store.context()["unorganized_events"], 0)
            self.assertEqual(dict(store.db.execute("SELECT * FROM events WHERE op_id=?",
                                                   (original["op_id"],)).fetchone()), original)
            self.assertEqual(store.node(insight["id"]), insight)
            self.assertEqual({row["insight_id"] for row in store.export()["event_distillations"]
                              if row["event_op_id"] == original["op_id"]},
                             {insight["id"], decision["id"]})
            completed = store.export()
            self.assertEqual(store.record_decision(**request)["id"], decision["id"])
            self.assertEqual(store.export(), completed)

    def test_insight_using_decision_operation_id_does_not_complete_request(self) -> None:
        request = dict(title="Input choice", purpose_id="purpose", choice="Method A",
                       reason="Consistent input", scope="game", op_id="decision-pending")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="purpose", kind="strategy", title="Purpose")
            with patch.object(store, "link", side_effect=RuntimeError("interrupted")):
                with self.assertRaises(RuntimeError):
                    store.record_decision(**request)
            # An unrelated source summary cannot masquerade as the completed
            # typed decision, even if its caller reuses the reserved base ID.
            insight = store.distill_events(title="Summary", summary="Unfinished request",
                                          source_op_ids=["decision-pending:intent"],
                                          reason="Failure observation", op_id="decision-pending")
            store.link(insight["id"], "purpose", "parent_of", op_id="decision-pending:purpose")
            self.assertEqual([event["op_id"] for event in store.pending_events()],
                             ["decision-pending:intent"])
            with self.assertRaises(Conflict):
                store.record_decision(**request)

    def test_completed_decision_does_not_reopen_after_current_node_edit(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="purpose", kind="strategy", title="Purpose")
            decision = store.record_decision(title="Input choice", purpose_id="purpose",
                                             choice="Method A", reason="Consistent input",
                                             scope="game", op_id="decision-completed")
            store.upsert_node(node_id=decision["id"], kind="decision", title="Renamed choice",
                              base_version=decision["version"], reason="Rename only")
            self.assertEqual(store.pending_events(), [])
            self.assertEqual(store.context()["unorganized_events"], 0)

    def test_three_domains_trace_design_to_artifact_and_check_both_ways(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            for domain in ("game", "trading", "book"):
                purpose = f"{domain}-purpose"
                area = f"{domain}-area"
                artifact = f"{domain}-artifact"
                verification = f"{domain}-check"
                store.upsert_node(node_id=purpose, kind="strategy", title=f"{domain} purpose",
                                  authority="contract", actor="contract_import")
                store.upsert_node(node_id=area, kind="area", title=f"{domain} area")
                store.upsert_node(node_id=artifact, kind="artifact",
                                  title=f"{domain} artifact")
                store.upsert_node(node_id=verification, kind="verification",
                                  title=f"{domain} check", knowledge="unknown")
                decision = store.record_decision(
                    title=f"{domain} production method", purpose_id=purpose,
                    choice="chosen method", reason=f"{domain} design rationale",
                    scope=domain, applies_to=[area], op_id=f"{domain}-decision")
                store.link(artifact, area, "implements")
                store.link(verification, artifact, "verifies")
                outward = store.trace(purpose)
                self.assertEqual(
                    {item["node"]["id"] for item in outward["downstream"]},
                    {decision["id"], area, artifact, verification})
                self.assertEqual(next(item["node"]["reason"] for item in
                                      outward["downstream"] if item["node"]["id"] ==
                                      decision["id"]), f"{domain} design rationale")
                inward = store.trace(verification)
                self.assertEqual([item["node"]["id"] for item in inward["upstream"]],
                                 [artifact, area, decision["id"], purpose])
                self.assertEqual(inward["start"]["knowledge"], "unknown")
                limited = store.trace(purpose, max_nodes=2)
                self.assertTrue(limited["truncated"])
                self.assertEqual(len(limited["downstream"]), 2)
            area = store.node("book-area")
            store.update_text("book-area", title="Revised chapter", body="",
                              base_version=area["version"], reason="chapter renamed")
            self.assertEqual(store.trace("book-purpose")["downstream"][1]["node"]["title"],
                             "Revised chapter")

    def test_preview_then_map_update_does_not_claim_product_change(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="shared", kind="specification", title="Old",
                              body="old", application="verified", freshness="current",
                              evidence="test result")
            store.upsert_node(node_id="area", kind="area", title="Affected",
                              freshness="current")
            store.link("area", "shared", "depends_on")
            preview = store.preview_text_update("shared", title="New", body="new",
                                                base_version=1)
            self.assertEqual(preview["affected"][0]["node"]["id"], "area")
            self.assertTrue(preview["map_only"])
            self.assertEqual(store.node("shared")["title"], "Old")
            updated = store.update_text("shared", title="New", body="new",
                                        base_version=1, reason="owner correction",
                                        op_id="edit-shared")
            self.assertEqual(updated["application"], "adopted")
            self.assertEqual(updated["freshness"], "unverified")
            self.assertEqual(store.node("area")["freshness"], "stale")
            self.assertEqual(store.update_text("shared", title="New", body="new",
                                               base_version=1, reason="owner correction",
                                               op_id="edit-shared")["version"], 2)
            with self.assertRaises(Conflict):
                store.update_text("shared", title="Different", body="new",
                                  base_version=1, reason="owner correction",
                                  op_id="edit-shared")

    def test_failed_artifact_application_and_map_rollback_do_not_reuse_verification(self) -> None:
        artifact = self.root / "screen.txt"
        artifact.write_text("old screen", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="shared", kind="specification", title="Old control",
                              body="old rule", freshness="current",
                              application="verified", evidence="accepted review")
            store.upsert_node(node_id="screen", kind="artifact", title="Screen",
                              freshness="current", application="verified",
                              evidence="visual check")
            store.link("screen", "shared", "depends_on")
            store.anchor("screen", "screen.txt")
            changed = store.update_text("shared", title="New control", body="new rule",
                                        base_version=1, reason="planned redesign")
            self.assertEqual(changed["application"], "adopted")
            self.assertEqual(changed["freshness"], "unverified")
            self.assertEqual(store.node("screen")["freshness"], "stale")
            self.assertEqual(store.reconcile_anchors()[0]["status"], "current")
            self.assertEqual(artifact.read_text(encoding="utf-8"), "old screen")
            restored = store.update_text("shared", title="Old control", body="old rule",
                                         base_version=2, reason="artifact edit failed; roll back")
            self.assertEqual(restored["application"], "adopted")
            self.assertEqual(restored["freshness"], "unverified")
            self.assertEqual(store.node("screen")["freshness"], "stale")
            self.assertEqual(len([event for event in store.history("shared")
                                  if event["kind"] == "node_upsert"]), 3)

    def test_retrieval_is_bounded_and_events_retry_safely(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            for index in range(30):
                store.upsert_node(node_id=f"n{index}", kind="specification",
                                  title=f"Topic {index}", body="details " * 80)
            bundle = store.context(max_chars=600)
            self.assertLessEqual(len(json.dumps(bundle, ensure_ascii=False)), 600)
            self.assertGreater(bundle["omitted_count"], 0)
            self.assertTrue(store.record_event(op_id="evt-1", kind="file_changed",
                                               actor="system", evidence="document.md"))
            self.assertFalse(store.record_event(op_id="evt-1", kind="file_changed",
                                                actor="system", evidence="document.md"))
            with self.assertRaises(Conflict):
                store.record_event(op_id="evt-1", kind="file_changed", actor="system",
                                   evidence="other.md")
            self.assertEqual(store.context()["unorganized_events"], 1)

    def test_event_distillation_and_schema_migration(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            store.record_event(op_id="observed-a", kind="observation", actor="agent",
                               evidence="file-a")
            store.record_event(op_id="observed-b", kind="observation", actor="agent",
                               evidence="file-b")
            self.assertEqual(len(store.pending_events()), 2)
            insight = store.distill_events(title="Input findings", summary="Two sources agree",
                                           source_op_ids=["observed-a", "observed-b"],
                                           reason="Evidence synthesis", op_id="distill-1")
            self.assertEqual(store.context()["unorganized_events"], 0)
            self.assertEqual(store.health()["pending_events"], 0)
            self.assertEqual(store.health()["integrity"], "ok")
            self.assertEqual(len(store.export()["event_distillations"]), 2)
            retried = store.distill_events(title="Input findings", summary="Two sources agree",
                                           source_op_ids=["observed-a", "observed-b"],
                                           reason="Evidence synthesis", op_id="distill-1")
            self.assertEqual(retried["id"], insight["id"])
            with self.assertRaises(Conflict):
                store.distill_events(title="Input findings", summary="Different claim",
                                     source_op_ids=["observed-a", "observed-b"],
                                     reason="Evidence synthesis", op_id="distill-1")
            database = store.db_path
        # A store created by the previous schema upgrades without discarding its
        # existing events, which is the migration path for early local builds.
        with closing(sqlite3.connect(database)) as db:
            with db:
                db.execute("DROP TABLE event_distillations")
                db.execute("UPDATE metadata SET value='1' WHERE key='schema'")
        with Store(self.root, data_home=self.data) as store:
            self.assertEqual(store.db.execute(
                "SELECT value FROM metadata WHERE key='schema'").fetchone()[0], "2")
            self.assertEqual(len(store.pending_events()), 2)

    def test_anchor_observations_track_repeated_edits_and_unknown_reasons(self) -> None:
        product = self.root / "product.txt"
        product.write_text("original", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="artifact", kind="artifact", title="Product",
                              freshness="current")
            store.anchor("artifact", "product.txt")
            store.reconcile_anchors()
            self.assertEqual(store.pending_events(), [])
            for content in ("first edit", "second edit"):
                product.write_text(content, encoding="utf-8")
                store.reconcile_anchors(session_id="interrupted")
                store.reconcile_anchors(session_id="interrupted")
            self.assertEqual(len(store.pending_events()), 2)
            product.unlink()
            store.reconcile_anchors()
            product.write_text("original", encoding="utf-8")
            store.reconcile_anchors()
            self.assertEqual(store.node("artifact")["freshness"], "unverified")

        with Store(self.root, data_home=self.data) as store:
            pending = store.pending_events()
            self.assertEqual(len(pending), 4)
            snapshots = [json.loads(event["after_json"]) for event in pending]
            self.assertEqual([item["status"] for item in snapshots],
                             ["stale", "stale", "unverified", "current"])
            self.assertNotEqual(snapshots[0]["sha256"], snapshots[1]["sha256"])
            self.assertIsNone(snapshots[2]["sha256"])
            self.assertTrue(all(event["node_id"] == "artifact" and
                                event["reason"] is None for event in pending))
            self.assertTrue(all(item["reason_status"] == "unknown" for item in snapshots))
            self.assertEqual(pending[0]["session_id"], "interrupted")
            self.assertEqual(store.context()["unorganized_events"], 4)
            request = dict(title="Product state transitions",
                           summary="Two edits, loss and restoration observed; reasons unknown",
                           source_op_ids=[event["op_id"] for event in pending],
                           topic_id="artifact", reason="Group the recorded file observations",
                           op_id="distill-anchor-observations")
            insight = store.distill_events(**request)
            self.assertEqual(store.distill_events(**request)["id"], insight["id"])
            self.assertEqual(store.health()["pending_events"], 0)
            self.assertEqual(store.context()["unorganized_events"], 0)
            self.assertTrue(all(store.db.execute(
                "SELECT reason FROM events WHERE op_id=?", (event["op_id"],)
            ).fetchone()[0] is None for event in pending))

    def test_anchor_observation_write_failure_rolls_back_and_retries(self) -> None:
        product = self.root / "product.txt"
        product.write_text("original", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="artifact", kind="artifact", title="Product",
                              freshness="current")
            store.anchor("artifact", "product.txt")
            product.write_text("edited", encoding="utf-8")
            original_event = store._event

            def fail_status_write(*args: object) -> None:
                if args[4] == "anchor_node_status":
                    raise sqlite3.IntegrityError("injected observation failure")
                original_event(*args)

            with patch.object(store, "_event", side_effect=fail_status_write):
                with self.assertRaises(sqlite3.IntegrityError):
                    store.reconcile_anchors()

        with Store(self.root, data_home=self.data) as store:
            self.assertEqual(store.pending_events(), [])
            self.assertEqual(store.node("artifact")["freshness"], "current")
            self.assertEqual(store.db.execute(
                "SELECT status FROM anchors WHERE node_id='artifact'").fetchone()[0], "current")
            store.reconcile_anchors()
            self.assertEqual(len(store.pending_events()), 1)
            self.assertIsNone(store.pending_events()[0]["reason"])
            self.assertEqual(store.node("artifact")["freshness"], "stale")

    def test_anchor_observation_refuses_an_escaping_reference(self) -> None:
        product = self.root / "product.txt"
        product.write_text("original", encoding="utf-8")
        outside = self.base / "outside.txt"
        outside.write_text("outside private contents", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="artifact", kind="artifact", title="Product")
            store.anchor("artifact", "product.txt")
            with store.db:
                store.db.execute("UPDATE anchors SET path='../outside.txt'")
            store.reconcile_anchors()
            pending = store.pending_events()
            self.assertEqual(len(pending), 1)
            snapshot = json.loads(pending[0]["after_json"])
            self.assertEqual(snapshot["status"], "unverified")
            self.assertIsNone(snapshot["sha256"])
            self.assertNotIn("outside private contents", str(store.export()))

    def test_anchor_observation_process_exit_rolls_back(self) -> None:
        product = self.root / "product.txt"
        product.write_text("original", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="artifact", kind="artifact", title="Product",
                              freshness="current")
            store.anchor("artifact", "product.txt")
        product.write_text("edited", encoding="utf-8")
        script = (
            "import os, sys\n"
            "from mindwise.core import Store\n"
            "with Store(sys.argv[1], data_home=sys.argv[2]) as store:\n"
            "    original = store._event\n"
            "    def interrupted(*args):\n"
            "        if args[4] == 'anchor_node_status': os._exit(23)\n"
            "        original(*args)\n"
            "    store._event = interrupted\n"
            "    store.reconcile_anchors()\n"
        )
        env = os.environ.copy()
        env["PYTHONPATH"] = str(Path(__file__).parents[1] / "src")
        stopped = subprocess.run([sys.executable, "-c", script,
                                  str(self.root), str(self.data)],
                                 capture_output=True, env=env, timeout=10)
        self.assertEqual(stopped.returncode, 23, stopped.stderr)
        with Store(self.root, data_home=self.data) as store:
            self.assertEqual(store.pending_events(), [])
            self.assertEqual(store.node("artifact")["freshness"], "current")
            store.reconcile_anchors()
            self.assertEqual(len(store.pending_events()), 1)
            self.assertIsNone(store.pending_events()[0]["reason"])

    def test_distillation_association_failure_rolls_back_and_retries(self) -> None:
        request = dict(title="Input findings", summary="Two sources agree",
                       source_op_ids=["observed-a", "observed-b"],
                       reason="Evidence synthesis", op_id="distill-1")
        with Store(self.root, data_home=self.data, create=True) as store:
            for source in request["source_op_ids"]:
                store.record_event(op_id=source, kind="observation", actor="agent")
            store.db.execute(
                "CREATE TRIGGER fail_second_distillation BEFORE INSERT ON event_distillations "
                "WHEN NEW.event_op_id='observed-b' BEGIN SELECT RAISE(FAIL, 'interrupted'); END")
            with self.assertRaises(sqlite3.IntegrityError):
                store.distill_events(**request)
            store.db.execute("DROP TRIGGER fail_second_distillation")

        with Store(self.root, data_home=self.data) as store:
            self.assertEqual(len(store.pending_events()), 2)
            self.assertEqual(store.db.execute(
                "SELECT count(*) FROM nodes WHERE kind='insight'").fetchone()[0], 0)
            self.assertEqual(len(store.export()["event_distillations"]), 0)
            self.assertIsNone(store.db.execute(
                "SELECT 1 FROM events WHERE op_id=?", (request["op_id"],)).fetchone())
            insight = store.distill_events(**request)
            self.assertEqual(store.distill_events(**request)["id"], insight["id"])
            self.assertEqual(len(store.export()["event_distillations"]), 2)
            self.assertEqual(len(store.pending_events()), 0)

    def test_distillation_topic_failure_rolls_back_sources(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            topic = store.upsert_node(kind="topic", title="Inputs", reason="Test subject")
            store.record_event(op_id="observed-a", kind="observation", actor="agent")
            request = dict(title="Input finding", summary="One source", topic_id=topic["id"],
                           source_op_ids=["observed-a"], reason="Evidence synthesis",
                           op_id="distill-topic")
            with patch.object(store, "link", side_effect=RuntimeError("interrupted")):
                with self.assertRaises(RuntimeError):
                    store.distill_events(**request)

        with Store(self.root, data_home=self.data) as store:
            self.assertEqual(len(store.pending_events()), 1)
            self.assertEqual(len(store.export()["event_distillations"]), 0)
            insight = store.distill_events(**request)
            self.assertEqual(store.distill_events(**request)["id"], insight["id"])
            self.assertEqual(store.db.execute(
                "SELECT count(*) FROM edges WHERE source_id=? AND target_id=? AND kind='parent_of'",
                (topic["id"], insight["id"])).fetchone()[0], 1)
            self.assertEqual(len(store.pending_events()), 0)

    def test_distillation_process_exit_leaves_reason_unknown(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            topic = store.upsert_node(kind="topic", title="Inputs", reason="Test subject")
            store.record_event(op_id="observed-a", kind="observation", actor="system")

        script = (
            "import os, sys\n"
            "from mindwise.core import Store\n"
            "with Store(sys.argv[1], data_home=sys.argv[2]) as store:\n"
            "    store.link = lambda *args, **kwargs: os._exit(23)\n"
            "    store.distill_events(title='Input finding', summary='One source', "
            "source_op_ids=['observed-a'], reason='Evidence synthesis', "
            "topic_id=sys.argv[3], op_id='distill-crash')\n"
        )
        environment = os.environ.copy()
        environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
        interrupted = subprocess.run(
            [sys.executable, "-c", script, str(self.root), str(self.data), topic["id"]],
            env=environment, capture_output=True, text=True, check=False,
        )
        self.assertEqual(interrupted.returncode, 23, interrupted.stderr)

        with Store(self.root, data_home=self.data) as store:
            pending = store.pending_events()
            self.assertEqual([event["op_id"] for event in pending], ["observed-a"])
            self.assertIsNone(pending[0]["reason"])
            self.assertEqual(store.health()["pending_events"], 1)
            self.assertEqual(len(store.export()["event_distillations"]), 0)
            self.assertEqual(store.db.execute(
                "SELECT count(*) FROM nodes WHERE kind='insight'").fetchone()[0], 0)
            self.assertIsNone(store.db.execute(
                "SELECT 1 FROM events WHERE op_id='distill-crash'").fetchone())

    def test_context_keeps_goal_and_position_with_bounded_output(self) -> None:
        for name in ("GOAL.md", "DESIGN_STANDARD.md", "DISCOVERY_LOG.md"):
            (self.root / name).write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 1\n"
                "- **状態**: ACTIVE\n## Purpose\nMake a small game.\n",
                encoding="utf-8")
        self.record_contract_approval()
        (self.root / "HANDOFF.md").write_text(
            "# Handoff\n- **現在地**: Input design is under review.\n"
            "## 次の一手\n\nCheck controller latency.\n", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            project_sections(store)
            for index in range(30):
                store.upsert_node(node_id=f"detail-{index}", kind="specification",
                                  title=f"Detail {index}", body="long description " * 10)
            context = store.context(max_chars=900)
            self.assertLessEqual(len(json.dumps(context, ensure_ascii=False)), 900)
            self.assertEqual(context["orientation"]["goal"], "Make a small game.")
            self.assertIn("Input design", context["orientation"]["position"])
            self.assertGreater(context["omitted_count"], 0)

    def test_context_offer_binds_generation_versions_and_current_receipt(self) -> None:
        with Store(self.root, data_home=self.data, create=True) as store:
            store.upsert_node(node_id="choice", kind="decision", title="Receipt policy",
                              body="before", application="adopted")
            first = store.deliver_context(session_id="a", request_id="startup", max_chars=900)
            self.assertLessEqual(len(json.dumps(first, ensure_ascii=False)), 900)
            self.assertEqual(first["items"][0]["version"], 1)
            self.assertEqual(store.context_delivery_status("b")["status"], "never_offered")
            store.acknowledge_context(bundle_id=first["bundle_id"])
            self.assertEqual(store.deliver_context(session_id="a", request_id="startup",
                                                  max_chars=900)["bundle_id"], first["bundle_id"])
            store.upsert_node(node_id="choice", kind="decision", title="Receipt policy",
                              body="after", application="adopted", base_version=1)
            changed = store.deliver_context(session_id="a", request_id="startup", max_chars=900)
            self.assertNotEqual(changed["bundle_id"], first["bundle_id"])
            self.assertNotEqual(changed["generation"], first["generation"])
            self.assertEqual(changed["items"][0]["version"], 2)
            self.assertFalse(store.acknowledge_context(bundle_id=first["bundle_id"]))
            self.assertEqual(store.context_delivery_status("a")["status"], "offered_unconfirmed")
            store.acknowledge_context(bundle_id=changed["bundle_id"])
            self.assertEqual(store.context_delivery_status("a")["status"], "acknowledged")
            store.record_event(op_id="pending-fact", kind="observation", actor="agent",
                               reason="A new recorded fact needs organization")
            pending = store.deliver_context(session_id="a", request_id="startup", max_chars=900)
            self.assertNotEqual(pending["bundle_id"], changed["bundle_id"])
            self.assertEqual(pending["unorganized_events"], 1)
            self.assertEqual(pending["items"][0]["version"], 2)

    def test_handoff_change_invalidates_receipt_without_map_changes(self) -> None:
        handoff = self.root / "HANDOFF.md"
        handoff.write_text("- **現在地**: Before\n## 次の一手\nFirst\n", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            first = store.deliver_context(session_id="a", request_id="same")
            store.acknowledge_context(bundle_id=first["bundle_id"])
            handoff.write_text("- **現在地**: After\n## 次の一手\nSecond\n", encoding="utf-8")
            changed = store.deliver_context(session_id="a", request_id="same")
            self.assertNotEqual(first["bundle_id"], changed["bundle_id"])
            self.assertEqual(changed["orientation"]["position"], "After")
            self.assertEqual(changed["orientation"]["next_action"], "Second")
            self.assertEqual(store.context_delivery_status("a")["status"], "offered_unconfirmed")

    def test_new_session_recovers_corrected_decision_without_old_choice(self) -> None:
        for name in ("GOAL.md", "DESIGN_STANDARD.md", "DISCOVERY_LOG.md"):
            (self.root / name).write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 1\n"
                "- **状態**: ACTIVE\n## Purpose\nBuild a readable book.\n",
                encoding="utf-8")
        self.record_contract_approval()
        (self.root / "HANDOFF.md").write_text(
            "# Handoff\n- **現在地**: Drafting chapter three.\n"
            "## 次の一手\n\nCheck quotations.\n", encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            project_sections(store)
            purpose = store.db.execute(
                "SELECT id FROM nodes WHERE strategy_ref LIKE 'GOAL.md:%' "
                "AND title='Purpose'").fetchone()[0]
            decision = store.record_decision(
                title="Citation method", purpose_id=purpose, choice="unverified quotes",
                reason="initial draft", scope="chapter three", op_id="citation-v1")
            decision_id = decision["id"]
        with Store(self.root, data_home=self.data) as store:
            first = store.context()
            self.assertIn("Build a readable book", first["orientation"]["goal"])
            self.assertIn("Drafting chapter three", first["orientation"]["position"])
            self.assertIn("unverified quotes", json.dumps(first["items"]))
            store.update_decision(
                decision_id, title="Citation method", choice="source-checked quotes",
                reason="verified against original text", alternatives=[],
                reconsider_when=None, base_version=1, op_id="citation-v2")
        with Store(self.root, data_home=self.data) as store:
            current = store.context()
            items = json.dumps(current["items"])
            self.assertIn("source-checked quotes", items)
            self.assertNotIn("unverified quotes", items)
            self.assertEqual(store.node(decision_id)["version"], 2)

    def test_contract_reports_missing_and_projects_idempotently(self) -> None:
        (self.root / "GOAL.md").write_text(
            "# Goal\n- **共通契約リビジョン**: Rev 1\n- **状態**: DRAFT\n"
            "## 目的\n本を書く。\n", encoding="utf-8")
        report = inspect(self.root)
        self.assertFalse(report["compatible"])
        self.assertEqual(report["documents"]["DESIGN_STANDARD.md"]["status"], "missing")
        with Store(self.root, data_home=self.data, create=True) as store:
            projected = project_sections(store)
            self.assertEqual(projected["projected_sections"], 1)
            self.assertEqual(len(store.search("目的")), 1)
            self.assertEqual(store.search("目的")[0]["application"], "proposed")
            project_sections(store)
            self.assertEqual(store.search("目的")[0]["version"], 1)
            for name in ("GOAL.md", "DESIGN_STANDARD.md", "DISCOVERY_LOG.md"):
                (self.root / name).write_text(
                    "# Contract\n- **共通契約リビジョン**: Rev 1\n"
                    "- **状態**: APPROVED\n## 目的\n本を書く。\n", encoding="utf-8")
            self.record_contract_approval()
            self.assertTrue(inspect(self.root)["compatible"])
            project_sections(store)
            self.assertEqual(store.search("目的")[0]["application"], "adopted")
            source = next(node for node in store.search("目的")
                          if node["strategy_ref"].startswith("GOAL.md:"))
            store.upsert_node(node_id="implementation", kind="specification",
                              title="Implementation")
            store.link("implementation", source["id"], "depends_on")
            (self.root / "GOAL.md").write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 1\n"
                "- **状態**: APPROVED\n## 新しい目的\n本を書く。\n", encoding="utf-8")
            updated = project_sections(store)
            self.assertIn(source["id"], updated["retired_sections"])
            self.assertEqual(updated["affected_connections"][0]["other_id"],
                             "implementation")

    def test_contract_approval_history_requires_a_later_owner_decision(self) -> None:
        for name in ("GOAL.md", "DESIGN_STANDARD.md", "DISCOVERY_LOG.md"):
            (self.root / name).write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 1\n"
                "- **状態**: APPROVED\n## Purpose\nWrite a book.\n",
                encoding="utf-8",
            )
        log = self.root / "DISCOVERY_LOG.md"
        with Store(self.root, data_home=self.data, create=True) as store:
            first = project_sections(store)
            self.assertTrue(first["compatible"])
            self.assertEqual(first["approval"]["status"], "missing")
            self.assertEqual(store.search("Purpose")[0]["application"], "proposed")

            log.write_text(log.read_text(encoding="utf-8")
                           + "\n## 1. Rev 1 未承認\nThe owner has not approved this draft.\n",
                           encoding="utf-8")
            self.assertEqual(project_sections(store)["approval"]["status"], "pending")

            log.write_text(log.read_text(encoding="utf-8")
                           + "\n## 2. Rev 1 承認\n- **承認者**: オーナー\n"
                           "- **承認対象**: Rev 1の三文書\n",
                           encoding="utf-8")
            adopted_report = project_sections(store)
            self.assertEqual(adopted_report["approval"]["status"], "confirmed")
            adopted = next(item for item in store.search("Purpose")
                           if item["application"] == "adopted")

            log.write_text(log.read_text(encoding="utf-8")
                           + "\n## 3. Rev 1 却下\nFurther review is required.\n",
                           encoding="utf-8")
            rejected_report = project_sections(store)
            self.assertEqual(rejected_report["approval"]["status"], "rejected")
            self.assertEqual(store.node(adopted["id"])["application"], "adopted")

            log.write_text(log.read_text(encoding="utf-8")
                           + "\n## 4. Rev 1 再承認\n- **承認者**: オーナー\n"
                           "- **承認対象**: Rev 1の三文書\n",
                           encoding="utf-8")
            latest = project_sections(store)
            self.assertEqual(latest["approval"]["status"], "confirmed")
            self.assertEqual(store.node(adopted["id"])["application"], "adopted")

    def test_ambiguous_later_approval_record_blocks_promotion(self) -> None:
        for name in ("GOAL.md", "DESIGN_STANDARD.md", "DISCOVERY_LOG.md"):
            (self.root / name).write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 1\n"
                "- **状態**: APPROVED\n## Purpose\nWrite a book.\n",
                encoding="utf-8",
            )
        self.record_contract_approval()
        log = self.root / "DISCOVERY_LOG.md"
        log.write_text(log.read_text(encoding="utf-8")
                       + "\n## 2. Rev 1 review\n- **承認判断**: 保留\n",
                       encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            report = project_sections(store)
            self.assertEqual(report["approval"]["status"], "pending")
            self.assertEqual(store.search("Purpose")[0]["application"], "proposed")
            log.write_text(log.read_text(encoding="utf-8")
                           + "\n## 3. Rev 1 review\n- **承認判断**: APPROVED\n",
                           encoding="utf-8")
            report = project_sections(store)
            self.assertEqual(report["approval"]["status"], "ambiguous")
            self.assertEqual(store.search("Purpose")[0]["application"], "proposed")

    def test_tentative_approval_basis_does_not_promote_contract(self) -> None:
        for name in ("GOAL.md", "DESIGN_STANDARD.md", "DISCOVERY_LOG.md"):
            (self.root / name).write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 1\n"
                "- **状態**: APPROVED\n## Purpose\nWrite a book.\n",
                encoding="utf-8",
            )
        log = self.root / "DISCOVERY_LOG.md"
        log.write_text(log.read_text(encoding="utf-8")
                       .replace("## Purpose", "- **承認根拠**: オーナーへの確認中\n## Purpose"),
                       encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            report = project_sections(store)
            self.assertEqual(report["approval"]["status"], "pending")
            self.assertEqual(store.search("Purpose")[0]["application"], "proposed")

    def test_approval_basis_for_other_revision_does_not_promote_contract(self) -> None:
        for name in ("GOAL.md", "DESIGN_STANDARD.md", "DISCOVERY_LOG.md"):
            (self.root / name).write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 2\n"
                "- **状態**: APPROVED\n## Purpose\nWrite a book.\n",
                encoding="utf-8",
            )
        log = self.root / "DISCOVERY_LOG.md"
        log.write_text(log.read_text(encoding="utf-8")
                       .replace("## Purpose", "- **承認根拠**: オーナーはRev 1を承認\n## Purpose"),
                       encoding="utf-8")
        with Store(self.root, data_home=self.data, create=True) as store:
            report = project_sections(store)
            self.assertEqual(report["approval"]["status"], "missing")
            self.assertEqual(store.search("Purpose")[0]["application"], "proposed")

    def test_incomplete_revision_does_not_demote_approved_strategy(self) -> None:
        for name in ("GOAL.md", "DESIGN_STANDARD.md", "DISCOVERY_LOG.md"):
            (self.root / name).write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 1\n"
                "- **状態**: APPROVED\n## 目的\n本を書く。\n", encoding="utf-8")
        self.record_contract_approval()
        with Store(self.root, data_home=self.data, create=True) as store:
            project_sections(store)
            adopted = next(item for item in store.search("目的")
                           if item["strategy_ref"].startswith("GOAL.md:"))
            (self.root / "DESIGN_STANDARD.md").unlink()
            (self.root / "GOAL.md").write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 2\n"
                "- **状態**: DRAFT\n## 目的\n別の本を書く。\n", encoding="utf-8")
            report = project_sections(store)
            self.assertFalse(report["compatible"])
            self.assertEqual(store.node(adopted["id"])["application"], "adopted")
            self.assertEqual(store.node(adopted["id"])["body"], "本を書く。")
            proposals = [item for item in store.search("目的")
                         if item["application"] == "proposed"]
            self.assertEqual(len(proposals), 1)
            self.assertEqual(proposals[0]["body"], "別の本を書く。")

    def test_contract_rows_keep_stable_ids_and_source_lines(self) -> None:
        rows = {"GOAL.md": "| D1 | Local map core |\n| A1 | Show draft strategy |\n",
                "DESIGN_STANDARD.md": "| T1 | Read contract | All rows traced |\n",
                "DISCOVERY_LOG.md": ""}
        for name, row_text in rows.items():
            (self.root / name).write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 1\n"
                "- **状態**: APPROVED\n## Scope\n" + row_text,
                encoding="utf-8")
        self.record_contract_approval()
        with Store(self.root, data_home=self.data, create=True) as store:
            report = project_sections(store)
            self.assertEqual(report["projected_sections"], 5)
            acceptance = store.search("A1 Show")[0]
            self.assertEqual(acceptance["kind"], "acceptance")
            self.assertEqual(acceptance["strategy_ref"], "GOAL.md:6@Rev 1")
            (self.root / "GOAL.md").write_text(
                "# Contract\n- **共通契約リビジョン**: Rev 2\n"
                "- **状態**: APPROVED\n## Scope\n"
                "| D1 | Local map core |\n| A1 | Show approved and draft strategy |\n",
                encoding="utf-8")
            for name in ("DESIGN_STANDARD.md", "DISCOVERY_LOG.md"):
                old = (self.root / name).read_text(encoding="utf-8")
                (self.root / name).write_text(old.replace("Rev 1", "Rev 2"), encoding="utf-8")
            project_sections(store)
            revised = store.search("A1 Show")[0]
            self.assertEqual(revised["id"], acceptance["id"])
            self.assertEqual(revised["version"], 2)


if __name__ == "__main__":
    unittest.main()
