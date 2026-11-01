"""Frozen, hourly historical rule replay. No model and no causal improvement claim.

Run after pipeline.py: python replay.py
at_time -> allowed as-of snapshot; alerts_at -> one deduplicated task per order.
Only evaluate() reads final outcomes. Neither trigger interface reads future labels.
"""

import csv
import hashlib
import json
import math
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "evaluation_config.json"
DB = ROOT / "data" / "processed" / "olist.sqlite"
OUT = ROOT / "evidence"
RULE_VERSION = "rules-v1"
RULE_PRIORITY = ("R4", "R2", "R3", "R1")
EVENTS = ("purchase_at", "approved_at", "carrier_at", "delivered_at")
STATIC_AFTER_APPROVAL = ("item_count", "seller_count", "single_item_seller_id",
                         "single_product_id", "single_category", "customer_state",
                         "item_amount_cents", "freight_amount_cents")
RULE_TEXT = {
    "R1": ("交运截止临近", "提示", "核对备货与交接安排；必要时联系履约协作方。"),
    "R2": ("交运截止已过", "紧急", "核查是否已交运但记录未更新，并确认履约障碍。"),
    "R3": ("承诺收货日临近", "关注", "核查最新物流进展；评估是否需要人工跟进。"),
    "R4": ("承诺收货截止已过", "逾期监控", "核查物流与收货记录；登记异常跟进情况。"),
}


def load_config(path=CONFIG_PATH):
    config = json.loads(Path(path).read_text(encoding="utf-8"))
    if config.get("alert_schedule") != "hourly_on_the_hour":
        raise ValueError("This replay implements the frozen hourly schedule only")
    if config.get("version") != RULE_VERSION or not config.get("frozen_before_holdout_evaluation"):
        raise ValueError("Frozen rules-v1 configuration is required")
    return config


def dt(value):
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except (TypeError, ValueError):
        return None


def iso(value):
    return value.isoformat(sep=" ") if isinstance(value, datetime) else value


def ceil_hour(value):
    base = value.replace(minute=0, second=0, microsecond=0)
    return base if value == base else base + timedelta(hours=1)


def hour_strictly_after(value):
    return value.replace(minute=0, second=0, microsecond=0) + timedelta(hours=1)


def at_time(row, t):
    """Whitelist snapshot, independent of final status, scores and eligibility.

    Static attributes/deadlines are assumed known after approval. Raw data has no
    revision or ingestion history. Event equality is visible (event_time <= t).
    Future event keys are absent, not set to their future timestamps or durations.
    """
    t = dt(t)
    if t is None:
        raise ValueError("t must be a valid dataset-local timestamp")
    view = {"as_of": iso(t), "visible": False}
    purchase = dt(row.get("purchase_at"))
    if purchase is None or purchase > t:
        return view
    view.update({"visible": True, "order_id": row.get("order_id"),
                 "purchase_at": iso(purchase), "stage": "purchased"})
    stages = {"approved_at": "approved", "carrier_at": "handed_to_carrier",
              "delivered_at": "delivered"}
    for field in EVENTS[1:]:
        happened = dt(row.get(field))
        if happened is not None and happened <= t:
            view[field] = iso(happened)
            view["stage"] = stages[field]
    if "approved_at" in view:
        for field in STATIC_AFTER_APPROVAL:
            value = row.get(field)
            if value is not None:
                view[field] = value
        deadline = dt(row.get("shipping_limit_min"))
        estimated = dt(row.get("estimated_at"))
        if deadline is not None:
            view["shipping_deadline_at"] = iso(deadline)
        if estimated is not None:
            view["estimated_at"] = iso(estimated)
            view["promise_end_exclusive"] = iso(
                estimated.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1))
    return view


def _known_problem(view):
    """Validation only against fields already visible. No future validity flags."""
    if view.get("item_count") != 1:
        return "首版仅支持单商品行订单"
    approval = dt(view.get("approved_at"))
    purchase = dt(view.get("purchase_at"))
    shipping = dt(view.get("shipping_deadline_at"))
    promise = dt(view.get("promise_end_exclusive"))
    if approval is None:
        return None  # Not approved yet: no rules, not a missing-data claim.
    if shipping is None or promise is None:
        return "批准后缺少可解析截止时间"
    if approval < purchase or shipping < approval or promise <= purchase or shipping >= promise:
        return "已知截止时间或事件顺序异常"
    carrier = dt(view.get("carrier_at"))
    delivered = dt(view.get("delivered_at"))
    if carrier is not None and carrier < approval:
        return "已知交运事件早于批准"
    if delivered is not None and (carrier is None or delivered < carrier):
        return "已知收货事件顺序异常"
    return None


def rule_matches(view, config=None):
    """Return independent rule codes, using ONLY the allowlisted snapshot."""
    config = config or load_config()
    if not view.get("visible") or "approved_at" not in view or _known_problem(view):
        return []
    t = dt(view["as_of"])
    shipping = dt(view["shipping_deadline_at"])
    promise = dt(view["promise_end_exclusive"])
    matches = []
    if "carrier_at" not in view and "delivered_at" not in view:
        remaining = shipping - t
        if timedelta(0) <= remaining <= timedelta(hours=config["shipping_warning_hours"]):
            matches.append("R1")
        if t > shipping:
            matches.append("R2")
    if "delivered_at" not in view:
        if promise - timedelta(hours=config["delivery_warning_hours"]) <= t < promise:
            matches.append("R3")
        if t >= promise:
            matches.append("R4")
    return matches


def alerts_at(row, t, config=None):
    """Return [] or one task. All overlapping codes retained in matched_rules.

    The task's id is stable across hourly runs and severity changes. Priority is
    R4 > R2 > R3 > R1, so an order is never counted as several queue tasks.
    """
    config = config or load_config()
    view = at_time(row, t)
    matched = rule_matches(view, config)
    if not matched:
        return []
    primary = next(code for code in RULE_PRIORITY if code in matched)
    reason, level, suggestion = RULE_TEXT[primary]
    shipping = dt(view["shipping_deadline_at"])
    promise = dt(view["promise_end_exclusive"])
    t = dt(view["as_of"])
    return [{"task_id": f"{config['version']}:{view['order_id']}",
             "order_id": view["order_id"], "as_of": view["as_of"],
             "rule_version": config["version"], "primary_rule": primary,
             "matched_rules": [code for code in RULE_PRIORITY if code in matched],
             "reason": reason, "level": level, "suggestion": suggestion,
             "kind": "overdue_monitoring" if t >= promise else "before_promise_hint",
             "shipping_deadline_at": iso(shipping), "promise_end_exclusive": iso(promise),
             "hours_to_shipping_deadline": (shipping - t).total_seconds() / 3600,
             "hours_to_promise_end": (promise - t).total_seconds() / 3600}]


def first_triggers(row, config):
    """Analytic first scheduled instants, verified through the same rule engine.

    Suitable only for eligible, fully observed orders. This output belongs to
    offline evaluation; it must not be passed to the real-time trigger interface.
    """
    approved = dt(row.get("approved_at"))
    shipping = dt(row.get("shipping_limit_min"))
    estimated = dt(row.get("estimated_at"))
    if approved is None or shipping is None or estimated is None:
        return {}
    promise = estimated.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    candidates = {
        "R1": ceil_hour(max(approved, shipping - timedelta(hours=config["shipping_warning_hours"]))),
        "R2": max(ceil_hour(approved), hour_strictly_after(shipping)),
        "R3": ceil_hour(max(approved, promise - timedelta(hours=config["delivery_warning_hours"]))),
        "R4": ceil_hour(max(approved, promise)),
    }
    result = {}
    for code, t in candidates.items():
        if code in rule_matches(at_time(row, t), config):
            result[code] = t
    return result


def percentile(values, q):
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * q
    lower = int(math.floor(position))
    upper = int(math.ceil(position))
    return values[lower] + (values[upper] - values[lower]) * (position - lower)


def distribution(values):
    return {"n": len(values), "min": min(values) if values else None,
            "p25": percentile(values, .25), "median": percentile(values, .5),
            "p75": percentile(values, .75), "max": max(values) if values else None}


def window_for(row, config):
    purchased = dt(row.get("purchase_at"))
    if purchased is None:
        return None
    for name, begin, end in (
        ("exploration", config["exploration_start"], config["exploration_end_exclusive"]),
        ("validation", config["validation_start"], config["validation_end_exclusive"]),
        ("holdout", config["holdout_start"], config["holdout_end_exclusive"]),
    ):
        if dt(begin) <= purchased < dt(end):
            return name
    return None


def eligible(row, config):
    return (row.get("order_status") == "delivered" and row.get("item_count") == 1
            and row.get("timeline_valid") == 1 and row.get("shipping_deadline_valid") == 1
            and row.get("late_valid") == 1 and dt(row.get("delivered_at")) is not None
            and dt(row["delivered_at"]) < dt(config["outcome_cutoff_exclusive"]))


def _outcome_class(row, cutoff):
    delivered = dt(row.get("delivered_at"))
    if delivered is not None and delivered >= cutoff:
        return "recorded_delivery_at_or_after_C_right_censored_for_replay"
    if row.get("order_status") != "delivered":
        return "final_snapshot_not_delivered_no_complete_delivery_outcome"
    if delivered is None or row.get("late_valid") != 1:
        return "delivered_snapshot_missing_or_invalid_outcome"
    return "reliable_delivery_before_C_lateness_assessable"


def evaluate(rows, config):
    cutoff = dt(config["outcome_cutoff_exclusive"])
    grouped = {name: [] for name in ("exploration", "validation", "holdout")}
    for row in rows:
        window = window_for(row, config)
        if window:
            grouped[window].append(row)
    summary = []
    outcomes = []
    filter_audits = {}
    followup = {}
    outcome_audits = {}
    group_members = []
    for window, source in grouped.items():
        counts = {"all_window_orders": len(source)}
        remaining = source
        filters = [
            ("final_delivered", lambda r: r["order_status"] == "delivered"),
            ("single_item_row", lambda r: r["item_count"] == 1),
            ("timestamps_available", lambda r: r["timestamps_available"] == 1),
            ("timeline_valid", lambda r: r["timeline_valid"] == 1),
            ("shipping_deadline_valid", lambda r: r["shipping_deadline_valid"] == 1),
            ("late_valid", lambda r: r["late_valid"] == 1),
            ("delivered_before_C", lambda r: dt(r["delivered_at"]) < cutoff),
        ]
        previous_count = len(remaining)
        removed = {}
        for key, criterion in filters:
            remaining = [r for r in remaining if criterion(r)]
            counts[key] = len(remaining)
            removed[key] = previous_count - len(remaining)
            previous_count = len(remaining)
        assert all(eligible(r, config) for r in remaining)
        assert {r["order_id"] for r in remaining} == {r["order_id"] for r in source if eligible(r, config)}
        filter_audits[window] = {"survivors": counts, "removed_at_step": removed}
        cutoff_counts = {}
        for row in source:
            key = _outcome_class(row, cutoff)
            cutoff_counts[key] = cutoff_counts.get(key, 0) + 1
        outcome_audits[window] = cutoff_counts
        all_promises = [dt(r["promise_end_exclusive"]) for r in source if dt(r.get("promise_end_exclusive"))]
        promise_followup = [(cutoff - t).total_seconds() / 86400 for t in all_promises]
        followup[window] = {
            "all_parseable_promises_C_minus_promise_days": distribution(promise_followup),
            "promise_at_or_after_C_orders": sum(t >= cutoff for t in all_promises),
            "eligible_C_minus_promise_days": distribution([
                (cutoff - dt(r["promise_end_exclusive"])).total_seconds() / 86400 for r in remaining])}
        local = []
        for row in remaining:
            promise = dt(row["promise_end_exclusive"])
            triggers = first_triggers(row, config)
            advance = {code: t for code, t in triggers.items() if code != "R4" and t < promise}
            first = min(advance.values()) if advance else None
            first_rules = [code for code in RULE_PRIORITY if advance.get(code) == first] if first else []
            shipping_times = [t for code, t in advance.items() if code in ("R1", "R2")]
            result = {
                "window": window, "order_id": row["order_id"],
                "seller_id": row["single_item_seller_id"], "customer_state": row["customer_state"],
                "purchase_at": row["purchase_at"], "approved_at": row["approved_at"],
                "carrier_at": row["carrier_at"], "delivered_at": row["delivered_at"],
                "shipping_deadline_at": row["shipping_limit_min"],
                "promise_end_exclusive": row["promise_end_exclusive"],
                "final_is_late_evaluation_only": int(row["is_late"]),
                "first_R1_at": iso(triggers.get("R1")), "first_R2_at": iso(triggers.get("R2")),
                "first_R3_at": iso(triggers.get("R3")), "first_R4_monitor_at": iso(triggers.get("R4")),
                "first_advance_at": iso(first), "first_advance_rules": "|".join(first_rules),
                "first_shipping_advance_at": iso(min(shipping_times)) if shipping_times else None,
                "advance_hours": (promise - first).total_seconds() / 3600 if first else None,
                "has_advance_hint": int(first is not None),
                "outcome_cutoff_exclusive": config["outcome_cutoff_exclusive"],
                "rule_version": config["version"],
            }
            local.append(result)
            group_members.append(result)
        outcomes.extend(local)
        E = len(local)
        L = sum(r["final_is_late_evaluation_only"] for r in local)
        specs = [("R1", "first_R1_at"), ("R2", "first_R2_at"), ("R3", "first_R3_at"),
                 ("SHIPPING_R1_R2", "first_shipping_advance_at"),
                 ("COMBINED_R1_R2_R3", "first_advance_at"), ("R4_MONITOR_ONLY", "first_R4_monitor_at")]
        for name, key in specs:
            all_triggered = [r for r in local if dt(r[key]) is not None]
            A = [r for r in all_triggered if name != "R4_MONITOR_ONLY"
                 and dt(r[key]) < dt(r["promise_end_exclusive"])]
            hits = [r for r in A if r["final_is_late_evaluation_only"] == 1]
            lead = [(dt(r["promise_end_exclusive"]) - dt(r[key])).total_seconds() / 3600 for r in hits]
            summary.append({
                "window": window, "rule": name, "all_window_orders": len(source), "E": E, "L": L,
                "eligible_share": E / len(source) if source else None,
                "all_triggered_orders": len(all_triggered), "A_before_promise": len(A),
                "A_intersection_L": len(hits), "A_not_L": len(A) - len(hits),
                "hint_hit_share": len(hits) / len(A) if A else None,
                "late_advance_coverage": len(hits) / L if L and name != "R4_MONITOR_ONLY" else None,
                "hints_per_1000_E": 1000 * len(A) / E if E and name != "R4_MONITOR_ONLY" else None,
                "hits_advance_hours_n": len(lead), "hits_advance_hours_p25": percentile(lead, .25),
                "hits_advance_hours_median": percentile(lead, .5), "hits_advance_hours_p75": percentile(lead, .75),
                "hits_advance_hours_min": min(lead) if lead else None,
                "hits_advance_hours_max": max(lead) if lead else None,
                "late_found_by_monitor_only": sum(r["final_is_late_evaluation_only"] for r in all_triggered)
                    if name == "R4_MONITOR_ONLY" else None,
                "interpretation": "post_deadline_monitor_not_advance_success" if name == "R4_MONITOR_ONLY"
                    else "pre_deadline_monitor_definition_not_predictive_model" if name == "R3"
                    else "offline_association_on_selected_delivered_orders",
            })
    # Group counts are descriptive context; small groups are never ranked as risk.
    groups = []
    for window in grouped:
        selected = [r for r in group_members if r["window"] == window]
        for dimension in ("customer_state", "seller_id"):
            values = {}
            for row in selected:
                key = row[dimension] or "unknown"
                stats = values.setdefault(key, {"E": 0, "L": 0, "A": 0, "hits": 0})
                stats["E"] += 1
                stats["L"] += row["final_is_late_evaluation_only"]
                stats["A"] += row["has_advance_hint"]
                stats["hits"] += row["has_advance_hint"] * row["final_is_late_evaluation_only"]
            for key, stats in sorted(values.items()):
                groups.append({"window": window, "dimension": dimension, "group": key, **stats,
                               "below_minimum_group_orders": int(stats["E"] < config["minimum_group_orders"])})
    return {"summaries": summary, "filter_audits": filter_audits, "outcome_audits": outcome_audits,
            "followup": followup, "order_results": outcomes, "group_counts": groups}


def write_csv(path, rows):
    if not rows:
        raise ValueError(f"No output rows for {path}")
    with path.open("w", encoding="utf-8-sig", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


def main():
    config = load_config()
    config_hash = hashlib.sha256(CONFIG_PATH.read_bytes()).hexdigest()
    with sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        rows = [dict(row) for row in conn.execute("SELECT * FROM fact_orders ORDER BY order_id")]
    if len({r["order_id"] for r in rows}) != len(rows):
        raise ValueError("fact_orders must contain exactly one row per order")
    mismatches = [r["order_id"] for r in rows if bool(r["replay_eligible"]) != eligible(r, config)]
    if mismatches:
        raise ValueError(f"fact_orders replay_eligible disagrees with frozen config: {len(mismatches)}")
    result = evaluate(rows, config)
    OUT.mkdir(exist_ok=True)
    write_csv(OUT / "replay_window_rules.csv", result["summaries"])
    write_csv(OUT / "replay_order_first_alerts.csv", result["order_results"])
    write_csv(OUT / "replay_group_counts.csv", result["group_counts"])
    report = {key: value for key, value in result.items() if key not in ("order_results", "group_counts")}
    report.update({"rule_version": config["version"], "config_sha256": config_hash,
                   "config_snapshot": config, "fact_orders_rows": len(rows),
                   "eligible_flag_mismatches": len(mismatches),
                   "generated_at": datetime.now().isoformat(timespec="seconds"),
                   "result_type": "historical_simulation_not_production_or_causal_effect",
                   "priority": list(RULE_PRIORITY),
                   "rule_boundaries": {"R1": "0 <= shipping_deadline-t <= 24h, no visible carrier",
                                       "R2": "shipping_deadline < t, no visible carrier",
                                       "R3": "promise_end-24h <= t < promise_end, no visible delivery",
                                       "R4": "t >= promise_end, no visible delivery; monitor only"},
                   "limitations": [
                       "R3 coverage of late delivery is largely implied by its definition; it is a deadline monitor, not a predictive model.",
                       "Final delivered/single-row/valid-timeline eligibility is retrospective; results do not generalize to undelivered, cancelled, multi-row or abnormal orders.",
                       "Events are assumed visible immediately at event timestamps. Static deadlines and item fields are assumed known after approval; revision and ingestion logs are unavailable.",
                       "A is deduplicated orders hinted before promise end. An on-time hinted order is not proven needless work; no operator judgment is observed.",
                       "C is analyst-defined, and final snapshot statuses do not establish historical cancellation states at C.",
                       "Reported lead time is until promise deadline, not time saved or reduced lateness. No intervention occurred.",
                       "Rules were frozen in supplied configuration before this holdout evaluation; no thresholds were optimized on holdout."]})
    (OUT / "replay_results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    receipt = {"evaluation_config_sha256": config_hash,
               "evaluation_config_file": "evaluation_config.json", "database_file": "data/processed/olist.sqlite",
               "database_sha256_at_run": hashlib.sha256(DB.read_bytes()).hexdigest(),
               "replay_source_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               "output_sha256": {name: hashlib.sha256((OUT / name).read_bytes()).hexdigest() for name in (
                   "replay_results.json", "replay_window_rules.csv", "replay_order_first_alerts.csv", "replay_group_counts.csv")},
               "generated_at": report["generated_at"]}
    (OUT / "replay_receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"config_sha256": config_hash, "rows_evaluated": len(result["order_results"]),
                      "summary_file": str(OUT / "replay_window_rules.csv")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
