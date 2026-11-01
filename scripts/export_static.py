"""Export a reviewed, read-only projection of the Olist source for static hosting.

No raw database, customer identifier, review text, or simulated action is copied.
Usage: python scripts/export_static.py --source ../../olist_project
"""
import argparse
import gzip
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

ORDERS = "order_id order_status purchase_at approved_at carrier_at delivered_at estimated_at customer_state customer_city item_count seller_count item_amount_cents freight_amount_cents payment_amount_cents review_valid review_score review_answer_at single_item_seller_id single_product_id single_category promise_end_exclusive shipping_limit_min shipping_limit_max timeline_valid shipping_deadline_valid late_valid is_late replay_eligible purchase_month".split()
ITEMS = "order_id order_item_id product_id seller_id category price_cents freight_cents shipping_limit_at invalid_money_row".split()

def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[3] / "olist_project")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "dist" / "data")
    args = parser.parse_args()
    source, out = args.source.resolve(), args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(source))
    from demo_server import DemoApp
    db = source / "data" / "processed" / "olist.sqlite"
    con = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
    manifest = {"schema_version": 1, "source": "Olist / Kaggle dataset version 2", "license": "CC BY-NC-SA 4.0", "files": {}}
    for table, fields, name in (("fact_orders", ORDERS, "orders.json.gz"), ("raw_items", ITEMS, "items.json.gz")):
        rows = con.execute("SELECT " + ",".join(fields) + " FROM " + table + " ORDER BY order_id" + (",CAST(order_item_id AS INTEGER)" if table == "raw_items" else "")).fetchall()
        # Column arrays compress repeated values without introducing dependencies.
        payload = {"fields": fields, "columns": [list(column) for column in zip(*rows)], "rows": len(rows)}
        raw = canonical(payload)
        compressed = gzip.compress(raw, compresslevel=9, mtime=0)
        (out / name).write_bytes(compressed)
        manifest["files"][name] = {"rows": len(rows), "bytes": len(compressed), "uncompressed_bytes": len(raw), "sha256": hashlib.sha256(compressed).hexdigest(), "fields": fields}
    con.close()
    # These read-only methods do not require an action database. Bypass the
    # constructor so the exporter never creates or touches simulated state.
    from replay import load_config
    app = DemoApp.__new__(DemoApp)
    app.data_db, app.root, app.config = db, source, load_config(source / "evaluation_config.json")
    values = {"meta.json": app.meta(), "default-overview.json": app.overview({"start": "2017-01-01", "end": "2018-06-30"}), "config.json": app.config}
    for name, value in values.items():
        (out / name).write_bytes(canonical(value))
    for name in ("quality_report.json", "replay_results.json"):
        value = json.loads((source / "evidence" / name).read_text(encoding="utf-8-sig"))
        (out / name).write_bytes(canonical(value))
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(out), "orders": manifest["files"]["orders.json.gz"]["rows"], "items": manifest["files"]["items.json.gz"]["rows"], "total_compressed_bytes": sum(v["bytes"] for v in manifest["files"].values())}))

if __name__ == "__main__":
    main()
