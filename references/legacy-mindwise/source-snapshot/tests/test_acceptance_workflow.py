"""End-to-end T3/T6 exercises across separate store sessions and real files."""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from mindwise.core import Store
from mindwise.coverage import report as coverage_report
from mindwise.verification import record as record_verification, status as verification_status


class AcceptanceWorkflowTests(unittest.TestCase):
    def test_failed_product_edit_and_recovery_do_not_claim_verification(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "registered-project"
            root.mkdir()
            product = root / "product.txt"
            product.write_text("version one", encoding="utf-8")
            config = root / "config.txt"
            config.write_text("version one", encoding="utf-8")
            (root / "check.txt").write_text("pass for version one", encoding="utf-8")
            data = base / "data"
            with Store(root, data_home=data, create=True) as store:
                store.upsert_node(node_id="shared", kind="specification", title="Shared rule",
                                  body="version one", freshness="current",
                                  application="verified", evidence="owner review")
                store.upsert_node(node_id="local", kind="specification", title="Local rule",
                                  freshness="current", application="verified",
                                  evidence="owner review")
                store.upsert_node(node_id="artifact", kind="artifact", title="Product",
                                  freshness="current", application="implemented")
                store.upsert_node(node_id="exception", kind="specification", title="Exception",
                                  freshness="current", application="adopted")
                store.upsert_node(node_id="unrelated", kind="specification", title="Other",
                                  freshness="current", application="verified",
                                  evidence="separate review")
                store.link("local", "shared", "depends_on")
                store.link("artifact", "local", "implements")
                store.link("exception", "shared", "applies_to")
                store.link("exception", "shared", "exception_to",
                           evidence="explicit local exception")
                store.anchor("artifact", "product.txt")
                store.anchor("artifact", "config.txt")
                check = record_verification(store, target_id="artifact", title="Product check",
                                            method="compare with rule", outcome="pass",
                                            evidence_file="check.txt", reason="observed version one")
                check_id = check["id"]
                preview = store.preview_text_update("shared", title="Shared rule",
                                                    body="version two", base_version=1)
                self.assertEqual({item["node"]["id"] for item in preview["affected"]},
                                 {"local", "artifact", check_id})
                self.assertEqual(preview["exceptions"][0]["node"]["id"], "exception")
                store.update_text("shared", title="Shared rule", body="version two",
                                  base_version=1, reason="approved implementation choice")
                product.write_text("version two", encoding="utf-8")
                with self.assertRaises(FileNotFoundError):
                    (root / "missing-output" / "config.txt").write_text(
                        "version two", encoding="utf-8")

            with Store(root, data_home=data) as store:
                self.assertEqual(product.read_text(encoding="utf-8"), "version two")
                self.assertEqual(config.read_text(encoding="utf-8"), "version one")
                self.assertEqual(store.node("shared")["application"], "adopted")
                self.assertEqual(store.node("artifact")["freshness"], "stale")
                self.assertEqual(store.node("exception")["freshness"], "current")
                self.assertEqual(store.node("unrelated")["freshness"], "current")
                self.assertFalse(verification_status(store, check_id)
                                 ["eligible_for_acceptance_review"])
                config.write_text("version two", encoding="utf-8")
                store.reconcile_anchors()
                self.assertEqual(store.node("artifact")["freshness"], "stale")
                self.assertFalse(verification_status(store, check_id)
                                 ["eligible_for_acceptance_review"])
                store.anchor("artifact", "product.txt")
                store.anchor("artifact", "config.txt")
                artifact = store.node("artifact")
                store.upsert_node(node_id="artifact", kind="artifact", title="Product",
                                  freshness="current", application="implemented",
                                  base_version=artifact["version"],
                                  reason="both output files inspected after recovery",
                                  evidence="product.txt and config.txt")
                (root / "check-v2.txt").write_text("pass for version two", encoding="utf-8")
                new_check = record_verification(
                    store, target_id="artifact", title="Product check after recovery",
                    method="compare both files with rule", outcome="pass",
                    evidence_file="check-v2.txt", reason="observed version two")
                self.assertTrue(verification_status(store, new_check["id"])
                                ["eligible_for_acceptance_review"])
                self.assertFalse(verification_status(store, check_id)
                                 ["eligible_for_acceptance_review"])

    def test_move_disconnect_and_unknown_scope_keep_old_pass_invalid(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "registered-project"
            root.mkdir()
            tracked = root / "tracked.txt"
            tracked.write_text("known bytes", encoding="utf-8")
            (root / "unrelated.txt").write_text("separate bytes", encoding="utf-8")
            (root / "result.txt").write_text("pass", encoding="utf-8")
            data = base / "data"
            with Store(root, data_home=data, create=True) as store:
                store.upsert_node(node_id="target", kind="artifact", title="Target",
                                  freshness="current", application="implemented")
                store.upsert_node(node_id="other", kind="artifact", title="Other",
                                  freshness="current", application="implemented")
                store.anchor("target", "tracked.txt")
                store.anchor("other", "unrelated.txt")
                check_id = record_verification(
                    store, target_id="target", title="Check", method="manual comparison",
                    outcome="pass", evidence_file="result.txt", reason="observed bytes",
                )["id"]
                self.assertTrue(verification_status(store, check_id)
                                ["eligible_for_acceptance_review"])
            (root / "not-registered.txt").write_text("unknown scope", encoding="utf-8")
            moved = root / "moved.txt"
            tracked.rename(moved)
            with Store(root, data_home=data) as store:
                before = coverage_report(store)
                self.assertEqual(before["registered_anchor_denominator"], 3)
                self.assertEqual(before["unavailable"], 1)
                self.assertEqual(before["current_fingerprint"], 2)
                self.assertEqual(before["unregistered_artifact_scope"],
                                 "unknown_not_enumerated")
                self.assertFalse(verification_status(store, check_id)
                                 ["eligible_for_acceptance_review"])
                store.rebind_anchor("target", "tracked.txt", "moved.txt",
                                    reason="same file moved", op_id="known-move")
                after = coverage_report(store)
                self.assertEqual(after["current_fingerprint"], 3)
                self.assertFalse(verification_status(store, check_id)
                                 ["eligible_for_acceptance_review"])
            moved.unlink()
            with Store(root, data_home=data) as store:
                disconnected = coverage_report(store)
                self.assertEqual(disconnected["unavailable"], 1)
                self.assertEqual(disconnected["registered_anchor_denominator"], 3)
                self.assertFalse(verification_status(store, check_id)
                                 ["eligible_for_acceptance_review"])


if __name__ == "__main__":
    unittest.main()
