"""Business and privacy checks for offline aggregates; no network or UI dependencies."""
import importlib.util
import json
import re
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("prepare_dashboard", ROOT / "scripts/prepare_dashboard.py")
PREP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREP)


def review(oid="订单", rid="甲", score="5", created="2018-01-02 00:00:00", answered="2018-01-03 09:00:00"):
    return {"order_id": oid, "review_id": rid, "review_score": score,
            "review_creation_date": created, "review_answer_timestamp": answered}


def replay_order(**overrides):
    base = {"sellers": {"商"}, "approved": PREP.AS_OF - timedelta(days=1),
            "promise": PREP.AS_OF + timedelta(days=2), "delivered": PREP.AS_OF + timedelta(days=3),
            "eligible": True, "late": True,
            "review": {"score": 1, "answer": PREP.AS_OF + timedelta(days=4)}}
    base.update(overrides)
    return base


class PureFunctions(unittest.TestCase):
    def test_integer_cents_are_exact_and_invalid_money_is_not_zero(self):
        self.assertEqual(PREP.cents("0.29"), 29)
        self.assertEqual(PREP.cents("1699.00"), 169900)
        for value in ("-1", "NaN", "Infinity", "1.001", "", None):
            self.assertIsNone(PREP.cents(value))

    def test_zero_denominator_is_unknown_not_zero(self):
        self.assertIsNone(PREP.ratio(0, 0))
        self.assertEqual(PREP.ratio(0, 4), 0)

    def test_same_promise_calendar_day_is_on_time(self):
        eligible, late, days, end = PREP.late_facts("delivered", datetime(2018, 1, 1),
            datetime(2018, 1, 5, 23, 59, 59), datetime(2018, 1, 5))
        self.assertTrue(eligible)
        self.assertFalse(late)
        self.assertEqual(days, 0)
        self.assertEqual(end, datetime(2018, 1, 6))
        self.assertTrue(PREP.late_facts("delivered", datetime(2018, 1, 1), datetime(2018, 1, 6), datetime(2018, 1, 5))[1])

    def test_invalid_final_timeline_does_not_enter_otd_denominator(self):
        for status, purchase, delivered, estimated in [
            ("canceled", datetime(2018, 1, 1), datetime(2018, 1, 2), datetime(2018, 1, 3)),
            ("delivered", datetime(2018, 1, 2), datetime(2018, 1, 1), datetime(2018, 1, 3)),
            ("delivered", datetime(2018, 1, 4), datetime(2018, 1, 5), datetime(2018, 1, 3)),
            ("delivered", datetime(2018, 1, 1), None, datetime(2018, 1, 3)),
        ]:
            self.assertFalse(PREP.late_facts(status, purchase, delivered, estimated)[0])

    def test_review_chooses_latest_valid_answer_and_not_highest_score(self):
        rows = [review(score="5"), review(rid="乙", score="1", answered="2018-01-04 00:00:00"),
                review(rid="丙", score="5", answered="2017-12-31 23:00:00"),
                review(rid="丁", score="0", answered="2018-01-05 00:00:00")]
        chosen, valid = PREP.choose_reviews(rows, {"订单": datetime(2018, 1, 1)})
        self.assertEqual(valid, 2)
        self.assertEqual(chosen["订单"]["score"], 1)

    def test_review_creation_date_and_identifier_tie_break(self):
        rows = [review(rid="b", score="5"), review(rid="a", score="1"),
                review(rid="0", score="2", created="2017-12-31 00:00:00", answered="2018-01-06 00:00:00")]
        chosen, valid = PREP.choose_reviews(rows, {"订单": datetime(2018, 1, 1)})
        self.assertEqual(valid, 2)
        self.assertEqual(chosen["订单"]["score"], 1)
        same_id, _ = PREP.choose_reviews([review(rid="a", score="2"), review(rid="a", score="4")],
                                        {"订单": datetime(2018, 1, 1)})
        self.assertEqual(same_id["订单"]["score"], 2)

    def test_chinese_mapping_is_explicit_and_unknown_fails(self):
        self.assertEqual(PREP.chinese_category("pc_gamer"), "数码家电")
        self.assertEqual(PREP.chinese_category("portateis_cozinha_e_preparadores_de_alimentos"), "数码家电")
        self.assertEqual(PREP.chinese_category(""), "未分类")
        with self.assertRaises(ValueError):
            PREP.chinese_category("unreviewed-new-category")

    def test_small_seller_sample_is_not_called_low_risk(self):
        self.assertEqual(PREP.risk_tier(29, 0), "样本不足")
        self.assertEqual(PREP.risk_tier(100, 15), "高危")
        self.assertEqual(PREP.risk_tier(100, 8), "关注")
        self.assertEqual(PREP.risk_tier(100, 7), "稳健")

    def test_replay_deduplicates_single_seller_and_respects_cutoff(self):
        orders = {"有效": replay_order(), "多商家": replay_order(sellers={"商", "另一商"}),
                  "已收货": replay_order(delivered=PREP.AS_OF),
                  "未批准": replay_order(approved=PREP.AS_OF + timedelta(seconds=1)),
                  "截止过去": replay_order(promise=PREP.AS_OF),
                  "非代表商家": replay_order(sellers={"另一商"})}
        cell = PREP.replay_cell(orders, {"商"}, {"商": 10000}, 2, 100)
        self.assertEqual(cell["alerts"], 1)
        self.assertEqual(cell["knownBadReviews"], 1)
        self.assertEqual(cell["observableOutcomes"], 1)
        self.assertEqual(cell["lateOutcomes"], 1)
        self.assertEqual(PREP.replay_cell(orders, {"商"}, {"商": 9999}, 2, 100)["alerts"], 0)

    def test_replay_includes_upper_boundary_and_excludes_current_bad_review(self):
        order = replay_order(review={"score": 1, "answer": PREP.AS_OF})
        cell = PREP.replay_cell({"单": order}, {"商"}, {"商": 10000}, 2, 100)
        self.assertEqual(cell["alerts"], 1)
        self.assertEqual(cell["knownBadReviews"], 0)
        self.assertEqual(cell["observableOutcomes"], 0)
        self.assertEqual(PREP.replay_cell({"单": order}, {"商"}, {"商": 10000}, 0, 0)["alerts"], 0)

    def test_wrong_source_hash_fails_before_csv_or_database(self):
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory) / "data/raw"
            raw.mkdir(parents=True)
            (raw / "brazilian-ecommerce-v2.zip").write_bytes(b"wrong-source")
            with self.assertRaisesRegex(ValueError, "冻结来源"):
                PREP.build_dashboard(directory)


class FrozenAggregates(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.body = (ROOT / "src/dashboardData.json").read_bytes()
        cls.data = json.loads(cls.body)

    def test_data_is_small_and_full_population_has_no_denominator_loss(self):
        self.assertLess(len(self.body), 80000)
        k = self.data["kpis"]
        self.assertEqual(k["orders"], 99441)
        self.assertEqual(self.data["scope"]["sourceItems"], 112650)
        self.assertEqual((k["onTime"], k["eligible"], k["late"]), (89936, 96470, 6534))
        self.assertEqual((k["lateReviewed"], k["lateLowReviews"]), (6381, 3983))
        self.assertEqual(k["onTime"] + k["late"], k["eligible"])
        self.assertEqual(sum(b["orders"] for b in self.data["delayBands"]), k["eligible"])
        self.assertEqual(sum(c["gmvCents"] for c in self.data["categories"]), k["totalGmvCents"])

    def test_exactly_thirty_unique_chinese_merchants_and_three_actions(self):
        merchants = self.data["merchants"]
        self.assertEqual(len(merchants), 30)
        self.assertEqual(len({m["id"] for m in merchants}), 30)
        for m in merchants:
            for key in ("id", "label", "role", "tier", "category", "pain"):
                self.assertNotRegex(m[key], r"[A-Za-z]|[a-f0-9]{32}")
            self.assertEqual(len(m["actions"]), 3)
            for action in m["actions"]:
                self.assertGreaterEqual(len(action), 10)
                self.assertNotRegex(action, "[A-Za-z]")
        for role in ("高营收高延迟", "高营收高履约", "高增长"):
            self.assertEqual(sum(m["role"] == role for m in merchants), 10)

    def test_client_data_contains_no_raw_identifiers_or_review_text(self):
        text = self.body.decode("utf-8")
        self.assertNotRegex(text, r"[a-f0-9]{32}")
        for forbidden in ("seller_id", "merchant_id", "order_id", "customer_id", "review_comment", "latitude", "longitude"):
            self.assertNotIn(forbidden, text)
        for c in self.data["categories"]:
            self.assertNotRegex(c["name"], "[A-Za-z]")

    def test_risk_amount_is_all_sellers_and_not_top_thirty_denominator(self):
        k = self.data["kpis"]
        self.assertEqual(k["highRiskGmvShare"], PREP.ratio(k["highRiskGmvCents"], k["totalGmvCents"]))
        self.assertGreater(self.data["audit"]["highRiskMerchants"], 30)
        self.assertNotEqual(k["totalGmvCents"], sum(m["gmvCents"] for m in self.data["merchants"]))

    def test_replay_all_eighty_eight_thresholds_are_monotonic_and_bounded(self):
        cells = self.data["replay"]["cells"]
        self.assertEqual(len(cells), 88)
        lookup = {(c["days"], c["aov"]): c for c in cells}
        self.assertEqual(len(lookup), 88)
        self.assertGreater(max(c["alerts"] for c in cells), 0)
        self.assertGreater(max(c["knownBadReviews"] for c in cells), 0)
        for c in cells:
            self.assertLessEqual(c["knownBadReviews"], c["observableOutcomes"])
            self.assertLessEqual(c["observableOutcomes"], c["alerts"])
            self.assertLessEqual(c["lateOutcomes"], c["alerts"])
            if c["days"] < 7:
                self.assertLessEqual(c["alerts"], lookup[(c["days"] + 1, c["aov"])]["alerts"])
            if c["aov"] < 500:
                self.assertGreaterEqual(c["alerts"], lookup[(c["days"], c["aov"] + 50)]["alerts"])

    def test_source_and_crosscheck_evidence_proves_original_metrics(self):
        evidence = json.loads((ROOT / "evidence/data-checks.json").read_text(encoding="utf-8"))
        self.assertTrue(evidence["passed"])
        check = evidence["crosscheck"]
        self.assertTrue(check["passed"])
        self.assertEqual(check["chosenReviewScoresCompared"], 98612)
        self.assertEqual(check["merchantOrderGmvAndDenominatorsCompared"], 3095)
        self.assertEqual(check["legacyWindow"]["全部"], {"eligible": 83696, "late": 5930})
        self.assertEqual(check["legacyWindow"]["RJ"], {"eligible": 10891, "late": 1436})
        self.assertEqual(check["legacyWindow"]["SP"], {"eligible": 34523, "late": 1432})
        self.assertTrue(check["databaseUnchanged"])
        self.assertEqual(check["databaseSha256Before"], check["databaseSha256After"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
