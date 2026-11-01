"""Independently reconcile the public projection with source CSVs, without DemoApp."""
import argparse
import csv
import gzip
import hashlib
import io
import json
import zipfile
from decimal import Decimal
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    source = args.source / "data/raw/brazilian-ecommerce-v2.zip"
    export = json.loads(gzip.decompress((root / "dist/data/orders.json.gz").read_bytes()))
    actual = {row[0]: dict(zip(export["fields"], row)) for row in zip(*export["columns"])}
    checks = []
    def check(name, condition, detail):
        checks.append({"name": name, "passed": bool(condition), "detail": detail})
        if not condition:
            raise AssertionError(name + ": " + str(detail))
    with zipfile.ZipFile(source) as z:
        def rows(name):
            return csv.DictReader(io.TextIOWrapper(z.open(name), encoding="utf-8-sig"))
        customers = {r["customer_id"]: r["customer_state"] for r in rows("olist_customers_dataset.csv")}
        raw_orders = list(rows("olist_orders_dataset.csv"))
        check("all_orders_unique_and_retained", len(actual) == len(raw_orders) == 99441,
              {"raw_rows": len(raw_orders), "export_unique": len(actual)})
        valid, late = {}, {}
        metrics = {k: {"valid": 0, "late": 0} for k in ("all", "RJ", "SP")}
        for row in raw_orders:
            oid = row["order_id"]
            purchase = row["order_purchase_timestamp"]
            received = row["order_delivered_customer_date"]
            estimate = row["order_estimated_delivery_date"]
            state = customers[row["customer_id"]]
            eligible = bool(row["order_status"] == "delivered" and purchase and received and estimate
                            and received >= purchase and estimate[:10] >= purchase[:10])
            valid[oid] = int(eligible)
            if eligible:
                late[oid] = int(received[:10] > estimate[:10])
                if "2017-01-01" <= purchase[:10] <= "2018-06-30":
                    for key in ("all", state):
                        if key in metrics:
                            metrics[key]["valid"] += 1
                            metrics[key]["late"] += late[oid]
            check_label = actual[oid]
            if check_label["late_valid"] != valid[oid] or (eligible and check_label["is_late"] != late[oid]):
                raise AssertionError("raw lateness differs for " + oid)
            if check_label["customer_state"] != state:
                raise AssertionError("raw region differs for " + oid)
        check("all_order_lateness_and_regions_match_raw_csv", True,
              {"compared_orders": len(raw_orders), "valid_orders": sum(valid.values()), "late_orders": sum(late.values())})
        for key, expected in {"all": (83696, 5930), "RJ": (10891, 1436), "SP": (34523, 1432)}.items():
            m = metrics[key]
            m["rate"] = m["late"] / m["valid"]
            check("discovery_scope_" + key, (m["valid"], m["late"]) == expected, m)
        totals = {k: 0 for k in ("price", "freight_value", "payment_value")}
        for file, fields in (("olist_order_items_dataset.csv", ("price", "freight_value")),
                             ("olist_order_payments_dataset.csv", ("payment_value",))):
            for row in rows(file):
                for field in fields:
                    totals[field] += int(Decimal(row[field]) * 100)
        for source_field, fact_field in (("price", "item_amount_cents"), ("freight_value", "freight_amount_cents"),
                                        ("payment_value", "payment_amount_cents")):
            exported = sum(r[fact_field] or 0 for r in actual.values())
            check("raw_money_cents_" + source_field, exported == totals[source_field], {"raw": totals[source_field], "export": exported})
    report = {"source_zip_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "method": "Direct CSV parsing; Decimal cents; calendar-day delivery; no DemoApp or exported KPI constants",
              "checks": checks, "passed": all(c["passed"] for c in checks)}
    (root / "evidence/raw_export_reconciliation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
