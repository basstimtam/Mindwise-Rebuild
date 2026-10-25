from __future__ import annotations

import tempfile
import unittest
import sqlite3
import hashlib
import json
import zipfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from mindwise.backup import create, restore
from mindwise.core import MindwiseError, Store, project_id


class BackupTests(unittest.TestCase):
    def test_backup_rejects_structurally_valid_dangling_edges_without_repair(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            root.mkdir()
            archive = base / "snapshot.zip"
            with Store(root, data_home=base / "live", create=True) as store:
                store.upsert_node(node_id="n", kind="note", title="Preserved history",
                                  op_id="op-before")
                # Corrupt only this disposable fixture: integrity_check alone
                # accepts dangling references when foreign-key enforcement is off.
                store.db.execute("PRAGMA foreign_keys=OFF")
                with store.db:
                    store.db.execute("INSERT INTO edges VALUES(?,?,?,?,?,?)",
                                     ("n", "missing-node", "depends_on", None, None,
                                      "2026-10-23T00:00:00+00:00"))
                self.assertEqual(store.db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(len(store.db.execute("PRAGMA foreign_key_check").fetchall()), 1)
                before = store.export()
                with self.assertRaisesRegex(MindwiseError, "referential integrity"):
                    create(store, archive)
                self.assertFalse(archive.exists())
                self.assertFalse(archive.with_name(archive.name + ".partial").exists())
                self.assertEqual(store.export(), before)
                self.assertEqual(store.node("n")["title"], "Preserved history")

    def test_restore_rejects_hash_valid_dangling_sources_before_publishing_database(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            root.mkdir()
            healthy = base / "healthy.zip"
            with Store(root, data_home=base / "live", create=True) as store:
                store.upsert_node(node_id="n", kind="note", title="Preserved history",
                                  op_id="op-before")
                original = store.export()
                create(store, healthy)
            with zipfile.ZipFile(healthy) as archive:
                manifest = json.loads(archive.read("manifest.json"))
                altered = base / "altered.sqlite3"
                altered.write_bytes(archive.read("mindwise.sqlite3"))
            with closing(sqlite3.connect(altered)) as connection:
                with connection:
                    connection.execute("PRAGMA foreign_keys=OFF")
                    connection.execute("INSERT INTO event_distillations VALUES(?,?,?)",
                                       ("missing-source", "missing-insight",
                                        "2026-10-23T00:00:00+00:00"))
                self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(len(connection.execute("PRAGMA foreign_key_check").fetchall()), 2)
            payload = altered.read_bytes()
            manifest["sha256"] = hashlib.sha256(payload).hexdigest()
            invalid = base / "invalid.zip"
            with zipfile.ZipFile(invalid, "w") as archive:
                archive.writestr("manifest.json", json.dumps(manifest))
                archive.writestr("mindwise.sqlite3", payload)
            restored = base / "restored"
            target = restored / "projects" / project_id(root) / "mindwise.sqlite3"
            with self.assertRaisesRegex(MindwiseError, "referential integrity"):
                restore(root, invalid, data_home=restored)
            self.assertFalse(target.exists())
            self.assertEqual(list(target.parent.iterdir()), [])
            with Store(root, data_home=base / "live") as store:
                self.assertEqual(store.export(), original)

    def test_restore_preserves_history_and_refuses_overwrite_or_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            root.mkdir()
            original = base / "live"
            archive = base / "snapshot.zip"
            with Store(root, data_home=original, create=True) as store:
                store.upsert_node(node_id="n", kind="decision", title="A", op_id="op-a")
                create(store, archive)
            restored = base / "restored"
            result = restore(root, archive, data_home=restored)
            self.assertEqual(result["recovered_event_sequence"], 1)
            self.assertEqual(result["possible_unrecorded_changes_after"],
                             result["snapshot_at"])
            with Store(root, data_home=restored) as store:
                self.assertEqual(store.node("n")["title"], "A")
                self.assertEqual(len(store.history("n")), 1)
                self.assertEqual(store.export()["events"][0]["op_id"], "op-a")
            with self.assertRaises(MindwiseError):
                restore(root, archive, data_home=restored)
            damaged = base / "damaged.zip"
            damaged.write_bytes(archive.read_bytes()[:-20])
            with self.assertRaises(Exception):
                restore(root, damaged, data_home=base / "damaged-store")

    def test_media_loss_restores_only_snapshot_and_known_retry_replays_once(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            root.mkdir()
            live = base / "live"
            archive = base / "snapshot.zip"
            with Store(root, data_home=live, create=True) as store:
                store.upsert_node(node_id="n", kind="note", title="At snapshot",
                                  op_id="op-before")
                create(store, archive)
                store.upsert_node(node_id="n", kind="note", title="After snapshot",
                                  base_version=1, reason="Known later change",
                                  op_id="op-after")
                lost_db = store.db_path
                self.assertEqual(len(store.history("n")), 2)

            lost_db.unlink()  # Simulate loss only in the temporary test store.
            result = restore(root, archive, data_home=live)
            self.assertEqual(result["recovered_event_sequence"], 1)
            self.assertEqual(result["possible_unrecorded_changes_after"],
                             result["snapshot_at"])
            with Store(root, data_home=live) as recovered:
                self.assertEqual(recovered.node("n")["title"], "At snapshot")
                self.assertEqual([row["op_id"] for row in recovered.history("n")],
                                 ["op-before"])
                recovered.upsert_node(node_id="n", kind="note", title="After snapshot",
                                      base_version=1, reason="Known later change",
                                      op_id="op-after")
                recovered.upsert_node(node_id="n", kind="note", title="After snapshot",
                                      base_version=1, reason="Known later change",
                                      op_id="op-after")
                self.assertEqual(recovered.node("n")["title"], "After snapshot")
                self.assertEqual(len(recovered.history("n")), 2)

    def test_manifest_sequence_is_read_from_snapshot_not_later_live_write(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            root = base / "project"
            root.mkdir()
            archive = base / "snapshot.zip"
            with Store(root, data_home=base / "live", create=True) as store:
                store.upsert_node(node_id="n", kind="note", title="Before",
                                  op_id="op-before")
                connection = store.db
                clock_calls_at_backup: list[int] = []

                class ConcurrentWrite:
                    def backup(self, destination: sqlite3.Connection) -> None:
                        clock_calls_at_backup.append(clock.call_count)
                        connection.backup(destination)
                        with closing(sqlite3.connect(store.db_path)) as writer:
                            with writer:
                                writer.execute(
                                    "INSERT INTO events(op_id,node_id,actor,kind,occurred_at) "
                                    "VALUES(?,?,?,?,?)",
                                    ("op-after", "n", "agent", "observation",
                                     "2026-09-26T00:00:01+00:00"),
                                )

                store.db = ConcurrentWrite()
                try:
                    with patch("mindwise.backup.utc_now",
                               return_value="2026-09-26T00:00:00+00:00") as clock:
                        create(store, archive)
                finally:
                    store.db = connection
                self.assertEqual(clock_calls_at_backup, [1])
                self.assertEqual(store.db.execute(
                    "SELECT max(sequence) FROM events").fetchone()[0], 2)

            restored_home = base / "restored"
            result = restore(root, archive, data_home=restored_home)
            self.assertEqual(result["snapshot_at"], "2026-09-26T00:00:00+00:00")
            self.assertEqual(result["recovered_event_sequence"], 1)
            with Store(root, data_home=restored_home) as recovered:
                self.assertEqual([row["op_id"] for row in recovered.history("n")],
                                 ["op-before"])
