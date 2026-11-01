"""Meaningful API integration checks against raw grain and persisted actions.

Uses the read-only real project DB and an isolated temporary action database.
No source order, production interaction or default demo action is modified.
"""

import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import closing
from datetime import datetime, timedelta
from decimal import Decimal
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from demo_server import DEFAULT_DB, DemoApp, create_server


class DemoAPIIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DEFAULT_DB.is_file():
            raise unittest.SkipTest("Run pipeline.py before the API integration tests")
        cls.temporary = tempfile.TemporaryDirectory(prefix="olist-api-", dir=ROOT / "tests")
        cls.actions_db = Path(cls.temporary.name) / "actions.sqlite"
        cls.app = DemoApp(DEFAULT_DB, cls.actions_db)
        cls.server = create_server(cls.app, 0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.temporary.cleanup()

    def get(self, path, query=None):
        url = self.base_url + path + ("?" + urlencode(query) if query else "")
        try:
            with urlopen(url, timeout=20) as response:
                return response.status, json.load(response)
        except HTTPError as response:
            return response.code, json.load(response)

    def post(self, body, origin=None):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = origin
        request = Request(self.base_url + "/api/action", data=json.dumps(body).encode(), headers=headers, method="POST")
        try:
            with urlopen(request, timeout=10) as response:
                return response.status, json.load(response)
        except HTTPError as response:
            return response.code, json.load(response)

    def raw_connection(self):
        con = sqlite3.connect(DEFAULT_DB.resolve().as_uri() + "?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        return con

    def test_01_full_scope_keeps_no_item_orders_and_money_is_not_multiplied(self):
        status, result = self.get("/api/overview")
        self.assertEqual(status, 200)
        with closing(self.raw_connection()) as con:
            raw_orders = con.execute("SELECT COUNT(*) FROM raw_orders").fetchone()[0]
            no_items = con.execute("SELECT COUNT(*) FROM raw_orders o WHERE NOT EXISTS(SELECT 1 FROM raw_items i WHERE i.order_id=o.order_id)").fetchone()[0]
            items = con.execute("SELECT i.price,i.freight_value,o.order_status FROM raw_items i JOIN raw_orders o ON i.order_id=o.order_id").fetchall()
        cents = lambda x: int(Decimal(x) * 100)
        self.assertEqual(result["cards"]["total_orders"], raw_orders)
        self.assertEqual(result["coverage"]["no_item_orders"], no_items)
        self.assertEqual(result["coverage"]["matched_item_rows"], len(items))
        self.assertEqual(result["cards"]["item_amount_cents"], sum(cents(r["price"]) for r in items))
        self.assertEqual(result["cards"]["freight_amount_cents"], sum(cents(r["freight_value"]) for r in items))
        self.assertEqual(result["cards"]["delivered_item_amount_cents"], sum(cents(r["price"]) for r in items if r["order_status"] == "delivered"))
        self.assertEqual(sum(r["orders"] for r in result["monthly"]), raw_orders)
        self.assertEqual(sum(r["orders"] for r in result["states"]), raw_orders)

    def test_02_seller_category_state_date_filters_match_raw_item_grain(self):
        # Choose a genuine nontrivial intersection, rather than comparing the
        # implementation's CTE to itself.
        with closing(self.raw_connection()) as con:
            sample = con.execute("""SELECT i.seller_id,i.category,c.customer_state
                FROM raw_items i JOIN raw_orders o USING(order_id)
                JOIN raw_customers c USING(customer_id)
                WHERE o.order_purchase_timestamp >= '2017-01-01' AND o.order_purchase_timestamp < '2018-07-01'
                GROUP BY i.seller_id,i.category,c.customer_state ORDER BY COUNT(*) DESC LIMIT 1""").fetchone()
            query = {"seller": sample["seller_id"], "category": sample["category"], "state": sample["customer_state"],
                     "start": "2017-01-01", "end": "2018-06-30"}
            rows = con.execute("""SELECT i.order_id,i.price,i.freight_value,o.order_status FROM raw_items i
                JOIN raw_orders o USING(order_id) JOIN raw_customers c USING(customer_id)
                WHERE i.seller_id=? AND i.category=? AND c.customer_state=?
                  AND o.order_purchase_timestamp>=? AND o.order_purchase_timestamp<?""",
                (query["seller"], query["category"], query["state"], "2017-01-01 00:00:00", "2018-07-01 00:00:00")).fetchall()
        status, result = self.get("/api/overview", query)
        self.assertEqual(status, 200)
        self.assertEqual(result["cards"]["total_orders"], len({r["order_id"] for r in rows}))
        self.assertEqual(result["cards"]["item_amount_cents"], sum(int(Decimal(r["price"]) * 100) for r in rows))
        self.assertEqual(result["coverage"]["matched_item_rows"], len(rows))
        self.assertEqual(result["coverage"]["no_item_orders"], 0)
        status, listing = self.get("/api/orders", query | {"limit": "200"})
        self.assertEqual(status, 200)
        self.assertEqual(listing["total"], result["cards"]["total_orders"])
        self.assertEqual(len({r["order_id"] for r in listing["orders"]}), len(listing["orders"]))

    def test_03_end_date_is_inclusive_and_pagination_is_stable(self):
        query = {"start": "2018-06-30", "end": "2018-06-30", "limit": "7"}
        status, page1 = self.get("/api/orders", query | {"page": "1"})
        status2, page2 = self.get("/api/orders", query | {"page": "2"})
        self.assertEqual((status, status2), (200, 200))
        with closing(self.raw_connection()) as con:
            expected = con.execute("SELECT COUNT(*) FROM raw_orders WHERE order_purchase_timestamp>='2018-06-30 00:00:00' AND order_purchase_timestamp<'2018-07-01 00:00:00'").fetchone()[0]
        self.assertEqual(page1["total"], expected)
        self.assertTrue(all(r["purchase_at"].startswith("2018-06-30") for r in page1["orders"]))
        self.assertFalse({r["order_id"] for r in page1["orders"]} & {r["order_id"] for r in page2["orders"]})
        self.assertEqual(self.get("/api/orders", query | {"page": "1"})[1], page1)

    def test_04_denominators_match_fact_validity_and_missing_outcomes_stay_unknown(self):
        _, overview = self.get("/api/overview", {"start": "2017-01-01", "end": "2018-06-30"})
        with closing(self.raw_connection()) as con:
            row = con.execute("""SELECT SUM(late_valid),SUM(CASE WHEN late_valid=1 AND is_late=1 THEN 1 ELSE 0 END),
                SUM(review_valid),SUM(CASE WHEN review_valid=1 AND review_score<=2 THEN 1 ELSE 0 END)
                FROM fact_orders WHERE purchase_at>='2017-01-01' AND purchase_at<'2018-07-01'""").fetchone()
            missing = con.execute("SELECT order_id FROM fact_orders WHERE delivered_at IS NULL LIMIT 1").fetchone()[0]
        cards = overview["cards"]
        self.assertEqual([cards[k] for k in ("late_valid_orders", "late_orders", "review_valid_orders", "low_score_orders")], list(row))
        self.assertAlmostEqual(cards["late_rate"], row[1] / row[0])
        _, detail = self.get("/api/order/" + missing)
        self.assertEqual(detail["order"]["late_valid"], 0)
        self.assertIsNone(detail["order"]["is_late"])

    def test_05_empty_range_has_null_rates_not_zero_success_claim(self):
        status, result = self.get("/api/overview", {"start": "2016-01-01", "end": "2016-01-02"})
        self.assertEqual(status, 200)
        self.assertEqual(result["cards"]["total_orders"], 0)
        self.assertIsNone(result["cards"]["late_rate"])
        self.assertIsNone(result["cards"]["low_score_rate"])
        self.assertIsNone(result["cards"]["avg_item_amount_brl"])

    def test_06_bad_inputs_and_unknown_order_return_controlled_errors(self):
        cases = [("/api/overview", {"start": "2018-02-30"}),
                 ("/api/overview", {"start": "2018-07-01", "end": "2018-06-01"}),
                 ("/api/orders", {"limit": "201"}), ("/api/orders", {"page": "0"}),
                 ("/api/orders", {"late": "pending"}), ("/api/overview", {"state": "xx'"}),
                 ("/api/overview", {"seller": "' OR 1=1 --"}), ("/api/overview", {"unsupported": "1"}),
                 ("/api/alerts", {"as_of": "2018-08-15T08:00+08:00"}),
                 ("/api/order/" + "0" * 32, {"mode": "replay"}),
                 ("/api/order/" + "0" * 32, {"as_of": "2018-10-01T00:00"})]
        for path, query in cases:
            with self.subTest(path=path, query=query):
                status, payload = self.get(path, query)
                self.assertEqual(status, 400)
                self.assertIn("message", payload["error"])
        self.assertEqual(self.get("/api/order/" + "0" * 32)[0], 404)
        self.assertEqual(self.get("/api/overview?start=2018-01-01&start=2018-01-02")[0], 400)
        self.assertEqual(self.get("/../../evaluation_config.json")[0], 404)

    def test_07_action_persists_retries_are_idempotent_and_ignore_requires_reason(self):
        with closing(self.raw_connection()) as con:
            order_id = con.execute("SELECT order_id FROM fact_orders WHERE replay_eligible=1 ORDER BY order_id LIMIT 1").fetchone()[0]
        self.assertEqual(self.post({"order_id": order_id, "status": "ignored", "note": " "})[0], 400)
        self.assertEqual(self.post({"order_id": "0" * 32, "status": "processing", "note": "验证"})[0], 404)
        self.assertEqual(self.post({"order_id": order_id, "status": "sent"})[0], 400)
        body = {"order_id": order_id, "status": "processing", "note": "仅用于独立API测试"}
        status, first = self.post(body)
        status2, repeated = self.post(body)
        self.assertEqual((status, status2), (200, 200))
        self.assertTrue(first["changed"])
        self.assertFalse(repeated["changed"])
        self.assertEqual(first["history_count"], repeated["history_count"])
        self.assertEqual(first["action"]["updated_at"], repeated["action"]["updated_at"])
        reopened = DemoApp(DEFAULT_DB, self.actions_db)
        saved, history = reopened.action_for(order_id)
        self.assertEqual(saved["status"], "processing")
        self.assertEqual(saved["note"], body["note"])
        self.assertEqual(len(history), first["history_count"])
        self.assertEqual(self.post(body, "https://unrelated.example")[0], 403)
        _, ignored = self.post(body | {"status": "ignored", "note": "已核查：测试忽略"})
        self.assertEqual(ignored["history_count"], first["history_count"] + 1)
        _, detail = self.get("/api/order/" + order_id)
        self.assertTrue(detail["simulated_actions"])
        self.assertEqual(detail["action"]["status"], "ignored")
        self.assertEqual(detail["order"]["order_status"], "delivered")

    def test_08_replay_detail_hides_future_events_and_all_final_labels(self):
        with closing(self.raw_connection()) as con:
            row = dict(con.execute("SELECT * FROM fact_orders WHERE replay_eligible=1 AND carrier_at>approved_at AND purchase_at>='2018-08-01' LIMIT 1").fetchone())
        at_approval = datetime.fromisoformat(row["approved_at"])
        status, replay = self.get("/api/order/" + row["order_id"], {"mode": "replay", "as_of": at_approval.isoformat(timespec="seconds")})
        self.assertEqual(status, 200)
        view = replay["order"]
        self.assertIn("approved_at", view)
        forbidden = {"carrier_at", "delivered_at", "order_status", "review_score", "review_answer_at", "late_valid", "is_late", "replay_eligible", "payment_amount_cents", "handoff_hours", "transit_hours", "total_delivery_hours"}
        self.assertFalse(forbidden & set(view))
        self.assertTrue(all(datetime.fromisoformat(event["at"]) <= at_approval for event in replay["timeline"]))
        self.assertNotIn(row["carrier_at"], json.dumps(replay, ensure_ascii=False))
        before_purchase = datetime.fromisoformat(row["purchase_at"]) - timedelta(seconds=1)
        self.assertEqual(self.get("/api/order/" + row["order_id"], {"as_of": before_purchase.isoformat(timespec="seconds")})[0], 404)
        before_approval = at_approval - timedelta(seconds=1)
        if before_approval >= datetime.fromisoformat(row["purchase_at"]):
            _, earlier = self.get("/api/order/" + row["order_id"], {"as_of": before_approval.isoformat(timespec="seconds")})
            self.assertEqual(earlier["items"], [])
            self.assertNotIn("shipping_deadline_at", earlier["order"])

    def test_09_queue_uses_single_deduplicated_tasks_and_persisted_action_state(self):
        status, queue = self.get("/api/alerts", {"as_of": "2018-08-15T08:00", "limit": "200"})
        self.assertEqual(status, 200)
        self.assertGreater(queue["total"], 0)
        ids = [task["order_id"] for task in queue["alerts"]]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(sum(queue["counts"][r] for r in ("R1", "R2", "R3", "R4")), sum(queue["counts"][s] for s in ("pending", "processing", "resolved", "ignored")))
        for task in queue["alerts"]:
            self.assertNotIn("order_status", task["order"])
            self.assertNotIn("review_score", task["order"])
            self.assertNotIn("is_late", task["order"])
            self.assertNotIn("delivered_at", task["order"])
        order_id = queue["alerts"][0]["order_id"]
        self.post({"order_id": order_id, "status": "resolved", "note": "本地模拟已核查"})
        _, filtered = self.get("/api/alerts", {"as_of": "2018-08-15T08:00", "action_status": "resolved", "limit": "200"})
        self.assertIn(order_id, [task["order_id"] for task in filtered["alerts"]])
        self.assertTrue(all(task["action"]["status"] == "resolved" for task in filtered["alerts"]))
        _, again = self.get("/api/alerts", {"as_of": "2018-08-15T08:00", "limit": "200"})
        self.assertEqual(queue["total"], again["total"])  # Disposition never rewrites fulfillment.

    def test_10_meta_and_evidence_are_available(self):
        status, meta = self.get("/api/meta")
        self.assertEqual(status, 200)
        self.assertEqual(meta["source"]["version"], 2)
        self.assertEqual(meta["source"]["license"], "CC BY-NC-SA 4.0")
        self.assertGreater(len(meta["sellers"]), 3000)
        self.assertGreater(len(meta["categories"]), 50)
        self.assertEqual(self.get("/api/quality")[0], 200)
        status, report = self.get("/api/replay_report")
        self.assertEqual(status, 200)
        self.assertIn("summaries", report)
        self.assertIn("limitations", report)


if __name__ == "__main__":
    unittest.main(verbosity=2)
