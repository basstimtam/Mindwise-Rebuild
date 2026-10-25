from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from mindwise.core import Conflict, MindwiseError, Store
from mindwise.tasks import record, update


class TaskTests(unittest.TestCase):
    def test_plan_progress_does_not_claim_acceptance(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            with Store(root, data_home=Path(directory) / "data", create=True) as store:
                task = record(store, title="Review chapter", status="done",
                              start="2026-09-25", due="2026-09-28", progress=100,
                              reason="chapter quality check")
                self.assertEqual(json.loads(task["body"])["progress_kind"], "plan")
                self.assertNotEqual(task["application"], "verified")
                with self.assertRaises(MindwiseError):
                    record(store, title="Invalid", start="2026-10-01",
                           due="2026-09-28", reason="bad range")
                preview = update(store, task["id"], title="Review chapter",
                                 status="doing", start="2026-09-25", due="2026-09-28",
                                 progress=60, base_version=1, preview=True)
                self.assertTrue(preview["map_only"])
                changed = update(store, task["id"], title="Review chapter",
                                 status="doing", start="2026-09-25", due="2026-09-28",
                                 progress=60, base_version=1,
                                 reason="review reopened", op_id="task-edit")
                self.assertEqual(json.loads(changed["body"])["progress"], 60)
                self.assertNotEqual(changed["application"], "verified")
                with self.assertRaises(Conflict):
                    update(store, task["id"], title="Review chapter", status="done",
                           start="2026-09-25", due="2026-09-28", progress=100,
                           base_version=1, reason="review reopened", op_id="task-edit")
