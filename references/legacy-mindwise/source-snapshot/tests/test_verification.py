from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from mindwise.core import BoundaryError, Conflict, MindwiseError, Store
from mindwise.verification import record, status


class VerificationTests(unittest.TestCase):
    def test_pass_is_bound_to_live_target_and_result_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            source = root / "chapter.md"
            result = root / "test.txt"
            source.write_text("draft one", encoding="utf-8")
            result.write_text("pass: citation check", encoding="utf-8")
            with Store(root, data_home=Path(directory) / "data", create=True) as store:
                store.upsert_node(node_id="chapter", kind="artifact", title="Chapter",
                                  freshness="current", application="implemented")
                store.anchor("chapter", "chapter.md")
                check = record(store, target_id="chapter", title="Citation check",
                               method="manual source comparison", outcome="pass",
                               evidence_file="test.txt", reason="reviewed citations",
                               op_id="verify-1")
                self.assertTrue(status(store, check["id"])["eligible_for_acceptance_review"])
                with self.assertRaises(MindwiseError):
                    store.update_text(check["id"], title="Changed check", body="pass",
                                      base_version=1, reason="rewrite result")
                self.assertEqual(record(store, target_id="chapter", title="Citation check",
                                        method="manual source comparison", outcome="pass",
                                        evidence_file="test.txt", reason="reviewed citations",
                                        op_id="verify-1")["id"], check["id"])
                with self.assertRaises(Conflict):
                    record(store, target_id="chapter", title="Citation check",
                           method="manual source comparison", outcome="fail",
                           evidence_file="test.txt", reason="reviewed citations",
                           op_id="verify-1")
                source.write_text("draft two", encoding="utf-8")
                self.assertIn("target_file_changed:chapter.md",
                              status(store, check["id"])["problems"])
                self.assertFalse(status(store, check["id"])["eligible_for_acceptance_review"])
                store.reconcile_anchors()
                self.assertEqual(store.node(check["id"])["freshness"], "stale")
                self.assertEqual(store.node(check["id"])["application"], "implemented")

    def test_failure_and_missing_or_changed_evidence_never_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            (root / "chapter.md").write_text("draft", encoding="utf-8")
            result = root / "test.txt"
            result.write_text("failed", encoding="utf-8")
            outside = Path(directory) / "outside.txt"
            outside.write_text("pass", encoding="utf-8")
            with Store(root, data_home=Path(directory) / "data", create=True) as store:
                store.upsert_node(node_id="chapter", kind="artifact", title="Chapter",
                                  freshness="current", application="implemented")
                with self.assertRaises(MindwiseError):
                    record(store, target_id="chapter", title="Check", method="manual",
                           outcome="pass", evidence_file="test.txt", reason="review")
                store.anchor("chapter", "chapter.md")
                with self.assertRaises(BoundaryError):
                    record(store, target_id="chapter", title="Check", method="manual",
                           outcome="pass", evidence_file=str(outside), reason="review")
                failed = record(store, target_id="chapter", title="Check",
                                method="manual", outcome="fail",
                                evidence_file="test.txt", reason="review")
                self.assertEqual(status(store, failed["id"])["status"], "current")
                self.assertFalse(status(store, failed["id"])["eligible_for_acceptance_review"])
                result.unlink()
                self.assertIn("result_file_changed_or_missing",
                              status(store, failed["id"])["problems"])
                result.write_text("later result", encoding="utf-8")
                store.anchor(failed["id"], "test.txt")
                self.assertIn("result_file_changed_or_missing",
                              status(store, failed["id"])["problems"])

    def test_new_target_anchor_invalidates_earlier_pass(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            (root / "chapter.md").write_text("draft", encoding="utf-8")
            (root / "appendix.md").write_text("new scope", encoding="utf-8")
            (root / "unrelated.md").write_text("other", encoding="utf-8")
            (root / "test.txt").write_text("pass", encoding="utf-8")
            with Store(root, data_home=Path(directory) / "data", create=True) as store:
                store.upsert_node(node_id="chapter", kind="artifact", title="Chapter",
                                  freshness="current", application="implemented")
                store.upsert_node(node_id="other", kind="artifact", title="Other",
                                  freshness="current", application="implemented")
                store.anchor("chapter", "chapter.md")
                check = record(store, target_id="chapter", title="Check", method="review",
                               outcome="pass", evidence_file="test.txt", reason="reviewed")
                store.anchor("other", "unrelated.md")
                self.assertTrue(status(store, check["id"])["eligible_for_acceptance_review"])
                store.anchor("chapter", "appendix.md")
                observed = status(store, check["id"])
                self.assertEqual(observed["status"], "stale")
                self.assertIn("target_anchor_added:appendix.md", observed["problems"])
                self.assertFalse(observed["eligible_for_acceptance_review"])


if __name__ == "__main__":
    unittest.main()
