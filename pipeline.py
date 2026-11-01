"""Reproducible Olist order-grain preparation and descriptive business analysis."""

import hashlib
import json
import re
import sqlite3
import zipfile
from decimal import Decimal, InvalidOperation
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "processed"
EVIDENCE = ROOT / "evidence"
DB = OUT / "olist.sqlite"
FILES = {
    "orders": "olist_orders_dataset.csv", "items": "olist_order_items_dataset.csv",
    "payments": "olist_order_payments_dataset.csv", "reviews": "olist_order_reviews_dataset.csv",
    "customers": "olist_customers_dataset.csv", "products": "olist_products_dataset.csv",
    "sellers": "olist_sellers_dataset.csv", "categories": "product_category_name_translation.csv",
}


def cents(value):
    if pd.isna(value):
        return None
    try:
        amount = Decimal(str(value)) * 100
        if not amount.is_finite() or amount != amount.to_integral_value():
            return None
        return int(amount)
    except (InvalidOperation, ValueError):
        return None


def stamp(series):
    return pd.to_datetime(series, format="mixed", errors="coerce")


def native(value):
    if hasattr(value, "item"):
        return value.item()
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, Path):
        return str(value)
    raise TypeError(type(value).__name__)


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=native,
                               allow_nan=False), encoding="utf-8")


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    source = RAW / "brazilian-ecommerce-v2.zip"
    receipt = json.loads((RAW / "download_receipt.json").read_text(encoding="utf-8"))
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    if source_hash != receipt["sha256"]:
        raise ValueError("Raw ZIP hash differs from verified source receipt")
    config = json.loads((ROOT / "evaluation_config.json").read_text(encoding="utf-8"))
    with zipfile.ZipFile(source) as archive:
        tables = {name: pd.read_csv(archive.open(file), dtype=str)
                  for name, file in FILES.items()}
    quality = {"source_sha256": source_hash, "source_version": 2,
               "raw_rows": {name: len(df) for name, df in tables.items()},
               "null_cells": {name: {c: int(df[c].isna().sum()) for c in df.columns}
                              for name, df in tables.items()}, "key_checks": {},
               "foreign_key_checks": {}, "monetary_checks": {}}
    keys = {"orders": ["order_id"], "customers": ["customer_id"],
            "products": ["product_id"], "sellers": ["seller_id"],
            "items": ["order_id", "order_item_id"],
            "payments": ["order_id", "payment_sequential"],
            "categories": ["product_category_name"]}
    for name, key in keys.items():
        df = tables[name]
        check = {"columns": key, "duplicate_rows": int(df.duplicated(key).sum()),
                 "null_key_rows": int(df[key].isna().any(axis=1).sum())}
        quality["key_checks"][name] = check
        if check["duplicate_rows"] or check["null_key_rows"]:
            raise ValueError(f"Unexpected key violation in {name}; inspect before rebuilding")
    relations = [("orders", "customer_id", "customers", "customer_id"),
                 ("items", "order_id", "orders", "order_id"),
                 ("payments", "order_id", "orders", "order_id"),
                 ("reviews", "order_id", "orders", "order_id"),
                 ("items", "product_id", "products", "product_id"),
                 ("items", "seller_id", "sellers", "seller_id"),
                 ("products", "product_category_name", "categories", "product_category_name")]
    for child, fk, parent, pk in relations:
        values = tables[child][fk]
        quality["foreign_key_checks"][f"{child}.{fk}->{parent}.{pk}"] = {
            "null_rows": int(values.isna().sum()),
            "non_null_unmatched_rows": int((values.notna() & ~values.isin(tables[parent][pk])).sum())}

    items = tables["items"].copy()
    payments = tables["payments"].copy()
    for df, column, new_column in [(items, "price", "price_cents"),
                                    (items, "freight_value", "freight_cents"),
                                    (payments, "payment_value", "payment_cents")]:
        df[new_column] = pd.array(df[column].map(cents), dtype="Int64")
        quality["monetary_checks"][column] = {
            "invalid_or_missing_rows": int(df[new_column].isna().sum()),
            "negative_rows": int((df[new_column] < 0).fillna(False).sum()),
            "zero_rows": int((df[new_column] == 0).fillna(False).sum())}
    items = items.merge(tables["products"][["product_id", "product_category_name"]],
                        on="product_id", how="left", validate="many_to_one")
    items = items.merge(tables["categories"], on="product_category_name", how="left",
                        validate="many_to_one")
    items["category"] = items["product_category_name_english"].fillna(
        items["product_category_name"]).fillna("unknown")
    items["shipping_limit_at"] = stamp(items["shipping_limit_date"])
    items["invalid_money_row"] = (~(items["price_cents"].notna() & items["freight_cents"].notna()
                                     & (items["price_cents"] >= 0)
                                     & (items["freight_cents"] >= 0))).astype(int)
    item_order = items.groupby("order_id", as_index=False).agg(
        item_count=("order_item_id", "size"), seller_count=("seller_id", "nunique"),
        product_count=("product_id", "nunique"),
        item_amount_cents=("price_cents", lambda x: x.sum(min_count=1)),
        freight_amount_cents=("freight_cents", lambda x: x.sum(min_count=1)),
        invalid_money_rows=("invalid_money_row", "sum"),
        shipping_limit_min=("shipping_limit_at", "min"),
        shipping_limit_max=("shipping_limit_at", "max"))
    seller_order = items.groupby(["order_id", "seller_id"], as_index=False).agg(
        seller_item_count=("order_item_id", "size"),
        item_amount_cents=("price_cents", lambda x: x.sum(min_count=1)),
        freight_amount_cents=("freight_cents", lambda x: x.sum(min_count=1)))
    payments["invalid_money_row"] = (~(payments["payment_cents"].notna()
                                       & (payments["payment_cents"] >= 0))).astype(int)
    payment_order = payments.groupby("order_id", as_index=False).agg(
        payment_count=("payment_sequential", "size"),
        payment_amount_cents=("payment_cents", lambda x: x.sum(min_count=1)),
        invalid_payment_rows=("invalid_money_row", "sum"))

    reviews = tables["reviews"].copy()
    reviews["raw_row_number"] = range(len(reviews))
    reviews["review_created_at"] = stamp(reviews["review_creation_date"])
    reviews["review_answer_at"] = stamp(reviews["review_answer_timestamp"])
    reviews["review_score_numeric"] = pd.to_numeric(reviews["review_score"], errors="coerce")
    review_purchase = reviews["order_id"].map(tables["orders"].set_index("order_id")["order_purchase_timestamp"])
    review_purchase = stamp(review_purchase)
    reviews["valid_answer_record"] = (reviews["review_score_numeric"].isin([1, 2, 3, 4, 5])
        & reviews["review_answer_at"].notna()
        & (reviews["review_answer_at"] >= review_purchase)
        & (reviews["review_created_at"].dt.normalize() >= review_purchase.dt.normalize()))
    quality["review_checks"] = {
        "exact_duplicate_rows": int(tables["reviews"].duplicated().sum()),
        "order_id_repeated_rows_after_first": int(reviews.duplicated("order_id").sum()),
        "review_id_repeated_rows_after_first": int(reviews.duplicated("review_id").sum()),
        "invalid_score_rows": int((~reviews["review_score_numeric"].isin([1, 2, 3, 4, 5])).sum()),
        "invalid_answer_record_rows": int((~reviews["valid_answer_record"]).sum()),
        "answer_before_purchase_rows": int((reviews["review_answer_at"] < review_purchase).sum()),
        "creation_date_before_purchase_date_rows": int((reviews["review_created_at"].dt.normalize()
                                                         < review_purchase.dt.normalize()).sum()),
        "selection": "Latest valid survey answer per order (score 1-5, answer>=purchase, creation date>=purchase date); then latest creation, lexical review_id, raw row number. Descriptive final-state choice only."}
    review_counts = reviews.groupby("order_id").size().rename("review_record_count").reset_index()
    chosen = reviews.loc[reviews["valid_answer_record"]].sort_values(["order_id", "review_answer_at", "review_created_at",
                                  "review_id", "raw_row_number"],
                                 ascending=[True, False, False, True, True],
                                 na_position="last").drop_duplicates("order_id")
    review_order = chosen[["order_id", "review_id", "review_score_numeric", "review_answer_at",
                           "review_created_at"]].rename(columns={"review_score_numeric": "review_score"})
    review_order = review_counts.merge(review_order, on="order_id", how="left", validate="one_to_one")

    facts = tables["orders"].copy()
    aliases = {"order_purchase_timestamp": "purchase_at", "order_approved_at": "approved_at",
               "order_delivered_carrier_date": "carrier_at",
               "order_delivered_customer_date": "delivered_at",
               "order_estimated_delivery_date": "estimated_at"}
    for raw_column, column in aliases.items():
        facts[column] = stamp(facts[raw_column])
    facts = facts.merge(tables["customers"], on="customer_id", how="left", validate="many_to_one")
    for other in [item_order, payment_order, review_order]:
        facts = facts.merge(other, on="order_id", how="left", validate="one_to_one")
    for column in ["item_count", "seller_count", "product_count", "payment_count",
                   "review_record_count", "invalid_money_rows", "invalid_payment_rows"]:
        facts[column] = facts[column].fillna(0).astype(int)
    single_items = items.groupby("order_id").filter(lambda x: len(x) == 1)
    facts = facts.merge(single_items[["order_id", "seller_id", "product_id", "category"]].rename(
        columns={"seller_id": "single_item_seller_id", "product_id": "single_product_id",
                 "category": "single_category"}), on="order_id", how="left", validate="one_to_one")
    single_sellers = items.groupby("order_id")["seller_id"].agg(
        lambda x: x.iloc[0] if x.nunique() == 1 else None).rename("single_seller_id").reset_index()
    facts = facts.merge(single_sellers, on="order_id", how="left", validate="one_to_one")
    facts["promise_end_exclusive"] = facts["estimated_at"].dt.normalize() + pd.Timedelta(days=1)
    facts["amount_valid"] = ((facts["item_count"] > 0) & (facts["invalid_money_rows"] == 0)
                              & facts["item_amount_cents"].notna()).astype(int)
    facts["payment_valid"] = ((facts["payment_count"] > 0) & (facts["invalid_payment_rows"] == 0)
                               & facts["payment_amount_cents"].notna()).astype(int)
    facts["payment_difference_cents"] = (facts["payment_amount_cents"]
                                        - facts["item_amount_cents"] - facts["freight_amount_cents"])
    time_columns = ["purchase_at", "approved_at", "carrier_at", "delivered_at", "estimated_at"]
    facts["timestamps_available"] = facts[time_columns].notna().all(axis=1).astype(int)
    sequence = ((facts["purchase_at"] <= facts["approved_at"])
                & (facts["approved_at"] <= facts["carrier_at"])
                & (facts["carrier_at"] <= facts["delivered_at"]))
    facts["timeline_valid"] = ((facts["timestamps_available"] == 1) & sequence).astype(int)
    facts["late_valid"] = ((facts["order_status"] == "delivered")
                            & facts["delivered_at"].notna() & facts["estimated_at"].notna()
                            & facts["purchase_at"].notna()
                            & (facts["delivered_at"] >= facts["purchase_at"])
                            & (facts["promise_end_exclusive"] > facts["purchase_at"])).astype(int)
    facts["is_late"] = pd.array((facts["delivered_at"] >= facts["promise_end_exclusive"]).astype(int)
                                 .where(facts["late_valid"] == 1), dtype="Int64")
    facts["late_days"] = ((facts["delivered_at"].dt.normalize() - facts["estimated_at"].dt.normalize())
                           .dt.total_seconds() / 86400).clip(lower=0).where(facts["late_valid"] == 1)
    facts["review_valid"] = (facts["review_score"].isin([1, 2, 3, 4, 5])
                              & facts["review_answer_at"].notna()
                              & (facts["review_answer_at"] >= facts["purchase_at"])).astype(int)
    for name, start, end in [("approval_hours", "purchase_at", "approved_at"),
                              ("handoff_hours", "approved_at", "carrier_at"),
                              ("transit_hours", "carrier_at", "delivered_at"),
                              ("total_delivery_hours", "purchase_at", "delivered_at")]:
        duration = (facts[end] - facts[start]).dt.total_seconds() / 3600
        facts[name] = duration.where(duration >= 0)
    facts["shipping_deadline_valid"] = (facts["shipping_limit_min"].notna()
        & (facts["shipping_limit_min"] >= facts["approved_at"])
        & (facts["shipping_limit_max"] < facts["promise_end_exclusive"])).astype(int)
    cutoff = pd.Timestamp(config["outcome_cutoff_exclusive"])
    facts["replay_eligible"] = ((facts["order_status"] == "delivered")
        & (facts["item_count"] == 1) & (facts["timeline_valid"] == 1)
        & (facts["shipping_deadline_valid"] == 1) & (facts["late_valid"] == 1)
        & (facts["delivered_at"] < cutoff)).astype(int)
    facts["purchase_month"] = facts["purchase_at"].dt.strftime("%Y-%m")
    flags = pd.DataFrame({"order_id": facts["order_id"]})
    flags["no_item_records"] = facts["item_count"] == 0
    flags["no_payment_records"] = facts["payment_count"] == 0
    flags["multiple_sellers"] = facts["seller_count"] > 1
    flags["approval_before_purchase"] = facts["approved_at"] < facts["purchase_at"]
    flags["carrier_before_approval"] = facts["carrier_at"] < facts["approved_at"]
    flags["delivery_before_carrier"] = facts["delivered_at"] < facts["carrier_at"]
    flags["delivery_before_purchase"] = facts["delivered_at"] < facts["purchase_at"]
    flags["shipping_before_approval"] = facts["shipping_limit_min"] < facts["approved_at"]
    flags["shipping_after_promise"] = facts["shipping_limit_max"] >= facts["promise_end_exclusive"]
    flags["shipping_after_2018"] = facts["shipping_limit_max"] >= pd.Timestamp("2019-01-01")
    flags["delivered_status_missing_delivery_event"] = ((facts["order_status"] == "delivered")
                                                          & facts["delivered_at"].isna())
    flags["review_answer_before_purchase"] = facts["order_id"].isin(
        reviews.loc[reviews["review_answer_at"] < review_purchase, "order_id"])
    flags["invalid_review_record"] = facts["order_id"].isin(
        reviews.loc[~reviews["valid_answer_record"], "order_id"])
    quality["order_flags"] = {column: int(flags[column].sum()) for column in flags if column != "order_id"}
    quality["missing_timestamps_by_status"] = {
        status: {column: int(group[column].isna().sum()) for column in time_columns}
        for status, group in facts.groupby("order_status")}
    flags.loc[flags.drop(columns="order_id").any(axis=1)].to_csv(
        EVIDENCE / "order_quality_flags.csv", index=False, encoding="utf-8-sig")
    quality["processing_policy"] = "Raw files unchanged; all 99,441 orders retained. Quality flags affect metric-specific eligibility only."
    quality["fact_rows"] = {"orders": len(facts), "order_sellers": len(seller_order)}
    assert len(facts) == len(tables["orders"]) and facts["order_id"].is_unique
    # Only fields that have an explicit grain are copied into the seller fact table.
    seller_meta = facts[["order_id", "purchase_at", "order_status", "seller_count",
                         "customer_state", "customer_city"]]
    seller_order = seller_order.merge(seller_meta, on="order_id", validate="many_to_one")
    build_db = OUT / "olist.build.sqlite"
    with sqlite3.connect(build_db) as connection:
        for name, df in tables.items():
            to_store = items if name == "items" else payments if name == "payments" else df
            to_store.to_sql(f"raw_{name}", connection, if_exists="replace", index=False)
        facts.to_sql("fact_orders", connection, if_exists="replace", index=False)
        seller_order.to_sql("fact_order_sellers", connection, if_exists="replace", index=False)
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_orders_id ON fact_orders(order_id)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_fact_purchase ON fact_orders(purchase_at)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_item_order ON raw_items(order_id)")
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_fact_seller_order ON fact_order_sellers(order_id,seller_id)")
        sql = (ROOT / "sql" / "analysis.sql").read_text(encoding="utf-8")
        blocks = re.split(r"-- name: ([a-z_]+)\n", sql)
        query_results = {}
        for i in range(1, len(blocks), 2):
            name, query = blocks[i], blocks[i + 1].strip()
            result = pd.read_sql_query(query, connection)
            result.to_csv(EVIDENCE / f"{name}.csv", index=False, encoding="utf-8-sig")
            query_results[name] = json.loads(result.to_json(orient="records", force_ascii=False))
    connection.close()
    build_db.replace(DB)
    facts.to_csv(OUT / "fact_orders.csv", index=False, encoding="utf-8-sig")
    seller_order.to_csv(OUT / "fact_order_sellers.csv", index=False, encoding="utf-8-sig")
    recon = query_results["monetary_reconciliation"][0]
    assert recon["raw_item_cents"] == recon["order_item_cents"] == recon["seller_item_cents"]
    assert recon["raw_freight_cents"] == recon["order_freight_cents"]
    assert recon["raw_payment_cents"] == recon["order_payment_cents"]
    assert int(items["price_cents"].sum()) == recon["raw_item_cents"]
    assert int(payments["payment_cents"].sum()) == recon["raw_payment_cents"]
    quality["aggregate_reconciliation_passed"] = True
    primary = facts.loc[(facts["purchase_at"] >= pd.Timestamp(config["exploration_start"]))
                        & (facts["purchase_at"] < pd.Timestamp(config["exploration_end_exclusive"]))]
    stage_quantiles = []
    for is_late, group in primary.loc[(primary["late_valid"] == 1)
                                      & (primary["timeline_valid"] == 1)].groupby("is_late"):
        row = {"is_late": int(is_late), "orders": len(group)}
        for column in ["approval_hours", "handoff_hours", "transit_hours", "total_delivery_hours"]:
            row[column + "_p50"] = float(group[column].median())
            row[column + "_p90"] = float(group[column].quantile(.9))
        stage_quantiles.append(row)
    pd.DataFrame(stage_quantiles).to_csv(EVIDENCE / "stage_quantiles.csv", index=False, encoding="utf-8-sig")
    waterfall = []
    eligible = pd.Series(True, index=facts.index)
    for label, criterion in [
        ("all_orders", pd.Series(True, index=facts.index)),
        ("final_delivered", facts["order_status"] == "delivered"),
        ("one_item_row", facts["item_count"] == 1),
        ("all_timestamps_available", facts["timestamps_available"] == 1),
        ("sequential_events", facts["timeline_valid"] == 1),
        ("shipping_and_promise_consistent", facts["shipping_deadline_valid"] == 1),
        ("valid_lateness_outcome", facts["late_valid"] == 1),
        ("observed_before_analyst_C", facts["delivered_at"] < cutoff),
    ]:
        before = int(eligible.sum())
        eligible &= criterion
        waterfall.append({"step": label, "retained": int(eligible.sum()), "excluded_at_step": before-int(eligible.sum())})
    metrics = {"source_sha256": source_hash, "analysis_window": {"start": config["exploration_start"],
                "end_exclusive": config["exploration_end_exclusive"]},
               "query_results": query_results, "stage_quantiles": stage_quantiles,
               "replay_waterfall_all_dates": waterfall,
               "notes": ["Descriptive historical analysis; no deployed product or causal impact.",
                         "Reviews are selected at final observation and must not be replay trigger features.",
                         "Seller/category descriptive outcomes have order-level event limitations."]}
    save_json(EVIDENCE / "quality_report.json", quality)
    save_json(EVIDENCE / "analysis_results.json", metrics)
    print(json.dumps({"database": str(DB), "fact_order_rows": len(facts),
                      "quality_flags": quality["order_flags"], "monetary_reconciliation": recon,
                      "primary_scope": query_results["primary_scope"],
                      "review_lateness": query_results["review_lateness"],
                      "stage_quantiles": stage_quantiles,
                      "replay_waterfall": waterfall}, ensure_ascii=False, default=native, indent=2))


if __name__ == "__main__":
    main()
