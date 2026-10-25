from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from mindwise.core import Store
from mindwise.coverage import report


class CoverageTests(unittest.TestCase):
    def test_denominator_is_registered_anchors_and_unknown_scope_stays_unknown(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            tracked = root / "tracked.txt"
            tracked.write_text("first", encoding="utf-8")
            (root / "not_registered.txt").write_text("unseen", encoding="utf-8")
            with Store(root, data_home=Path(directory) / "data", create=True) as store:
                store.upsert_node(node_id="tracked", kind="artifact", title="Tracked")
                store.upsert_node(node_id="unanchored", kind="artifact", title="Unanchored")
                store.anchor("tracked", "tracked.txt")
                first = report(store)
                self.assertEqual(first["registered_anchor_denominator"], 1)
                self.assertEqual(first["current_fingerprint"], 1)
                self.assertEqual(first["unanchored_artifact_nodes"]["count"], 1)
                self.assertEqual(first["unregistered_artifact_scope"],
                                 "unknown_not_enumerated")
                self.assertEqual(first["project_completion"], "not_inferred")
                tracked.write_text("second", encoding="utf-8")
                changed = report(store)
                self.assertEqual(changed["changed_fingerprint"], 1)
                self.assertEqual(changed["stored_state_disagreements"], 1)
                tracked.unlink()
                missing = report(store)
                self.assertEqual(missing["unavailable"], 1)
                self.assertEqual(missing["registered_anchor_denominator"], 1)


if __name__ == "__main__":
    unittest.main()
