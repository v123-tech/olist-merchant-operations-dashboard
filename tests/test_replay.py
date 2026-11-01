"""Business boundary tests, including an independent hourly enumeration oracle."""

import hashlib
import json
import random
import sqlite3
import sys
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import replay


CONFIG = replay.load_config()


def order(**overrides):
    row = {"order_id": "test-order", "purchase_at": "2018-08-01 09:30:00",
           "approved_at": "2018-08-01 10:00:00", "carrier_at": "2018-08-03 12:00:00",
           "delivered_at": "2018-08-05 14:00:00", "estimated_at": "2018-08-04 00:00:00",
           "promise_end_exclusive": "2018-08-05 00:00:00",
           "shipping_limit_min": "2018-08-02 12:00:00", "shipping_limit_max": "2018-08-02 12:00:00",
           "item_count": 1, "seller_count": 1, "single_item_seller_id": "seller-a",
           "single_product_id": "product-a", "single_category": "test-category", "customer_state": "SP",
           "item_amount_cents": 1234, "freight_amount_cents": 321,
           "order_status": "delivered", "review_score": 1, "is_late": 1,
           "late_days": 1, "replay_eligible": 1, "timestamps_available": 1,
           "timeline_valid": 1, "shipping_deadline_valid": 1, "late_valid": 1}
    row.update(overrides)
    return row


class AsOfTests(unittest.TestCase):
    def test_not_yet_purchased_is_invisible(self):
        view = replay.at_time(order(), "2018-08-01 09:00:00")
        self.assertFalse(view["visible"])
        self.assertNotIn("order_id", view)
        self.assertEqual(replay.alerts_at(order(), view["as_of"], CONFIG), [])

    def test_static_fields_visible_only_after_approval(self):
        before = replay.at_time(order(), "2018-08-01 09:45:00")
        after = replay.at_time(order(), "2018-08-01 10:00:00")
        self.assertNotIn("shipping_deadline_at", before)
        self.assertNotIn("item_amount_cents", before)
        self.assertIn("shipping_deadline_at", after)
        self.assertEqual(after["item_amount_cents"], 1234)

    def test_future_events_and_final_labels_cannot_leak(self):
        row = order()
        t = "2018-08-02 00:00:00"
        changed = order(carrier_at="2018-08-04 12:00:00", delivered_at="2018-08-20 14:00:00",
                        order_status="cancelled", review_score=5, review_answer_at="2018-08-02 00:00:00",
                        is_late=0, late_days=99, replay_eligible=0, transit_hours=9999,
                        timeline_valid=0, shipping_deadline_valid=0, late_valid=0)
        self.assertEqual(replay.at_time(row, t), replay.at_time(changed, t))
        self.assertEqual(replay.alerts_at(row, t, CONFIG), replay.alerts_at(changed, t, CONFIG))
        view = replay.at_time(row, t)
        for field in ("carrier_at", "delivered_at", "order_status", "review_score", "is_late",
                      "replay_eligible", "transit_hours", "late_valid", "timeline_valid"):
            self.assertNotIn(field, view)
        self.assertIn("as_of", json.loads(json.dumps(view)))

    def test_event_equality_is_visible_and_suppresses_hint(self):
        row = order(carrier_at="2018-08-02 12:00:00")
        self.assertIn("carrier_at", replay.at_time(row, row["carrier_at"]))
        self.assertNotIn("R1", replay.rule_matches(replay.at_time(row, row["carrier_at"]), CONFIG))
        row = order(delivered_at="2018-08-05 00:00:00")
        self.assertEqual(replay.alerts_at(row, row["delivered_at"], CONFIG), [])


class RuleBoundaryTests(unittest.TestCase):
    def test_R1_includes_24_hours_and_shipping_deadline_equality(self):
        row = order()
        self.assertIn("R1", replay.rule_matches(replay.at_time(row, "2018-08-01 12:00:00"), CONFIG))
        self.assertNotIn("R1", replay.rule_matches(replay.at_time(row, "2018-08-01 11:59:59"), CONFIG))
        matches = replay.rule_matches(replay.at_time(row, "2018-08-02 12:00:00"), CONFIG)
        self.assertIn("R1", matches)
        self.assertNotIn("R2", matches)

    def test_R2_requires_strictly_past_deadline(self):
        row = order()
        triggers = replay.first_triggers(row, CONFIG)
        self.assertEqual(triggers["R2"], datetime(2018, 8, 2, 13))
        row = order(shipping_limit_min="2018-08-02 12:00:01")
        self.assertEqual(replay.first_triggers(row, CONFIG)["R2"], datetime(2018, 8, 2, 13))

    def test_hourly_rounding_can_remove_a_short_opportunity(self):
        row = order(approved_at="2018-08-01 12:00:01", carrier_at="2018-08-01 12:59:59")
        self.assertNotIn("R1", replay.first_triggers(row, CONFIG))
        row = order(shipping_limit_min="2018-08-02 12:20:00")
        self.assertEqual(replay.first_triggers(row, CONFIG)["R1"], datetime(2018, 8, 1, 13))

    def test_same_day_delivery_is_on_time_under_date_end_boundary(self):
        row = order(delivered_at="2018-08-04 23:59:59", is_late=0)
        self.assertLess(replay.dt(row["delivered_at"]), replay.dt(row["promise_end_exclusive"]))
        triggers = replay.first_triggers(row, CONFIG)
        self.assertIn("R3", triggers)
        self.assertNotIn("R4", triggers)
        result = replay.evaluate([row], CONFIG)
        merged = next(s for s in result["summaries"] if s["window"] == "holdout"
                      and s["rule"] == "COMBINED_R1_R2_R3")
        self.assertEqual(merged["A_intersection_L"], 0)
        self.assertEqual(merged["A_not_L"], 1)

    def test_overlap_deduplicates_by_order_and_priority(self):
        row = order(carrier_at="2018-08-05 10:00:00")
        tasks = replay.alerts_at(row, "2018-08-04 12:00:00", CONFIG)
        self.assertEqual(len(tasks), 1)
        self.assertEqual(tasks[0]["primary_rule"], "R2")
        self.assertEqual(tasks[0]["matched_rules"], ["R2", "R3"])
        before_id = tasks[0]["task_id"]
        later = replay.alerts_at(row, "2018-08-05 00:00:00", CONFIG)[0]
        self.assertEqual(later["primary_rule"], "R4")
        self.assertEqual(later["kind"], "overdue_monitoring")
        self.assertEqual(later["task_id"], before_id)

    def test_R4_never_counts_as_advance_success(self):
        result = replay.evaluate([order()], CONFIG)
        monitor = next(s for s in result["summaries"] if s["window"] == "holdout"
                       and s["rule"] == "R4_MONITOR_ONLY")
        self.assertEqual(monitor["all_triggered_orders"], 1)
        self.assertEqual(monitor["A_before_promise"], 0)
        self.assertEqual(monitor["A_intersection_L"], 0)
        self.assertIsNone(monitor["hint_hit_share"])
        self.assertIsNone(monitor["late_advance_coverage"])
        self.assertIsNone(monitor["hits_advance_hours_median"])

    def test_known_anomaly_goes_outside_normal_rules(self):
        row = order(shipping_limit_min="2018-08-01 09:00:00")
        self.assertEqual(replay.alerts_at(row, "2018-08-02 00:00:00", CONFIG), [])
        self.assertIn("异常", replay._known_problem(replay.at_time(row, "2018-08-02 00:00:00")))

    def test_multiline_orders_not_implicitly_supported(self):
        self.assertEqual(replay.alerts_at(order(item_count=2), "2018-08-04 12:00:00", CONFIG), [])


class EvaluationTests(unittest.TestCase):
    def test_cutoff_is_exclusive_and_bad_outcomes_not_filled_as_normal(self):
        exact_C = order(order_id="exact-C", delivered_at="2018-10-01 00:00:00")
        unknown = order(order_id="unknown", order_status="shipped", delivered_at=None,
                        replay_eligible=0, timeline_valid=0, late_valid=0, timestamps_available=0)
        invalid = order(order_id="invalid", delivered_at=None, late_valid=0,
                        timeline_valid=0, timestamps_available=0)
        result = replay.evaluate([order(), exact_C, unknown, invalid], CONFIG)
        self.assertEqual(result["filter_audits"]["holdout"]["survivors"]["delivered_before_C"], 1)
        classes = result["outcome_audits"]["holdout"]
        self.assertEqual(classes["recorded_delivery_at_or_after_C_right_censored_for_replay"], 1)
        self.assertEqual(classes["final_snapshot_not_delivered_no_complete_delivery_outcome"], 1)
        self.assertEqual(classes["delivered_snapshot_missing_or_invalid_outcome"], 1)

    def test_merged_count_is_order_deduplicated_and_windows_are_exclusive(self):
        row = order()
        result = replay.evaluate([row], CONFIG)
        merged = next(s for s in result["summaries"] if s["window"] == "holdout"
                      and s["rule"] == "COMBINED_R1_R2_R3")
        self.assertEqual(merged["E"], 1)
        self.assertEqual(merged["A_before_promise"], 1)
        self.assertEqual(merged["A_intersection_L"], 1)
        self.assertEqual(replay.window_for(order(purchase_at="2018-07-01 00:00:00"), CONFIG), "validation")
        self.assertEqual(replay.window_for(order(purchase_at="2018-08-01 00:00:00"), CONFIG), "holdout")
        self.assertIsNone(replay.window_for(order(purchase_at="2018-09-01 00:00:00"), CONFIG))

    def test_analytic_first_times_equal_independent_hour_by_hour_oracle(self):
        rng = random.Random(20271009)
        for _ in range(35):
            purchase = datetime(2018, 8, 1, 9, 13)
            approved = purchase + timedelta(minutes=rng.randrange(1, 300))
            shipping = approved + timedelta(hours=rng.randrange(1, 42), minutes=rng.randrange(60))
            promise = datetime(2018, 8, 5)
            carrier = approved + timedelta(hours=rng.randrange(1, 90), minutes=rng.randrange(60))
            delivered = carrier + timedelta(hours=rng.randrange(1, 65), minutes=rng.randrange(60))
            row = order(purchase_at=replay.iso(purchase), approved_at=replay.iso(approved),
                        shipping_limit_min=replay.iso(shipping), carrier_at=replay.iso(carrier),
                        delivered_at=replay.iso(delivered))
            expected = {}
            t = replay.ceil_hour(purchase)
            while t <= delivered + timedelta(hours=1):
                # Deliberately independent equations, no calls to rule_matches.
                if t >= approved:
                    if t < carrier and shipping - timedelta(hours=24) <= t <= shipping:
                        expected.setdefault("R1", t)
                    if t < carrier and t > shipping:
                        expected.setdefault("R2", t)
                    if t < delivered and promise - timedelta(hours=24) <= t < promise:
                        expected.setdefault("R3", t)
                    if t < delivered and t >= promise:
                        expected.setdefault("R4", t)
                t += timedelta(hours=1)
            self.assertEqual(replay.first_triggers(row, CONFIG), expected)

    def test_real_orders_equal_independent_hourly_enumeration(self):
        if not replay.DB.exists():
            self.skipTest("Prepared database not present")
        with sqlite3.connect(f"file:{replay.DB.as_posix()}?mode=ro", uri=True) as conn:
            conn.row_factory = sqlite3.Row
            population = [dict(r) for r in conn.execute("SELECT * FROM fact_orders WHERE replay_eligible=1 ORDER BY order_id")]
        rng = random.Random(20271009)
        sampled = []
        for window in ("exploration", "validation", "holdout"):
            for outcome in (0, 1):
                segment = [r for r in population if replay.window_for(r, CONFIG) == window and r["is_late"] == outcome]
                sampled.extend(rng.sample(segment, min(10, len(segment))))
        self.assertEqual(len(sampled), 60)
        for row in sampled:
            approved = replay.dt(row["approved_at"])
            shipping = replay.dt(row["shipping_limit_min"])
            carrier = replay.dt(row["carrier_at"])
            delivered = replay.dt(row["delivered_at"])
            promise = replay.dt(row["promise_end_exclusive"])
            t = replay.ceil_hour(replay.dt(row["purchase_at"]))
            expected = {}
            while t <= delivered:
                if t >= approved:
                    if t < carrier and shipping - timedelta(hours=CONFIG["shipping_warning_hours"]) <= t <= shipping:
                        expected.setdefault("R1", t)
                    if t < carrier and t > shipping:
                        expected.setdefault("R2", t)
                    if t < delivered and promise - timedelta(hours=CONFIG["delivery_warning_hours"]) <= t < promise:
                        expected.setdefault("R3", t)
                    if t < delivered and t >= promise:
                        expected.setdefault("R4", t)
                t += timedelta(hours=1)
            self.assertEqual(replay.first_triggers(row, CONFIG), expected, row["order_id"])


if __name__ == "__main__":
    started = time.perf_counter()
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    report = {"scope": "replay interfaces, business boundaries, and independent hourly enumeration",
              "tests_run": result.testsRun, "failures": len(result.failures), "errors": len(result.errors),
              "skipped": len(result.skipped), "successful": result.wasSuccessful(),
              "elapsed_seconds": round(time.perf_counter() - started, 4),
              "synthetic_oracle_orders": 35, "real_oracle_orders": 60,
              "seed": 20271009, "config_sha256": hashlib.sha256(replay.CONFIG_PATH.read_bytes()).hexdigest(),
              "test_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "replay_source_sha256": hashlib.sha256((ROOT / "replay.py").read_bytes()).hexdigest(),
              "run_at": datetime.now().isoformat(timespec="seconds"),
              "limits": "These tests do not validate production ingestion, user usefulness or actual lateness reduction."}
    (ROOT / "evidence" / "replay_test_results.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    sys.exit(0 if result.wasSuccessful() else 1)
