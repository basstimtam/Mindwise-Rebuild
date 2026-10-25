"""Read Goal Forge documents without promoting a projection into authority."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from .core import Store, checked_path

FILES = ("GOAL.md", "DESIGN_STANDARD.md", "DISCOVERY_LOG.md")
REVISION = re.compile(r"^\s*-\s*\*\*共通契約リビジョン\*\*:\s*(.+)$", re.MULTILINE)
STATE = re.compile(r"^\s*-\s*\*\*状態\*\*:\s*(.+)$", re.MULTILINE)
HEADING = re.compile(r"^(#{2,4})\s+(.+?)\s*$", re.MULTILINE)
CONTRACT_ROW = re.compile(r"^\|\s*([DAT]\d+)\s*\|\s*(.+?)\s*\|\s*$", re.MULTILINE)
LOG_SECTION = re.compile(r"^##\s+(.+?)\s*$", re.MULTILINE)
APPROVAL_BASIS = re.compile(r"^\s*-\s*\*\*承認根拠\*\*:\s*(.+)$", re.MULTILINE)
APPROVAL_DECISION = re.compile(r"^\s*-\s*\*\*承認判断\*\*:\s*(.+)$", re.MULTILINE)
OWNER_RECORD = re.compile(r"^\s*-\s*\*\*承認者(?:と根拠)?\*\*:\s*(.+)$", re.MULTILINE)
APPROVAL_TARGET = re.compile(r"^\s*-\s*\*\*承認対象\*\*:\s*(.+)$", re.MULTILINE)


def _match(pattern: re.Pattern[str], value: str) -> str | None:
    found = pattern.search(value)
    return found.group(1).strip() if found else None


def _state_key(value: str | None) -> str | None:
    if not value:
        return None
    label = value.split("（", 1)[0].split("(", 1)[0].strip().upper()
    return label if label in {"DRAFT", "APPROVED", "ACTIVE", "COMPLETE"} else None


def _approval_history(text: str, revision: str | None) -> dict[str, Any]:
    """Read explicit owner decisions for the current revision in append order.

    The log is prose rather than a command stream. An uncertain decision must
    remain visible, never promote a proposed contract. Later approval can
    supersede an earlier rejection of the same revision.
    """
    if not revision:
        return {"status": "missing", "source": None,
                "reason": "A single current contract revision is unavailable"}

    def negative_status(value: str) -> str | None:
        if any(term in value for term in ("却下", "不採用")):
            return "rejected"
        if any(term in value for term in ("未承認", "承認待ち", "保留", "未確認", "確認中", "審議中")):
            return "pending"
        return None

    sections = list(LOG_SECTION.finditer(text))
    front = text[:sections[0].start()] if sections else text
    decisions: list[dict[str, Any]] = []
    revision_number = re.search(r"\bRev\s*\d+\b", revision, re.IGNORECASE)
    comparable_revision = revision_number.group(0) if revision_number else revision
    normalized_revision = re.sub(r"\s+", "", comparable_revision).casefold()
    basis_match = APPROVAL_BASIS.search(front)
    basis = basis_match.group(1).strip() if basis_match else None
    normalized_basis = re.sub(r"\s+", "", basis).casefold() if basis else ""
    basis_status = negative_status(basis) if basis else None
    basis_has_revision = bool(re.search(r"\bRev\s*\d+\b", basis, re.IGNORECASE)) if basis else False
    if (basis and ("オーナー" in basis or "owner" in basis.casefold())
            and (re.search(re.escape(normalized_revision) + r"(?!\d)", normalized_basis)
                 or (basis_status and not basis_has_revision))):
        status = basis_status or "confirmed"
        decisions.append({"status": status,
                          "source": f"DISCOVERY_LOG.md:{text.count(chr(10), 0, basis_match.start()) + 1}",
                          "reason": basis})
    for index, section in enumerate(sections):
        title = section.group(1)
        normalized_title = re.sub(r"\s+", "", title).casefold()
        if not re.search(re.escape(normalized_revision) + r"(?!\d)", normalized_title):
            continue
        end = sections[index + 1].start() if index + 1 < len(sections) else len(text)
        body = text[section.end():end]
        explicit = _match(APPROVAL_DECISION, body)
        negative = negative_status(title)
        if explicit:
            negative = negative or negative_status(explicit)
            positive = (explicit.strip().upper() in {"APPROVED", "ACTIVE", "COMPLETE", "承認"}
                        and bool(_match(OWNER_RECORD, body)))
        else:
            positive = bool(_match(OWNER_RECORD, body)) and (
                bool(_match(APPROVAL_TARGET, body)) or "承認" in title or "契約改訂" in title
            )
        if explicit is None and not negative and not positive:
            continue
        status = negative or ("confirmed" if positive else "ambiguous")
        decisions.append({"status": status,
                          "source": f"DISCOVERY_LOG.md:{text.count(chr(10), 0, section.start()) + 1}",
                          "reason": explicit or title})
    return decisions[-1] if decisions else {
        "status": "missing", "source": None,
        "reason": "No owner approval record for this revision in DISCOVERY_LOG.md"}


def inspect(root: Path) -> dict[str, Any]:
    """Report missing and incompatible files; never silently drop a section."""
    documents: dict[str, Any] = {}
    revisions: set[str] = set()
    states: set[str] = set()
    log_text: str | None = None
    for name in FILES:
        try:
            path = checked_path(root, name)
            raw = path.read_bytes()
        except FileNotFoundError:
            documents[name] = {"status": "missing"}
            continue
        except OSError as exc:
            documents[name] = {"status": "unreadable",
                               "reason": f"{type(exc).__name__}: {exc.strerror or 'file access failed'}"}
            continue
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            documents[name] = {"status": "unreadable", "reason": "not UTF-8"}
            continue
        if name == "DISCOVERY_LOG.md":
            log_text = text
        revision = _match(REVISION, text)
        state = _match(STATE, text)
        headings = [{"level": len(match.group(1)), "title": match.group(2),
                     "line": text.count("\n", 0, match.start()) + 1}
                    for match in HEADING.finditer(text)]
        issues = []
        if not revision:
            issues.append("revision missing")
        else:
            revisions.add(revision)
        if not state:
            issues.append("state missing")
        elif _state_key(state) is None:
            issues.append("state unknown")
        else:
            states.add(_state_key(state))
        if name != "DISCOVERY_LOG.md" and not headings:
            issues.append("no sections")
        documents[name] = {"status": "partial" if issues else "readable",
                           "revision": revision, "state": state, "sha256": hashlib.sha256(raw).hexdigest(),
                           "headings": headings, "issues": issues}
    if len(revisions) > 1:
        for entry in documents.values():
            if entry["status"] not in {"missing", "unreadable"}:
                entry["issues"].append("revision mismatch")
                entry["status"] = "partial"
    if len(states) > 1:
        for entry in documents.values():
            if entry["status"] not in {"missing", "unreadable"}:
                entry["issues"].append("state mismatch")
                entry["status"] = "partial"
    revision = next(iter(revisions)) if len(revisions) == 1 else None
    approval = _approval_history(log_text or "", revision)
    return {"root": str(root), "documents": documents,
            "revision": revision,
            "state": next(iter(states)) if len(states) == 1 else None,
            "approval": approval,
            "compatible": all(entry["status"] == "readable" for entry in documents.values())}


def project_sections(store: Store) -> dict[str, Any]:
    """Project contract sections with exact source text and stable source IDs."""
    report = inspect(store.root)
    approved = report["compatible"] and report["approval"]["status"] == "confirmed" and report["state"] in {
        "APPROVED", "ACTIVE", "COMPLETE"}
    count = 0
    projected: set[str] = set()
    for name in FILES[:2]:
        info = report["documents"][name]
        if info["status"] in {"missing", "unreadable"}:
            continue
        path = checked_path(store.root, name)
        text = path.read_text(encoding="utf-8-sig")
        matches = list(HEADING.finditer(text))
        heading_stack: list[tuple[int, str]] = []
        seen_source_keys: dict[str, int] = {}
        for index, match in enumerate(matches):
            start = match.end()
            end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
            content = text[start:end].strip()
            title = match.group(2).strip()
            parent_id = None
            level = len(match.group(1))
            while heading_stack and heading_stack[-1][0] >= level:
                heading_stack.pop()
            if heading_stack:
                parent_id = heading_stack[-1][1]
            # Repeated headings in separate sections must not collide. The
            # occurrence ordinal changes only when an identical heading is added.
            key_base = f"{name}::{title}"
            ordinal = seen_source_keys.get(key_base, 0) + 1
            seen_source_keys[key_base] = ordinal
            source_key = f"{key_base}::{ordinal}"
            # An incomplete or unapproved revision is visible as a proposal,
            # but must not demote the last adopted strategy with the same
            # heading. Promotion is a separate projection after approval.
            namespace = "strategy:" if approved else "strategy:proposal:"
            node_id = namespace + hashlib.sha256(source_key.encode("utf-8")).hexdigest()[:24]
            projected.add(node_id)
            line = text.count("\n", 0, match.start()) + 1
            op_id = "contract:" + hashlib.sha256(
                (namespace + source_key + "\n" + str(line) + "\n"
                 + (info["revision"] or "") + "\n"
                 + str(report["state"]) + "\n" + str(report["compatible"])
                 + "\n" + content).encode("utf-8")
            ).hexdigest()
            old = store.db.execute("SELECT version FROM nodes WHERE id=?", (node_id,)).fetchone()
            store.upsert_node(
                node_id=node_id, kind="strategy", title=title, body=content,
                authority="contract", knowledge="decision" if approved else "hypothesis",
                freshness="current" if report["compatible"] else "unverified",
                application="adopted" if approved else "proposed",
                strategy_ref=f"{name}:{line}@{info['revision'] or '?'}",
                actor="contract_import", evidence=f"{name}#{line}",
                base_version=old["version"] if old else None, op_id=op_id,
                reason="Contract projection; source document remains authoritative",
            )
            if parent_id:
                # A hierarchy is an explicit view relation, not a dependency.
                old_edge = store.db.execute(
                    "SELECT 1 FROM edges WHERE source_id=? AND target_id=? AND kind='parent_of'",
                    (parent_id, node_id),
                ).fetchone()
                if not old_edge:
                    store.link(parent_id, node_id, "parent_of", actor="contract_import",
                               evidence=f"{name}#{line}")
            heading_stack.append((level, node_id))
            count += 1
            # Deliverables, acceptance checks, and verification cases are
            # first-class strategy references, not opaque text inside a large
            # heading. Their explicit IDs survive wording changes.
            for row_match in CONTRACT_ROW.finditer(text, start, end):
                code = row_match.group(1)
                if not ((name == "GOAL.md" and code[0] in "DA") or
                        (name == "DESIGN_STANDARD.md" and code.startswith("T"))):
                    continue
                row_body = row_match.group(2).strip()
                row_title = f"{code} {row_body[:48]}"
                row_key = f"{name}::row::{code}"
                row_id = namespace + hashlib.sha256(row_key.encode("utf-8")).hexdigest()[:24]
                projected.add(row_id)
                row_line = text.count("\n", 0, row_match.start()) + 1
                row_op = "contract:" + hashlib.sha256(
                    (namespace + row_key + "\n" + str(row_line) + "\n" + (info["revision"] or "")
                     + "\n" + str(report["state"]) + "\n" + str(report["compatible"])
                     + "\n" + row_body).encode("utf-8")
                ).hexdigest()
                previous = store.db.execute(
                    "SELECT version FROM nodes WHERE id=?", (row_id,)
                ).fetchone()
                store.upsert_node(
                    node_id=row_id,
                    kind="deliverable" if code.startswith("D") else "acceptance",
                    title=row_title, body=row_body, authority="contract",
                    knowledge="decision" if approved else "hypothesis",
                    freshness="current" if report["compatible"] else "unverified",
                    application="adopted" if approved else "proposed",
                    strategy_ref=f"{name}:{row_line}@{info['revision'] or '?'}",
                    actor="contract_import", evidence=f"{name}#{row_line}",
                    base_version=previous["version"] if previous else None,
                    op_id=row_op,
                    reason="Contract row projection; source document remains authoritative",
                )
                if not store.db.execute(
                    "SELECT 1 FROM edges WHERE source_id=? AND target_id=? AND kind='parent_of'",
                    (node_id, row_id),
                ).fetchone():
                    store.link(node_id, row_id, "parent_of", actor="contract_import",
                               evidence=f"{name}#{row_line}")
                count += 1
    # Only a complete, internally compatible contract may retire projections.
    # A missing file or broken revision must not erase the last known strategy.
    retired_sections = []
    affected_connections = []
    if approved:
        # The approved projection supersedes draft copies. Keep their events
        # and source refs for provenance, but omit them from the live map.
        for row in store.db.execute(
            "SELECT * FROM nodes WHERE id LIKE 'strategy:proposal:%' "
            "AND authority='contract' AND application != 'retired'"
        ).fetchall():
            store.upsert_node(
                node_id=row["id"], kind=row["kind"], title=row["title"],
                body=row["body"], authority="contract", knowledge=row["knowledge"],
                freshness="stale", application="retired", scope=row["scope"],
                strategy_ref=row["strategy_ref"], actor="contract_import",
                reason="Approved contract supersedes draft projection",
                base_version=row["version"],
            )
    if report["compatible"] and approved:
        for row in store.db.execute(
            "SELECT id,version,kind,title,body,scope,strategy_ref FROM nodes "
            "WHERE authority='contract' AND application != 'retired'"
        ).fetchall():
            if row["id"] not in projected:
                retired_sections.append(row["id"])
                affected_connections.extend(
                    {"strategy_id": row["id"], "other_id": (
                        edge["target_id"] if edge["source_id"] == row["id"]
                        else edge["source_id"]), "kind": edge["kind"]}
                    for edge in store.neighbors(row["id"])
                    if edge["kind"] != "parent_of"
                )
                store.upsert_node(
                    node_id=row["id"], kind=row["kind"], title=row["title"],
                    body=row["body"], authority="contract", knowledge="decision",
                    freshness="stale", application="retired", scope=row["scope"],
                    strategy_ref=row["strategy_ref"], actor="contract_import",
                    reason="Source section no longer appears in compatible contract",
                    base_version=row["version"],
                )
    report["projected_sections"] = count
    report["retired_sections"] = retired_sections
    report["affected_connections"] = affected_connections
    return report
