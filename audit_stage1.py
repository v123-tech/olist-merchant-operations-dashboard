"""Reproduce the raw-file schema audit; no business findings or cleaning rules."""

import hashlib
import json
import platform
import sqlite3
import zipfile
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
ZIP = RAW / "brazilian-ecommerce-v2.zip"

DATE_COLUMNS = {
    "olist_orders_dataset.csv": [
        "order_purchase_timestamp", "order_approved_at",
        "order_delivered_carrier_date", "order_delivered_customer_date",
        "order_estimated_delivery_date",
    ],
    "olist_order_items_dataset.csv": ["shipping_limit_date"],
    "olist_order_reviews_dataset.csv": [
        "review_creation_date", "review_answer_timestamp",
    ],
}
KEYS = {
    "olist_orders_dataset.csv": ["order_id"],
    "olist_customers_dataset.csv": ["customer_id"],
    "olist_products_dataset.csv": ["product_id"],
    "olist_sellers_dataset.csv": ["seller_id"],
    "olist_order_items_dataset.csv": ["order_id", "order_item_id"],
    "olist_order_payments_dataset.csv": ["order_id", "payment_sequential"],
    "product_category_name_translation.csv": ["product_category_name"],
}


def main():
    receipt = json.loads((RAW / "download_receipt.json").read_text(encoding="utf-8"))
    actual_hash = hashlib.sha256(ZIP.read_bytes()).hexdigest()
    if actual_hash != receipt["sha256"]:
        raise ValueError("The raw ZIP no longer matches the download receipt.")
    report = {
        "source": "Kaggle official Olist dataset, version 2",
        "scope": "Stage 1 raw schema and coverage audit; not business analysis",
        "sha256": actual_hash,
        "runtime": {"python": platform.python_version(), "pandas": pd.__version__,
                    "sqlite": sqlite3.sqlite_version},
        "tables": [],
    }
    frames = {}
    with zipfile.ZipFile(ZIP) as archive:
        bad_file = archive.testzip()
        if bad_file:
            raise ValueError(f"ZIP integrity failed: {bad_file}")
        for member in archive.infolist():
            if not member.filename.endswith(".csv"):
                continue
            with archive.open(member) as source:
                frame = pd.read_csv(source, dtype=str)
            frames[member.filename] = frame
            table = {"file": member.filename, "rows": len(frame),
                     "columns": list(frame.columns)}
            if member.filename in DATE_COLUMNS:
                table["dates"] = {}
                for column in DATE_COLUMNS[member.filename]:
                    dates = pd.to_datetime(frame[column], errors="coerce", format="mixed")
                    valid = dates.dropna()
                    table["dates"][column] = {
                        "min": str(valid.min()), "max": str(valid.max()),
                        "missing_raw": int(frame[column].isna().sum()),
                        "invalid_nonmissing": int((frame[column].notna() & dates.isna()).sum()),
                        "non_midnight": int((valid != valid.dt.normalize()).sum()),
                    }
            if member.filename in KEYS:
                keys = KEYS[member.filename]
                table["key_check"] = {
                    "columns": keys, "duplicate_rows_after_first": int(frame.duplicated(keys).sum()),
                    "null_key_rows": int(frame[keys].isna().any(axis=1).sum()),
                }
            if member.filename == "olist_order_reviews_dataset.csv":
                table["order_id_repeated_rows_after_first"] = int(frame.duplicated("order_id").sum())
                table["review_id_repeated_rows_after_first"] = int(frame.duplicated("review_id").sum())
            if member.filename == "olist_geolocation_dataset.csv":
                table["zip_prefix_repeated_rows_after_first"] = int(
                    frame.duplicated("geolocation_zip_code_prefix").sum())
            report["tables"].append(table)

    orders = frames["olist_orders_dataset.csv"]
    items = frames["olist_order_items_dataset.csv"]
    item_counts = items.groupby("order_id").size()
    seller_counts = items.groupby("order_id")["seller_id"].nunique()
    shipping = pd.to_datetime(items["shipping_limit_date"], format="mixed", errors="coerce")
    report["scope_checks"] = {
        "order_rows": len(orders),
        "distinct_orders_with_items": int(items["order_id"].nunique()),
        "orders_without_item_rows": int((~orders["order_id"].isin(items["order_id"])).sum()),
        "single_item_row_orders_before_quality_filters": int((item_counts == 1).sum()),
        "multi_seller_orders_before_quality_filters": int((seller_counts > 1).sum()),
        "shipping_limit_rows_after_2018_12_31": int((shipping >= pd.Timestamp("2019-01-01")).sum()),
        "note": "Eligibility counts precede timestamp/status/quality checks; not replay sample sizes.",
    }
    target = RAW / "schema_coverage_audit.json"
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(target), "runtime": report["runtime"],
                      "tables": [{"file": t["file"], "rows": t["rows"],
                                  "columns": len(t["columns"])} for t in report["tables"]],
                      "scope_checks": report["scope_checks"],
                      "order_dates": next(t["dates"] for t in report["tables"]
                                          if t["file"] == "olist_orders_dataset.csv")},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
