"""Consistent, portable snapshots of a single explicitly registered project."""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import tempfile
import zipfile
from contextlib import closing
from pathlib import Path
from typing import Any

from .core import MindwiseError, Store, canonical_root, local_data_home, project_id, utc_now

MAX_BACKUP_BYTES = 512 * 1024 * 1024


def create(store: Store, destination: str | Path) -> dict[str, str]:
    """Create a verified SQLite snapshot without relying on a live WAL copy."""
    target = Path(destination).expanduser().resolve()
    if target.exists():
        raise MindwiseError("Backup destination already exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as temporary:
        db_file = Path(temporary) / "mindwise.sqlite3"
        snapshot_started_at = utc_now()  # Conservative loss boundary if writes race the backup.
        with closing(sqlite3.connect(db_file)) as snapshot:
            with snapshot:
                store.db.backup(snapshot)
            if snapshot.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise MindwiseError("Snapshot integrity check failed")
            if snapshot.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise MindwiseError("Snapshot referential integrity check failed")
            last_event_sequence = snapshot.execute(
                "SELECT coalesce(max(sequence),0) FROM events").fetchone()[0]
        payload = db_file.read_bytes()
        manifest = {"format": 2, "project_id": store.id, "root": str(store.root),
                    "created_at": snapshot_started_at,
                    "sha256": hashlib.sha256(payload).hexdigest(),
                    "last_event_sequence": last_event_sequence}
        partial = target.with_name(target.name + ".partial")
        try:
            with zipfile.ZipFile(partial, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
                archive.writestr("mindwise.sqlite3", payload)
            os.replace(partial, target)
        finally:
            partial.unlink(missing_ok=True)
    return {"path": str(target), "sha256": manifest["sha256"],
            "created_at": manifest["created_at"]}


def restore(root: str | Path, archive_path: str | Path, *,
            data_home: str | Path | None = None) -> dict[str, Any]:
    """Restore to an empty store only; never overwrite live project data."""
    selected_root = canonical_root(root)
    home = Path(data_home).expanduser().resolve() if data_home else local_data_home()
    target = home / "projects" / project_id(selected_root) / "mindwise.sqlite3"
    if target.exists():
        raise MindwiseError("Project data already exists; restore requires an empty destination")
    with zipfile.ZipFile(Path(archive_path).expanduser().resolve()) as archive:
        if set(archive.namelist()) != {"manifest.json", "mindwise.sqlite3"}:
            raise MindwiseError("Unexpected backup contents")
        if archive.getinfo("mindwise.sqlite3").file_size > MAX_BACKUP_BYTES:
            raise MindwiseError("Backup exceeds the size limit")
        manifest = json.loads(archive.read("manifest.json"))
        payload = archive.read("mindwise.sqlite3")
    if (manifest.get("format") not in {1, 2}
            or manifest.get("project_id") != project_id(selected_root)
            or manifest.get("root") != str(selected_root)
            or hashlib.sha256(payload).hexdigest() != manifest.get("sha256")):
        raise MindwiseError("Backup does not match this project or failed its checksum")
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as temporary:
        partial = Path(temporary.name)
        temporary.write(payload)
    try:
        with closing(sqlite3.connect(f"file:{partial}?mode=ro", uri=True)) as check:
            if check.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise MindwiseError("Backup database is corrupt")
            if check.execute("PRAGMA foreign_key_check").fetchone() is not None:
                raise MindwiseError("Backup database referential integrity check failed")
            row = check.execute("SELECT value FROM metadata WHERE key='root'").fetchone()
            if not row or row[0] != str(selected_root):
                raise MindwiseError("Backup database belongs to a different root")
        try:
            os.link(partial, target)  # Atomic create; refuses a concurrent restore.
        except FileExistsError as exc:
            raise MindwiseError("Project data appeared during restore") from exc
    finally:
        partial.unlink(missing_ok=True)
    return {"path": str(target), "snapshot_at": manifest["created_at"],
            "restored_at": utc_now(),
            "possible_unrecorded_changes_after": manifest["created_at"],
            "recovered_event_sequence": manifest.get("last_event_sequence")}
