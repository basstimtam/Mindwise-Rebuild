"""Typed, reproducible values in the same semantic map as design decisions."""

from __future__ import annotations

import ast
import json
import uuid
from decimal import Decimal, DecimalException, InvalidOperation
from typing import Any

from .core import MindwiseError, Store


def _payload(store: Store, *, unit: str, value: str | None,
             formula: str | None, inputs: dict[str, str]) -> str:
    if not unit.strip() or (value is None) == (formula is None):
        raise MindwiseError("A metric needs a unit and exactly one value or formula")
    if value is not None and inputs:
        raise MindwiseError("A direct metric value cannot have formula inputs")
    if len(set(inputs.values())) != len(inputs):
        raise MindwiseError("Each formula input must use a different dependency node")
    for name, node_id in inputs.items():
        if not name.isidentifier():
            raise MindwiseError("Formula input names must be identifiers")
        store.node(node_id)
    if value is not None:
        try:
            if not Decimal(value).is_finite():
                raise MindwiseError("Metric value must be finite")
        except InvalidOperation as exc:
            raise MindwiseError("Metric value is not a decimal") from exc
    if formula is not None and len(formula) > 500:
        raise MindwiseError("Formula exceeds the length limit")
    return json.dumps({"value": value, "formula": formula, "unit": unit,
                       "inputs": inputs}, ensure_ascii=False, sort_keys=True)


def record(store: Store, *, title: str, unit: str, value: str | None = None,
           formula: str | None = None, inputs: dict[str, str] | None = None,
           evidence: str | None = None, reason: str,
           op_id: str | None = None) -> dict[str, Any]:
    dependencies = inputs or {}
    payload = _payload(store, unit=unit, value=value, formula=formula,
                       inputs=dependencies)
    op_id = op_id or str(uuid.uuid4())
    metric = store.upsert_node(
        kind="metric", title=title, body=payload,
        knowledge="observation" if value is not None and evidence else "hypothesis",
        freshness="current" if evidence else "unverified", application="adopted",
        reason=reason, evidence=evidence, op_id=op_id,
        formula_inputs=dependencies)
    return metric


def update(store: Store, node_id: str, *, title: str, unit: str,
           value: str | None, formula: str | None, base_version: int,
           reason: str | None = None, evidence: str | None = None,
           op_id: str | None = None, preview: bool = False,
           actor: str = "agent", inputs: dict[str, str] | None = None) -> dict[str, Any]:
    node = store.node(node_id)
    if node["kind"] != "metric":
        raise MindwiseError("Selected node is not a metric")
    details = json.loads(node["body"])
    if (value is None) != (details.get("value") is None):
        raise MindwiseError("Changing a metric between input and formula needs a new node")
    old_inputs = details.get("inputs", {})
    dependencies = old_inputs if inputs is None else inputs
    body = _payload(store, unit=unit, value=value, formula=formula,
                    inputs=dependencies)
    if op_id and not preview:
        repeated = store.repeated_upsert(
            op_id, node_id, title=title, body=body,
            base_version=base_version, reason=reason, evidence=evidence)
        if repeated is not None:
            return repeated
    proposed = store.preview_text_update(node_id, title=title, body=body,
                                         base_version=base_version,
                                         allow_structured=True)
    proposed["input_changes"] = {
        "before": old_inputs, "after": dependencies
    } if old_inputs != dependencies else None
    if preview or not proposed["changes"]:
        return proposed if preview else node
    if not (reason or "").strip():
        raise MindwiseError("A metric update needs a reason")
    return store.upsert_node(
        node_id=node_id, kind="metric", title=title, body=body,
        authority=node["authority"],
        knowledge="observation" if value is not None and evidence else "hypothesis",
        freshness="current" if evidence else "unverified", application="adopted",
        scope=node["scope"], strategy_ref=node["strategy_ref"],
        actor=actor, reason=reason, evidence=evidence,
        base_version=base_version, op_id=op_id,
        formula_inputs=dependencies)


def calculate(store: Store, node_id: str) -> dict[str, Any]:
    """Evaluate a limited arithmetic AST; never run arbitrary Python code."""
    def evaluate(current_id: str, visiting: set[str]) -> tuple[Decimal, str]:
        if current_id in visiting:
            raise MindwiseError("Formula dependency cycle")
        node = store.node(current_id)
        if node["kind"] != "metric":
            raise MindwiseError("Formula input is not a metric")
        if node["freshness"] != "current":
            raise MindwiseError(f"Metric {current_id} is {node['freshness']}")
        details = json.loads(node["body"])
        if not isinstance(details, dict):
            raise MindwiseError("Metric body must be an object")
        inputs = details.get("inputs")
        value = details.get("value")
        formula = details.get("formula")
        if (not isinstance(details.get("unit"), str) or not details["unit"].strip()
                or not isinstance(inputs, dict)
                or any(not isinstance(name, str) or not name.isidentifier()
                       or not isinstance(dependency, str) or not dependency
                       for name, dependency in inputs.items())
                or len(set(inputs.values())) != len(inputs)
                or (value is None) == (formula is None)
                or (value is not None and (not isinstance(value, str) or inputs))
                or (formula is not None and (not isinstance(formula, str)
                                            or not formula.strip() or len(formula) > 500))):
            raise MindwiseError("Invalid metric fields")
        unit = details["unit"]
        if value is not None:
            numeric = Decimal(value)
            if not numeric.is_finite():
                raise MindwiseError("Metric value must be finite")
            return numeric, unit
        visiting.add(current_id)
        try:
            environment = {name: evaluate(dependency, visiting)
                           for name, dependency in inputs.items()}

            def expression(item: ast.AST) -> tuple[Decimal, str]:
                if isinstance(item, ast.Expression):
                    return expression(item.body)
                if isinstance(item, ast.Name):
                    if item.id not in environment:
                        raise MindwiseError(f"Unknown formula input: {item.id}")
                    return environment[item.id]
                if isinstance(item, ast.Constant) and type(item.value) in {int, float}:
                    return Decimal(str(item.value)), "1"
                if isinstance(item, ast.UnaryOp) and isinstance(item.op, ast.USub):
                    value, value_unit = expression(item.operand)
                    return -value, value_unit
                if isinstance(item, ast.BinOp):
                    left, left_unit = expression(item.left)
                    right, right_unit = expression(item.right)
                    if isinstance(item.op, (ast.Add, ast.Sub)):
                        if left_unit != right_unit:
                            raise MindwiseError("Formula units do not match")
                        return ((left + right) if isinstance(item.op, ast.Add)
                                else (left - right)), left_unit
                    if isinstance(item.op, ast.Mult):
                        return left * right, (right_unit if left_unit == "1" else
                                              left_unit if right_unit == "1" else
                                              f"{left_unit}*{right_unit}")
                    if isinstance(item.op, ast.Div):
                        if right == 0:
                            raise MindwiseError("Division by zero")
                        return left / right, ("1" if left_unit == right_unit else
                                              left_unit if right_unit == "1" else
                                              f"{left_unit}/{right_unit}")
                raise MindwiseError("Unsupported formula syntax")

            parsed = ast.parse(formula, mode="eval")
            if sum(1 for _ in ast.walk(parsed)) > 100:
                raise MindwiseError("Formula exceeds the complexity limit")
            value, result_unit = expression(parsed)
            if result_unit != unit:
                raise MindwiseError("Formula result unit does not match the declared unit")
            return value, unit
        finally:
            visiting.remove(current_id)

    try:
        value, unit = evaluate(node_id, set())
        if not value.is_finite():
            raise MindwiseError("Formula result must be finite")
        return {"node_id": node_id, "status": "current", "value": str(value),
                "unit": unit}
    except (MindwiseError, DecimalException, json.JSONDecodeError, SyntaxError,
            KeyError, TypeError) as exc:
        return {"node_id": node_id, "status": "invalid_or_unverified",
                "value": None, "reason": str(exc)}
