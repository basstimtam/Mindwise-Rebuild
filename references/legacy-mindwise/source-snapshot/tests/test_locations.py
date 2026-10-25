from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from mindwise.core import BoundaryError, MindwiseError, Store
from mindwise.evidence import explain
from mindwise.locations import record_local


class LocationTests(unittest.TestCase):
    def test_local_recipe_is_scoped_retrievable_and_does_not_hide_drift_on_retry(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            root.mkdir()
            source = root / "input.txt"
            source.write_text("first revision", encoding="utf-8")
            outside = base / "company.txt"
            outside.write_text("out of scope", encoding="utf-8")
            with Store(root, data_home=base / "data", create=True) as store:
                store.upsert_node(node_id="design", kind="specification",
                                  title="Input design")
                location = record_local(
                    store, subject_id="design", title="Original input file",
                    path="input.txt", method="Read the file and compare the input table",
                    conditions="Use the registered project copy", read_range="table A",
                    reason="design source", op_id="location-1")
                card = explain(store, "design")
                self.assertEqual(card["locations"][0]["recipe"]["range"], "table A")
                self.assertEqual(card["locations"][0]["anchors"][0]
                                 ["observed_status"], "current")
                self.assertEqual(store.trace("design")["downstream"][0]
                                 ["node"]["id"], location["id"])
                source.write_text("second revision", encoding="utf-8")
                retried = record_local(
                    store, subject_id="design", title="Original input file",
                    path="input.txt", method="Read the file and compare the input table",
                    conditions="Use the registered project copy", read_range="table A",
                    reason="design source", op_id="location-1")
                self.assertEqual(location["id"], retried["id"])
                self.assertEqual(explain(store, "design")["locations"][0]["anchors"][0]
                                 ["observed_status"], "stale")
                with self.assertRaises(BoundaryError):
                    record_local(store, subject_id="design", title="Outside",
                                 path=str(outside), method="Read", reason="source")
                with self.assertRaises(MindwiseError):
                    record_local(store, subject_id="design", title="Secret",
                                 path="input.txt", method="Bearer fake-token",
                                 reason="source")


if __name__ == "__main__":
    unittest.main()
