from __future__ import annotations

import tempfile
import json
import unittest
from pathlib import Path

from mindwise.core import Conflict, Store
from mindwise.metrics import calculate, record, update


class MetricTests(unittest.TestCase):
    def test_corrupt_metric_shapes_and_values_are_unverified_without_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            with Store(root, data_home=Path(directory) / "data", create=True) as store:
                valid = {"value": None, "formula": "1", "unit": "1", "inputs": {}}
                bodies = [None, [], {}, dict(valid, inputs=[]), dict(valid, inputs=None),
                          dict(valid, inputs={"a": []}), dict(valid, unit=[]),
                          dict(valid, value=True, formula=None),
                          dict(valid, value="NaN", formula=None),
                          dict(valid, value="Infinity", formula=None)]
                for index, body in enumerate(bodies):
                    node = store.upsert_node(kind="metric", title=str(index),
                                             body=json.dumps(body), freshness="current")
                    before = store.export()
                    with self.subTest(body=body):
                        result = calculate(store, node["id"])
                        self.assertEqual(result["status"], "invalid_or_unverified")
                        self.assertIsNone(result["value"])
                        self.assertEqual(store.export(), before)
                huge = record(store, title="Finite extreme", unit="1", value="1e999999",
                              reason="overflow probe", evidence="synthetic fixture")
                overflow = record(store, title="Overflow formula", unit="1", formula="x*10",
                                  inputs={"x": huge["id"]}, reason="overflow probe",
                                  evidence="synthetic fixture")
                before = store.export()
                self.assertEqual(calculate(store, overflow["id"])["status"], "invalid_or_unverified")
                self.assertEqual(store.export(), before)

    def test_rebind_conflict_rolls_back_body_and_edges_together(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            with Store(root, data_home=Path(directory) / "data", create=True) as store:
                left = record(store, title="Left", unit="JPY", value="1",
                              reason="source", evidence="source")
                right = record(store, title="Right", unit="JPY", value="2",
                               reason="source", evidence="source")
                formula = record(store, title="Total", unit="JPY", formula="x+1",
                                 inputs={"x": left["id"]}, reason="method",
                                 evidence="review")
                store.link(formula["id"], right["id"], "depends_on",
                           evidence="manual prerequisite")
                before = store.node(formula["id"])
                edges = store.neighbors(formula["id"])
                with self.assertRaises(Conflict):
                    update(store, formula["id"], title="Total", unit="JPY",
                           value=None, formula="x+1", inputs={"x": right["id"]},
                           base_version=1, reason="switch", evidence="review-v2")
                self.assertEqual(store.node(formula["id"]), before)
                self.assertEqual(store.neighbors(formula["id"]), edges)

    def test_formula_input_rebind_changes_only_the_intended_dependency(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            with Store(root, data_home=Path(directory) / "data", create=True) as store:
                old = record(store, title="Old price", unit="JPY", value="100",
                             reason="quote", evidence="old quote")
                new = record(store, title="New price", unit="JPY", value="140",
                             reason="quote", evidence="new quote")
                total = record(store, title="Double", unit="JPY", formula="price*2",
                               inputs={"price": old["id"]}, reason="method",
                               evidence="formula review")
                preview = update(store, total["id"], title="Double", unit="JPY",
                                 value=None, formula="price*2", base_version=1,
                                 inputs={"price": new["id"]}, preview=True)
                self.assertEqual(preview["input_changes"]["before"],
                                 {"price": old["id"]})
                changed = update(store, total["id"], title="Double", unit="JPY",
                                 value=None, formula="price*2", base_version=1,
                                 inputs={"price": new["id"]}, reason="switch source",
                                 evidence="new review", op_id="rebind")
                self.assertEqual(calculate(store, total["id"])["value"], "280")
                self.assertEqual(update(store, total["id"], title="Double", unit="JPY",
                                        value=None, formula="price*2", base_version=1,
                                        inputs={"price": new["id"]}, reason="switch source",
                                        evidence="new review", op_id="rebind")["version"],
                                 changed["version"])
                self.assertEqual({edge["target_id"] for edge in store.neighbors(total["id"])
                                  if edge["source_id"] == total["id"] and
                                  edge["kind"] == "depends_on"}, {new["id"]})
                update(store, old["id"], title="Old price", unit="JPY", value="110",
                       formula=None, base_version=1, reason="new old quote",
                       evidence="old quote v2")
                self.assertEqual(store.node(total["id"])["freshness"], "current")
                update(store, new["id"], title="New price", unit="JPY", value="150",
                       formula=None, base_version=1, reason="new quote",
                       evidence="new quote v2")
                self.assertEqual(store.node(total["id"])["freshness"], "stale")

    def test_formula_units_and_stale_inputs(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            with Store(root, data_home=Path(directory) / "data", create=True) as store:
                income = record(store, title="Income", unit="JPY", value="1200",
                                reason="ledger figure", evidence="ledger@v1")
                cost = record(store, title="Cost", unit="JPY", value="200",
                              reason="ledger figure", evidence="ledger@v1")
                profit = record(store, title="Profit", unit="JPY",
                                formula="income-cost",
                                inputs={"income": income["id"], "cost": cost["id"]},
                                reason="net amount", evidence="formula review")
                self.assertEqual(calculate(store, profit["id"])["value"], "1000")
                wrong = record(store, title="Wrong", unit="hours", formula="income+cost",
                               inputs={"income": income["id"], "cost": cost["id"]},
                               reason="test", evidence="formula review")
                self.assertEqual(calculate(store, wrong["id"])["status"],
                                 "invalid_or_unverified")
                update(store, cost["id"], title="Cost", unit="JPY", value="250",
                       formula=None, base_version=1, reason="new ledger")
                self.assertEqual(calculate(store, profit["id"])["status"],
                                 "invalid_or_unverified")

    def test_typed_update_rechecks_dependent_formula(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "project"
            root.mkdir()
            with Store(root, data_home=Path(directory) / "data", create=True) as store:
                price = record(store, title="Price", unit="JPY", value="100",
                               reason="source", evidence="quote-v1")
                doubled = record(store, title="Double", unit="JPY", formula="price*2",
                                 inputs={"price": price["id"]},
                                 reason="calculation", evidence="review-v1")
                self.assertEqual(calculate(store, doubled["id"])["value"], "200")
                preview = update(store, price["id"], title="Price", unit="JPY",
                                 value="150", formula=None, base_version=1, preview=True)
                self.assertEqual(preview["affected"][0]["node"]["id"], doubled["id"])
                changed = update(store, price["id"], title="Price", unit="JPY",
                                 value="150", formula=None, base_version=1,
                                 reason="new quote", evidence="quote-v2", op_id="price-edit")
                self.assertEqual(changed["freshness"], "current")
                self.assertEqual(store.node(doubled["id"])["freshness"], "stale")
                self.assertEqual(calculate(store, doubled["id"])["status"],
                                 "invalid_or_unverified")
                self.assertEqual(update(store, price["id"], title="Price", unit="JPY",
                                        value="150", formula=None, base_version=1,
                                        reason="new quote", evidence="quote-v2",
                                        op_id="price-edit")["version"], 2)
                with self.assertRaises(Conflict):
                    update(store, price["id"], title="Price", unit="JPY",
                           value="175", formula=None, base_version=1,
                           reason="new quote", evidence="quote-v2", op_id="price-edit")
