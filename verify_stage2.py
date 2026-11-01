"""Independent raw-cent and SQLite checks for the order facts and published evidence."""

import csv
import hashlib
import io
import json
import re
import sqlite3
import zipfile
from decimal import Decimal
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent


def main():
    checks = []
    def check(name, condition, detail):
        checks.append({"check": name, "passed": bool(condition), "detail": detail})
        if not condition:
            raise AssertionError(f"{name}: {detail}")

    receipt = json.loads((ROOT / "data/raw/download_receipt.json").read_text(encoding="utf-8"))
    check("raw_zip_hash_matches_receipt", hashlib.sha256(
        (ROOT / "data/raw/brazilian-ecommerce-v2.zip").read_bytes()).hexdigest() == receipt["sha256"],
        {"sha256": receipt["sha256"]})
    raw_totals = {}
    order_rows = {}
    with zipfile.ZipFile(ROOT / "data/raw/brazilian-ecommerce-v2.zip") as archive:
        for filename, fields in [("olist_order_items_dataset.csv", ["price", "freight_value"]),
                                  ("olist_order_payments_dataset.csv", ["payment_value"])]:
            readers = csv.DictReader(io.TextIOWrapper(archive.open(filename), encoding="utf-8"))
            sums = {field: 0 for field in fields}
            for row in readers:
                for field in fields:
                    sums[field] += int(Decimal(row[field]) * 100)
            raw_totals.update(sums)
        for row in csv.DictReader(io.TextIOWrapper(archive.open("olist_orders_dataset.csv"), encoding="utf-8")):
            order_rows[row["order_id"]] = row

    with sqlite3.connect(ROOT / "data/processed/olist.sqlite") as connection:
        total, unique = connection.execute("SELECT COUNT(*),COUNT(DISTINCT order_id) FROM fact_orders").fetchone()
        check("all_orders_retained_once", total == unique == len(order_rows), {"rows": total, "unique": unique})
        item, freight, payment = connection.execute(
            "SELECT SUM(item_amount_cents),SUM(freight_amount_cents),SUM(payment_amount_cents) FROM fact_orders").fetchone()
        check("raw_decimal_cents_match_order_fact", (item, freight, payment) == (
              raw_totals["price"], raw_totals["freight_value"], raw_totals["payment_value"]), raw_totals)
        seller_item, seller_freight = connection.execute(
            "SELECT SUM(item_amount_cents),SUM(freight_amount_cents) FROM fact_order_sellers").fetchone()
        check("seller_amounts_match_order_fact", (seller_item, seller_freight) == (item, freight),
              {"item_cents": seller_item, "freight_cents": seller_freight})
        invalid = connection.execute("SELECT COUNT(*) FROM fact_orders WHERE replay_eligible=1 AND "
            "(item_count<>1 OR order_status<>'delivered' OR timeline_valid<>1 OR shipping_deadline_valid<>1)").fetchone()[0]
        check("replay_scope_constraints", invalid == 0, {"invalid_eligible_orders": invalid})
        stored = dict(connection.execute("SELECT order_id,is_late FROM fact_orders WHERE late_valid=1").fetchall())
        expected = {}
        for order_id, row in order_rows.items():
            purchased, received, estimate = row["order_purchase_timestamp"], row["order_delivered_customer_date"], row["order_estimated_delivery_date"]
            if row["order_status"] == "delivered" and purchased and received and estimate:
                # The source estimate has no intra-day time. A same-calendar-day arrival is on time.
                if received >= purchased and estimate[:10] >= purchased[:10]:
                    expected[order_id] = int(received[:10] > estimate[:10])
        check("date_based_lateness_from_raw", stored == expected,
              {"valid_orders": len(expected), "late_orders": sum(expected.values())})
        same_day_bad = connection.execute("SELECT COUNT(*) FROM fact_orders WHERE late_valid=1 "
            "AND substr(delivered_at,1,10)=substr(estimated_at,1,10) AND is_late<>0").fetchone()[0]
        check("same_day_delivery_is_on_time", same_day_bad == 0, {"incorrect_same_day_labels": same_day_bad})
        sql = (ROOT / "sql/analysis.sql").read_text(encoding="utf-8")
        blocks = re.split(r"-- name: ([a-z_]+)\n", sql)
        outputs = {}
        for i in range(1, len(blocks), 2):
            name, query = blocks[i], blocks[i+1].strip()
            frame = pd.read_sql_query(query, connection)
            frame.to_csv(ROOT / f"evidence/{name}.csv", index=False, encoding="utf-8-sig")
            outputs[name] = json.loads(frame.to_json(orient="records", force_ascii=False))
    results_path = ROOT / "evidence/analysis_results.json"
    results = json.loads(results_path.read_text(encoding="utf-8"))
    results["query_results"] = outputs
    results_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    report = {"source_sha256": receipt["sha256"], "checks": checks, "passed": all(x["passed"] for x in checks)}
    (ROOT / "evidence/stage2_verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
