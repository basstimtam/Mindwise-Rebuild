from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from mindwise.changes import record, associations
from mindwise.core import Conflict, MindwiseError, Store
from mindwise.evidence import explain


class ChangeAssociationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name) / "project"
        self.root.mkdir()
        self.data = Path(self.temp.name) / "data"
        self.file = self.root / "artifact.txt"
        self.file.write_text("before", encoding="utf-8")
        self.store = Store(self.root, data_home=self.data, create=True)
        self.purpose = self.store.upsert_node(kind="strategy", title="Purpose")
        self.target = self.store.upsert_node(kind="artifact", title="Target")
        self.other = self.store.upsert_node(kind="artifact", title="Other")
        self.store.anchor(self.target["id"], "artifact.txt")
        self.decision = self.store.record_decision(
            title="Recorded choice", purpose_id=self.purpose["id"], choice="Original choice",
            reason="Original reason", scope="Declared target", applies_to=[self.target["id"]],
            alternatives=[{"option": "Other", "reason": "Original rejection"}],
            session_id="decision-session", op_id="decision-original")

    def tearDown(self) -> None:
        self.store.close()
        self.temp.cleanup()

    def change(self, value: str = "after") -> str:
        self.file.write_text(value, encoding="utf-8")
        self.store.reconcile_anchors(session_id="observation-session")
        return self.store.pending_events()[-1]["op_id"]

    def declare(self, sources: list[str], **overrides):
        arguments = dict(decision_id=self.decision["id"], decision_op_id="decision-original",
                         source_op_ids=sources, reason="Explicit implementation association",
                         evidence="Fixture", session_id="declaring-session", op_id="link-receipt")
        arguments.update(overrides)
        return record(self.store, **arguments)

    def test_explicit_shared_reference_preserves_observations_and_pending_status(self) -> None:
        source = self.change()
        raw = self.store.pending_events()
        receipt = self.declare([source, source])
        self.assertTrue(receipt["stored"])
        self.assertEqual(receipt["operation_id"], "decision-original")
        self.assertEqual(self.store.pending_events(), raw)
        before = self.store.export()
        card = explain(self.store, self.decision["id"])
        link = card["change_links"]["items"][0]
        self.assertEqual(link["status"], "declared")
        self.assertEqual(link["decision_snapshot"]["choice"], "Original choice")
        self.assertEqual(link["sources"][0]["reason"], None)
        self.assertEqual(link["sources"][0]["path"], "artifact.txt")
        self.assertEqual(link["sources"][0]["recording_order"], "decision_before_observation")
        self.assertEqual(link["editing_order"], "not_inferred_from_observation_order")
        self.assertEqual(link["causal_validity"], "not_established_by_declaration")
        self.assertEqual(self.store.export(), before)
        self.assertEqual(len(self.store.db.execute(
            "SELECT op_id FROM events WHERE op_id='decision-original'").fetchall()), 1)

    def test_exact_retry_survives_later_mutable_state_and_conflicting_retry_is_rejected(self) -> None:
        source = self.change()
        first = self.declare([source])
        self.store.update_decision(self.decision["id"], title="Revised", choice="Revised choice",
                                   reason="Revised reason", alternatives=[], reconsider_when=None,
                                   base_version=self.decision["version"], op_id="revised-decision")
        with self.store.db:
            self.store.db.execute("DELETE FROM edges WHERE source_id=? AND target_id=? AND kind='applies_to'",
                                  (self.target["id"], self.decision["id"]))
        second = self.declare([source])
        self.assertFalse(second["stored"])
        self.assertEqual(first["event_op_id"], second["event_op_id"])
        before = self.store.export()
        with self.assertRaises(Conflict):
            self.declare([source], session_id="different-session")
        with self.assertRaises(Conflict):
            self.declare([source], reason="Different association reason")
        self.assertEqual(self.store.export(), before)
        link = associations(self.store, self.decision["id"])["items"][0]
        self.assertEqual(link["decision_snapshot"]["choice"], "Original choice")
        self.assertFalse(link["matches_current_decision_version"])
        self.assertEqual(link["sources"][0]["reason"], None)

    def test_invalid_and_mixed_inputs_leave_no_association(self) -> None:
        valid = self.change()
        self.store.anchor(self.other["id"], "artifact.txt")
        self.change("another edit")
        outside = next(e["op_id"] for e in self.store.pending_events()
                       if e["node_id"] == self.other["id"])
        self.store.record_event(op_id="not-an-observation", kind="PostToolUse", actor="fixture")
        before = self.store.export()
        for sources, overrides in [
            ([valid, "missing"], {}), ([valid, outside], {}), (["not-an-observation"], {}),
            ([valid], {"decision_op_id": "not-an-observation"}),
            ([valid], {"decision_id": self.target["id"]}), ([], {}),
            ([f"source-{index}" for index in range(21)], {}),
        ]:
            with self.subTest(sources=sources, overrides=overrides):
                with self.assertRaises(MindwiseError):
                    self.declare(sources, **overrides)
                self.assertEqual(self.store.export(), before)

    def test_observation_before_decision_remains_retrospective_and_unproven(self) -> None:
        source = self.change()
        later = self.store.record_decision(
            title="Later choice", purpose_id=self.purpose["id"], choice="Later",
            reason="Later recorded reason", scope="Declared target", applies_to=[self.target["id"]],
            op_id="decision-later")
        self.declare([source], decision_id=later["id"], decision_op_id="decision-later")
        link = associations(self.store, later["id"])["items"][0]
        self.assertEqual(link["sources"][0]["recording_order"], "observation_before_decision")
        self.assertEqual(link["editing_order"], "not_inferred_from_observation_order")
        self.assertIsNone(link["sources"][0]["reason"])

    def test_storage_failure_reopen_and_same_receipt_recovery(self) -> None:
        source = self.change()
        before = self.store.export()
        self.store.db.execute("CREATE TRIGGER fail_change_link BEFORE INSERT ON events "
                              "WHEN NEW.kind='decision_change_link' BEGIN "
                              "SELECT RAISE(ABORT, 'injected association failure'); END")
        self.store.db.commit()
        with self.assertRaises(sqlite3.Error):
            self.declare([source])
        self.store.close()
        self.store = Store(self.root, data_home=self.data)
        self.assertEqual(self.store.export(), before)
        self.assertIsNone(self.store.pending_events()[0]["reason"])
        self.store.db.execute("DROP TRIGGER fail_change_link")
        self.store.db.commit()
        self.assertTrue(self.declare([source])["stored"])
        self.assertFalse(self.declare([source])["stored"])

    def test_read_cap_malformed_declarations_and_public_roundtrip(self) -> None:
        source = self.change()
        for index in range(12):
            self.declare([source], op_id=f"link-{index}")
        self.store.record_event(op_id="malformed-link", kind="decision_change_link", actor="fixture",
                                node_id=self.decision["id"], details={"operation_id": []})
        view = associations(self.store, self.decision["id"], limit=10)
        self.assertEqual(view["total"], 13)
        self.assertEqual(view["omitted_count"], 3)
        self.assertEqual(len(view["items"]), 10)
        self.assertEqual(view["items"][0]["status"], "invalid_declaration")
        exported = self.store.export()
        with Store(self.root, data_home=Path(self.temp.name) / "imported", create=True) as restored:
            restored.import_snapshot(exported)
            self.assertEqual(restored.export(), exported)
            self.assertEqual(associations(restored, self.decision["id"], limit=10), view)
            self.assertIsNone(restored.pending_events()[0]["reason"])

    def test_malformed_imported_reference_is_refused_without_mutation(self) -> None:
        source = self.change()
        for index, (operation, field, value) in enumerate([
            ("decision-original", "application", []), (source, "status", {}),
        ]):
            exported = self.store.export()
            altered = next(event for event in exported["events"] if event["op_id"] == operation)
            snapshot = json.loads(altered["after_json"])
            snapshot[field] = value
            altered["after_json"] = json.dumps(snapshot)
            with Store(self.root, data_home=Path(self.temp.name) / f"malformed-{index}",
                       create=True) as restored:
                restored.import_snapshot(exported)
                before = restored.export()
                with self.assertRaises(MindwiseError):
                    record(restored, decision_id=self.decision["id"],
                           decision_op_id="decision-original", source_op_ids=[source],
                           reason="Explicit association", op_id="bad-reference")
                self.assertEqual(restored.export(), before)

    def test_untyped_declaration_with_null_reason_is_not_validated_by_read(self) -> None:
        source = self.change()
        self.declare([source])
        payload = json.loads(self.store.db.execute(
            "SELECT after_json FROM events WHERE op_id='link-receipt'").fetchone()[0])
        self.store.record_event(op_id="raw-null-reason", kind="decision_change_link", actor="agent",
                                node_id=self.decision["id"], details=payload, reason=None)
        item = associations(self.store, self.decision["id"])["items"][0]
        self.assertEqual(item["status"], "invalid_declaration")
        self.assertEqual(item["reference_validity"], "unconfirmed")
        self.assertIsNone(self.store.pending_events()[0]["reason"])

    def test_incomplete_raw_receipt_is_not_confirmed_as_a_typed_retry(self) -> None:
        source = self.change()
        self.store.record_event(
            op_id="link-receipt", kind="decision_change_link", actor="agent",
            node_id=self.decision["id"], session_id="declaring-session",
            reason="Explicit implementation association", evidence="Fixture",
            details={"type": "explicit_decision_change_link", "decision_id": self.decision["id"],
                     "operation_id": "decision-original", "source_event_op_ids": [source]})
        before = self.store.export()
        with self.assertRaises(MindwiseError):
            self.declare([source])
        self.assertEqual(self.store.export(), before)
        self.assertEqual(associations(self.store, self.decision["id"])["items"][0]["status"],
                         "invalid_declaration")


if __name__ == "__main__":
    unittest.main()
