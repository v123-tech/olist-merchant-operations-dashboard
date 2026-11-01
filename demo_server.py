"""Local, dependency-free Olist demo API. Historical records are never modified.

Run: python demo_server.py --port 8765
The listener is deliberately restricted to 127.0.0.1. Demo dispositions are kept
in a separate SQLite file; they are simulated workflow records, not raw events.
"""

import argparse
import json
import math
import re
import sqlite3
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from replay import alerts_at, at_time, load_config

ROOT = Path(__file__).resolve().parent
DEFAULT_DB = ROOT / "data" / "processed" / "olist.sqlite"
DEFAULT_ACTIONS = ROOT / "data" / "demo_actions.sqlite"
ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
ACTION_STATUSES = {"pending", "processing", "resolved", "ignored"}
STATIC_FILES = {"/": ("index.html", "text/html; charset=utf-8"),
                "/index.html": ("index.html", "text/html; charset=utf-8"),
                "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                "/style.css": ("style.css", "text/css; charset=utf-8")}
NOTES = [
    "历史订单为Olist匿名公开记录；金额单位为巴西雷亚尔BRL，不是净收入或利润。",
    "商品记录金额按匹配商品行汇总，订单按order_id去重；无商品订单不计金额。",
    "商家/品类筛选后的收货、评分是相关订单整体结果，只能描述关联，不能归责。",
    "评分为订单最新有效答复；低分定义1—2分。收货达到或超过承诺日结束边界（次日00:00）才记晚到。",
]
REPLAY_NOTES = [
    "此队列是历史回放，限定最终成功妥投、单商品行、有效时间且观测边界前收货的样本，存在选择偏差。",
    "回放仅使用观察时点已发生的事件；截止时间与商品属性假设批准后已知且不变。",
    "数据无事件上报延迟及修改历史，样本内提示效果不能等同生产准确率或真实业务提升。",
    "处置记录仅为本地模拟，当前本地处置状态不会随回放时间回滚，也不改变真实订单事件。",
]


class APIError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def ratio(numerator, denominator):
    return numerator / denominator if denominator else None


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except FileNotFoundError:
        raise APIError(503, "evidence_not_ready", "验证文件尚未生成，请先完成数据处理及回放。")


def validate_id(value):
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise APIError(400, "invalid_order_id", "订单ID必须为32位小写十六进制字符。")
    return value


def parse_date(value, field):
    try:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            raise ValueError()
        return date.fromisoformat(value)
    except (ValueError, TypeError):
        raise APIError(400, "invalid_date", f"{field}需要有效日期YYYY-MM-DD。")


def parse_as_of(value):
    try:
        # The dataset provides naive local timestamps, without a timezone.
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?", value):
            raise ValueError()
        result = datetime.fromisoformat(value)
        if result.tzinfo is not None or result.year < 2016 or result.year > 2018:
            raise ValueError()
        return result
    except (ValueError, TypeError):
        raise APIError(400, "invalid_as_of", "观察时点需要2016—2018年数据本地时间，如2018-08-15T08:00。")


def pagination(query):
    def integer(name, default, maximum):
        value = query.get(name, str(default))
        if not re.fullmatch(r"[0-9]+", value) or not 1 <= int(value) <= maximum:
            raise APIError(400, "invalid_pagination", f"{name}超出有效范围。")
        return int(value)
    return integer("page", 1, 1000000), integer("limit", 25, 200)


class DemoApp:
    def __init__(self, data_db=DEFAULT_DB, actions_db=DEFAULT_ACTIONS, root=ROOT):
        self.data_db, self.actions_db, self.root = Path(data_db), Path(actions_db), Path(root)
        if not self.data_db.is_file():
            raise RuntimeError("缺少数据文件，请先运行pipeline.py。")
        self.config = load_config(self.root / "evaluation_config.json")
        self.actions_db.parent.mkdir(parents=True, exist_ok=True)
        with closing(sqlite3.connect(self.actions_db, timeout=10)) as con:
            con.executescript("""
                CREATE TABLE IF NOT EXISTS actions (
                    order_id TEXT PRIMARY KEY, status TEXT NOT NULL, note TEXT NOT NULL,
                    updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS action_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL,
                    status TEXT NOT NULL, note TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE INDEX IF NOT EXISTS idx_action_history_order ON action_history(order_id,id);
            """)
            con.commit()

    def connection(self):
        con = sqlite3.connect(self.data_db.resolve().as_uri() + "?mode=ro", uri=True, timeout=10)
        con.row_factory = sqlite3.Row
        return con

    @staticmethod
    def check_query(query, allowed):
        extra = set(query) - set(allowed)
        if extra:
            raise APIError(400, "unknown_parameter", "存在未支持参数：" + ",".join(sorted(extra)))

    def scope(self, query):
        """One row per matched order; money is aggregated BEFORE any fact join."""
        filters = {key: query.get(key, "") for key in ("start", "end", "seller", "category", "state")}
        start = parse_date(filters["start"], "start") if filters["start"] else None
        end = parse_date(filters["end"], "end") if filters["end"] else None
        if start and end and start > end:
            raise APIError(400, "invalid_date_range", "开始日期不能晚于结束日期。")
        item_conditions, item_params = [], []
        if filters["seller"]:
            validate_id(filters["seller"])
            item_conditions.append("i.seller_id = ?")
            item_params.append(filters["seller"])
        if filters["category"]:
            if len(filters["category"]) > 120:
                raise APIError(400, "invalid_category", "品类名称过长。")
            item_conditions.append("i.category = ?")
            item_params.append(filters["category"])
        item_where = " AND ".join(item_conditions) or "1=1"
        conditions, params = [], item_params[:]
        if start:
            conditions.append("f.purchase_at >= ?")
            params.append(start.isoformat() + " 00:00:00")
        if end:
            if end == date.max:
                raise APIError(400, "invalid_date", "结束日期超出可计算范围。")
            conditions.append("f.purchase_at < ?")
            params.append((end + timedelta(days=1)).isoformat() + " 00:00:00")
        if filters["state"]:
            if not re.fullmatch(r"[A-Z]{2}", filters["state"]):
                raise APIError(400, "invalid_state", "州代码需要2位大写字母。")
            conditions.append("f.customer_state = ?")
            params.append(filters["state"])
        if item_conditions:
            conditions.append("s.order_id IS NOT NULL")
        fact_where = " AND ".join(conditions) or "1=1"
        sql = f"""WITH scoped_items AS (
            SELECT i.order_id, COUNT(*) AS matched_item_rows,
                   SUM(CASE WHEN i.invalid_money_row=0 THEN i.price_cents END) AS matched_item_amount_cents,
                   SUM(CASE WHEN i.invalid_money_row=0 THEN i.freight_cents END) AS matched_freight_amount_cents,
                   SUM(i.invalid_money_row) AS matched_invalid_money_rows
            FROM raw_items i WHERE {item_where} GROUP BY i.order_id
        ), scoped AS (
            SELECT f.*, COALESCE(s.matched_item_rows,0) AS matched_item_rows,
                   s.matched_item_amount_cents, s.matched_freight_amount_cents,
                   COALESCE(s.matched_invalid_money_rows,0) AS matched_invalid_money_rows
            FROM fact_orders f LEFT JOIN scoped_items s ON f.order_id=s.order_id
            WHERE {fact_where}
        ) """
        return sql, params, filters

    def meta(self):
        receipt = read_json(self.root / "data" / "raw" / "download_receipt.json")
        with closing(self.connection()) as con:
            bounds = con.execute("SELECT date(MIN(purchase_at)),date(MAX(purchase_at)) FROM fact_orders").fetchone()
            sellers = [dict(r) for r in con.execute("SELECT seller_id AS id,seller_city AS city,seller_state AS state FROM raw_sellers ORDER BY seller_state,seller_city,seller_id")]
            categories = [{"id": r[0], "label": r[0]} for r in con.execute("SELECT DISTINCT category FROM raw_items ORDER BY category")]
            states = [{"id": r[0], "label": r[0]} for r in con.execute("SELECT DISTINCT customer_state FROM fact_orders ORDER BY customer_state")]
            eligible_count = con.execute("SELECT COUNT(*) FROM fact_orders WHERE replay_eligible=1").fetchone()[0]
        return {"source": {"dataset_url": "https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce",
                           "version": receipt["dataset_version"], "sha256": receipt["sha256"],
                           "license": "CC BY-NC-SA 4.0", "currency": "BRL"},
                "disclaimer": NOTES + REPLAY_NOTES,
                "dates": {"start": bounds[0], "end": bounds[1], "default_analysis_start": "2017-01-01",
                          "default_analysis_end": "2018-06-30", "default_as_of": "2018-03-15T08:00"},
                "sellers": sellers, "categories": categories, "states": states,
                "replay": {"rule_version": self.config["version"], "eligible_orders": eligible_count,
                           "scope": REPLAY_NOTES[0], "observation_cutoff": self.config["outcome_cutoff_exclusive"],
                           "default_as_of": "2018-03-15T08:00"}}

    def overview(self, query):
        self.check_query(query, {"start", "end", "seller", "category", "state"})
        scope, params, filters = self.scope(query)
        aggregate = """SELECT COUNT(*) AS total_orders,
            SUM(CASE WHEN order_status='delivered' THEN 1 ELSE 0 END) AS delivered_orders,
            SUM(CASE WHEN item_count=0 THEN 1 ELSE 0 END) AS no_item_orders,
            SUM(CASE WHEN matched_item_rows>0 THEN 1 ELSE 0 END) AS matching_item_orders,
            SUM(matched_item_rows) AS matched_item_rows,
            SUM(CASE WHEN matched_item_rows>0 AND matched_invalid_money_rows=0 THEN 1 ELSE 0 END) AS amount_valid_orders,
            SUM(CASE WHEN order_status='delivered' AND matched_item_rows>0 AND matched_invalid_money_rows=0 THEN 1 ELSE 0 END) AS delivered_amount_valid_orders,
            SUM(matched_item_amount_cents) AS item_amount_cents,
            SUM(matched_freight_amount_cents) AS freight_amount_cents,
            SUM(CASE WHEN order_status='delivered' THEN matched_item_amount_cents ELSE 0 END) AS delivered_item_amount_cents,
            SUM(late_valid) AS late_valid_orders,
            SUM(CASE WHEN late_valid=1 AND is_late=1 THEN 1 ELSE 0 END) AS late_orders,
            SUM(review_valid) AS review_valid_orders,
            SUM(CASE WHEN review_valid=1 AND review_score<=2 THEN 1 ELSE 0 END) AS low_score_orders
            FROM scoped"""
        with closing(self.connection()) as con:
            row = dict(con.execute(scope + aggregate, params).fetchone())
            monthly = [dict(r) for r in con.execute(scope + """SELECT purchase_month AS month,COUNT(*) AS orders,
                COALESCE(SUM(matched_item_amount_cents),0)/100.0 AS item_amount_brl,
                COALESCE(SUM(late_valid),0) AS late_valid_orders,
                SUM(CASE WHEN late_valid=1 AND is_late=1 THEN 1 ELSE 0 END) AS late_orders
                FROM scoped GROUP BY purchase_month ORDER BY purchase_month""", params)]
            states = [dict(r) for r in con.execute(scope + """SELECT customer_state AS state,COUNT(*) AS orders,
                COALESCE(SUM(late_valid),0) AS late_valid_orders,
                SUM(CASE WHEN late_valid=1 AND is_late=1 THEN 1 ELSE 0 END) AS late_orders
                FROM scoped GROUP BY customer_state ORDER BY orders DESC,customer_state""", params)]
        row = {k: v if v is not None else 0 for k, v in row.items()}
        for group in monthly + states:
            group["late_rate"] = ratio(group["late_orders"], group["late_valid_orders"])
        cards = {key: row[key] for key in ("total_orders", "delivered_orders", "item_amount_cents",
                 "freight_amount_cents", "delivered_item_amount_cents", "delivered_amount_valid_orders",
                 "late_valid_orders", "late_orders", "review_valid_orders", "low_score_orders")}
        cards.update(item_amount_brl=row["item_amount_cents"] / 100,
                     delivered_item_amount_brl=row["delivered_item_amount_cents"] / 100,
                     delivered_avg_item_amount_brl=ratio(row["delivered_item_amount_cents"] / 100, row["delivered_amount_valid_orders"]),
                     freight_amount_brl=row["freight_amount_cents"] / 100,
                     avg_item_amount_brl=ratio(row["item_amount_cents"] / 100, row["amount_valid_orders"]),
                     late_rate=ratio(row["late_orders"], row["late_valid_orders"]),
                     low_score_rate=ratio(row["low_score_orders"], row["review_valid_orders"]))
        coverage = {key: row[key] for key in ("no_item_orders", "matching_item_orders", "matched_item_rows",
                    "amount_valid_orders", "late_valid_orders", "review_valid_orders")}
        coverage.update(amount_coverage=ratio(row["amount_valid_orders"], row["total_orders"]),
                        late_coverage=ratio(row["late_valid_orders"], row["total_orders"]),
                        review_coverage=ratio(row["review_valid_orders"], row["total_orders"]))
        return {"filters": filters, "cards": cards, "coverage": coverage, "monthly": monthly,
                "states": states, "notes": NOTES}

    def orders(self, query):
        self.check_query(query, {"start", "end", "seller", "category", "state", "page", "limit", "late"})
        scope, params, filters = self.scope(query)
        page, limit = pagination(query)
        late = query.get("late", "all")
        conditions = {"all": "1=1", "late": "late_valid=1 AND is_late=1",
                      "on_time": "late_valid=1 AND is_late=0", "unknown": "late_valid=0"}
        if late not in conditions:
            raise APIError(400, "invalid_late", "晚到筛选可选all/late/on_time/unknown。")
        fields = "order_id,purchase_at,order_status,customer_state,item_count,seller_count,item_amount_cents,freight_amount_cents,matched_item_amount_cents,matched_freight_amount_cents,matched_item_rows,late_valid,is_late,review_valid,CASE WHEN review_valid=1 THEN review_score END AS review_score,estimated_at,delivered_at"
        with closing(self.connection()) as con:
            total = con.execute(scope + "SELECT COUNT(*) FROM scoped WHERE " + conditions[late], params).fetchone()[0]
            rows = [dict(r) for r in con.execute(scope + "SELECT " + fields + " FROM scoped WHERE " + conditions[late]
                 + " ORDER BY purchase_at DESC,order_id LIMIT ? OFFSET ?", params + [limit, (page - 1) * limit])]
        return {"filters": filters, "total": total, "page": page, "limit": limit,
                "pages": math.ceil(total / limit), "orders": rows, "notes": NOTES}

    def actions(self):
        with closing(sqlite3.connect(self.actions_db, timeout=10)) as con:
            con.row_factory = sqlite3.Row
            return {r["order_id"]: dict(r) | {"simulated": True} for r in con.execute("SELECT * FROM actions")}

    def action_for(self, order_id):
        with closing(sqlite3.connect(self.actions_db, timeout=10)) as con:
            con.row_factory = sqlite3.Row
            row = con.execute("SELECT * FROM actions WHERE order_id=?", (order_id,)).fetchone()
            history = [dict(r) | {"simulated": True} for r in con.execute(
                "SELECT * FROM action_history WHERE order_id=? ORDER BY id DESC", (order_id,))]
        default = {"order_id": order_id, "status": "pending", "note": "", "updated_at": None, "simulated": True}
        return dict(row) | {"simulated": True} if row else default, history

    def post_action(self, body):
        if not isinstance(body, dict) or set(body) - {"order_id", "status", "note"}:
            raise APIError(400, "invalid_body", "仅支持order_id、status、note字段。")
        order_id = validate_id(body.get("order_id"))
        status, note = body.get("status"), body.get("note", "")
        if not isinstance(status, str) or status not in ACTION_STATUSES:
            raise APIError(400, "invalid_status", "处置状态不合法。")
        if not isinstance(note, str) or len(note) > 2000:
            raise APIError(400, "invalid_note", "备注应为文本且不超过2000字符。")
        note = note.strip()
        if status == "ignored" and not note:
            raise APIError(400, "reason_required", "忽略任务时必须填写原因。")
        with closing(self.connection()) as con:
            if not con.execute("SELECT 1 FROM fact_orders WHERE order_id=?", (order_id,)).fetchone():
                raise APIError(404, "order_not_found", "订单不存在。")
        now = datetime.now(timezone.utc).isoformat(timespec="microseconds")
        with closing(sqlite3.connect(self.actions_db, timeout=10)) as con:
            # Serialize simultaneous retries before comparing state.
            con.execute("BEGIN IMMEDIATE")
            previous = con.execute("SELECT status,note FROM actions WHERE order_id=?", (order_id,)).fetchone()
            changed = previous != (status, note)
            if changed:
                con.execute("INSERT INTO actions(order_id,status,note,updated_at) VALUES(?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET status=excluded.status,note=excluded.note,updated_at=excluded.updated_at", (order_id, status, note, now))
                con.execute("INSERT INTO action_history(order_id,status,note,updated_at) VALUES(?,?,?,?)", (order_id, status, note, now))
            history_count = con.execute("SELECT COUNT(*) FROM action_history WHERE order_id=?", (order_id,)).fetchone()[0]
            con.commit()
        action, _ = self.action_for(order_id)
        return {"action": action, "changed": changed, "history_count": history_count, "simulated": True,
                "note": "仅保存本地演示处置，不改变历史履约事件，也不发送真实消息。"}

    def order(self, order_id, query):
        validate_id(order_id)
        self.check_query(query, {"mode", "as_of"})
        mode = query.get("mode", "replay" if query.get("as_of") else "history")
        if mode not in ("history", "replay") or (mode == "history" and query.get("as_of")):
            raise APIError(400, "invalid_mode", "历史详情不接受as_of；回放详情需要观察时点。")
        t = parse_as_of(query["as_of"]) if "as_of" in query else None
        if t is not None and t >= datetime.fromisoformat(self.config["outcome_cutoff_exclusive"]):
            raise APIError(400, "as_of_outside_boundary", "观察时点必须早于配置中的回放观测边界。")
        if mode == "replay" and t is None:
            raise APIError(400, "as_of_required", "回放详情必须提供as_of。")
        with closing(self.connection()) as con:
            row = con.execute("SELECT * FROM fact_orders WHERE order_id=?", (order_id,)).fetchone()
            if row is None:
                raise APIError(404, "order_not_found", "订单不存在。")
            record = dict(row)
            if mode == "replay" and record["replay_eligible"] != 1:
                raise APIError(422, "outside_replay_scope", "该订单不属于首版回放样本，请使用历史详情。")
            view = at_time(record, t) if mode == "replay" else {
                key: record[key] for key in ("order_id", "order_status", "purchase_at", "approved_at", "carrier_at",
                "delivered_at", "estimated_at", "promise_end_exclusive", "customer_state", "customer_city",
                "item_count", "seller_count", "item_amount_cents", "freight_amount_cents", "payment_amount_cents",
                "late_valid", "is_late", "review_valid", "review_score", "review_answer_at", "timeline_valid",
                "shipping_deadline_valid", "shipping_limit_min", "shipping_limit_max")}
            if mode == "replay" and not view["visible"]:
                raise APIError(404, "order_not_visible", "观察时点尚未发生该订单。")
            if mode == "history" and not view["review_valid"]:
                view["review_score"] = None
            items = []
            if mode == "history" or "approved_at" in view:
                items = [dict(r) for r in con.execute("SELECT order_item_id,product_id,seller_id,category,price_cents,freight_cents,shipping_limit_at FROM raw_items WHERE order_id=? ORDER BY CAST(order_item_id AS INTEGER)", (order_id,))]
        timeline = [{"key": key, "label": label, "at": view[key]} for key, label in (
            ("purchase_at", "下单"), ("approved_at", "支付批准"), ("carrier_at", "交承运商"), ("delivered_at", "实际收货"))
            if view.get(key)]
        action, history = self.action_for(order_id)
        result = {"mode": mode, "order": view, "items": items, "timeline": timeline,
                  "action": action, "action_history": history, "notes": REPLAY_NOTES if mode == "replay" else NOTES,
                  "simulated_actions": True}
        if mode == "replay":
            result["as_of"] = t.isoformat(sep=" ")
            result["alerts"] = alerts_at(record, t, self.config)
            result["replay_scope"] = REPLAY_NOTES[0]
        return result

    def alerts(self, query):
        self.check_query(query, {"start", "end", "seller", "category", "state", "as_of", "page", "limit", "rule", "action_status"})
        t = parse_as_of(query.get("as_of", "2018-03-15T08:00"))
        if t >= datetime.fromisoformat(self.config["outcome_cutoff_exclusive"]):
            raise APIError(400, "as_of_outside_boundary", "观察时点必须早于配置中的回放观测边界。")
        page, limit = pagination(query)
        scope, params, filters = self.scope(query)
        rule, action_status = query.get("rule", "all"), query.get("action_status", "all")
        if rule not in {"all", "R1", "R2", "R3", "R4"}:
            raise APIError(400, "invalid_rule", "规则筛选可选all/R1/R2/R3/R4。")
        if action_status not in ACTION_STATUSES | {"all"}:
            raise APIError(400, "invalid_status", "处置筛选状态不合法。")
        with closing(self.connection()) as con:
            # Already received orders cannot generate an active task; the event
            # timestamp condition is an as-of visibility check, not an outcome label.
            rows = [dict(r) for r in con.execute(scope + "SELECT * FROM scoped WHERE replay_eligible=1 AND purchase_at<=? AND (delivered_at>? OR delivered_at IS NULL)", params + [t.isoformat(sep=" "), t.isoformat(sep=" ")])]
        actions = self.actions()
        counts = {key: 0 for key in ("R1", "R2", "R3", "R4", "before_promise_hint", "overdue_monitoring", "pending", "processing", "resolved", "ignored")}
        tasks = []
        for row in rows:
            view = at_time(row, t)
            for task in alerts_at(row, t, self.config):
                action = actions.get(row["order_id"], {"order_id": row["order_id"], "status": "pending", "note": "", "updated_at": None, "simulated": True})
                counts[task["primary_rule"]] += 1
                counts[task["kind"]] += 1
                counts[action["status"]] += 1
                if rule != "all" and rule not in task["matched_rules"]:
                    continue
                if action_status != "all" and action["status"] != action_status:
                    continue
                tasks.append(task | {"order": view, "action": action})
        priority = {"R4": 0, "R2": 1, "R3": 2, "R1": 3}
        tasks.sort(key=lambda a: (priority[a["primary_rule"]], a["promise_end_exclusive"], a["order_id"]))
        offset, total = (page - 1) * limit, len(tasks)
        return {"mode": "replay", "as_of": t.isoformat(sep=" "), "filters": filters,
                "replay_scope": REPLAY_NOTES[0], "total": total, "page": page, "limit": limit,
                "pages": math.ceil(total / limit), "alerts": tasks[offset:offset + limit], "counts": counts,
                "counts_scope": "筛选商家/品类/州/下单日期后的全部当前任务，规则和处置状态筛选前计数。",
                "notes": REPLAY_NOTES}

    def get(self, path, query):
        if path == "/api/meta":
            self.check_query(query, set())
            return self.meta()
        if path == "/api/overview":
            return self.overview(query)
        if path == "/api/orders":
            return self.orders(query)
        if path.startswith("/api/order/"):
            return self.order(path.removeprefix("/api/order/"), query)
        if path == "/api/alerts":
            return self.alerts(query)
        if path in ("/api/quality", "/api/replay_report"):
            self.check_query(query, set())
            name = "quality_report.json" if path.endswith("quality") else "replay_results.json"
            return read_json(self.root / "evidence" / name)
        raise APIError(404, "not_found", "接口不存在。")


def create_server(app, port=8765):
    class Handler(BaseHTTPRequestHandler):
        server_version = "OlistLocalDemo/1"

        def log_message(self, format, *args):
            # Avoid logging action notes or query strings into terminal history.
            pass

        def respond(self, status, payload, content_type="application/json; charset=utf-8"):
            data = payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(data)

        def route(self):
            split = urlsplit(self.path)
            path = unquote(split.path)
            raw = parse_qs(split.query, keep_blank_values=True, max_num_fields=30)
            if any(len(values) != 1 for values in raw.values()):
                raise APIError(400, "duplicate_parameter", "同一参数不能重复提交。")
            return path, {key: values[0] for key, values in raw.items()}

        def failure(self, error):
            self.respond(error.status, {"error": {"code": error.code, "message": error.message}})

        def do_GET(self):
            try:
                path, query = self.route()
                if path in STATIC_FILES:
                    filename, content_type = STATIC_FILES[path]
                    target = app.root / "demo" / filename
                    if not target.is_file():
                        raise APIError(503, "frontend_not_ready", "演示界面尚未生成。")
                    self.respond(200, target.read_bytes(), content_type)
                else:
                    self.respond(200, app.get(path, query))
            except APIError as error:
                self.failure(error)
            except (ValueError, OverflowError):
                self.failure(APIError(400, "invalid_request", "请求参数无法解析。"))
            except (OSError, sqlite3.Error):
                self.failure(APIError(503, "data_unavailable", "数据文件暂不可读取，请确认处理流程已完成。"))

        def do_POST(self):
            try:
                path, query = self.route()
                if path != "/api/action":
                    raise APIError(404, "not_found", "接口不存在。")
                if query:
                    raise APIError(400, "invalid_request", "处置接口不接受地址参数。")
                origin = self.headers.get("Origin")
                allowed_origin = f"http://127.0.0.1:{self.server.server_port}"
                if origin and origin != allowed_origin:
                    raise APIError(403, "invalid_origin", "仅支持演示页面同源处置。")
                if self.headers.get("Content-Type", "").split(";")[0] != "application/json":
                    raise APIError(415, "json_required", "请使用application/json提交。")
                raw_length = self.headers.get("Content-Length", "")
                if not re.fullmatch(r"[0-9]+", raw_length) or not 1 <= int(raw_length) <= 16384:
                    raise APIError(400, "invalid_body_size", "提交内容为空或超出大小限制。")
                body = json.loads(self.rfile.read(int(raw_length)).decode("utf-8"))
                self.respond(200, app.post_action(body))
            except APIError as error:
                self.failure(error)
            except (ValueError, UnicodeDecodeError):
                self.failure(APIError(400, "invalid_json", "提交内容不是有效JSON。"))
            except (OSError, sqlite3.Error):
                self.failure(APIError(503, "data_unavailable", "本地记录暂不可保存，请稍后重试。"))

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser(description="本地Olist商家经营与履约Demo")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--data-db", type=Path, default=DEFAULT_DB)
    parser.add_argument("--actions-db", type=Path, default=DEFAULT_ACTIONS)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口需要在1—65535之间。")
    app = DemoApp(args.data_db, args.actions_db)
    with create_server(app, args.port) as server:
        print(f"本地演示：http://127.0.0.1:{server.server_port}（仅历史分析与模拟处置）", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
