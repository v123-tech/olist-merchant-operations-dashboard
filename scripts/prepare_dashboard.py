"""Read-only raw CSV aggregation for 瞄店; never exports order or seller identifiers."""
import argparse
import csv
import hashlib
import io
import json
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from statistics import median
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
WORKSPACE = ROOT.parent.parent
SOURCE_SHA = "967e41e04fc306fe604e2a693f488995a8b41e5047418f8a5c8e4abd6deca784"
SOURCE_BYTES = 44717580
AS_OF = datetime(2018, 3, 15, 8)
HIGH_RISK = 0.15
MIN_ORDERS = 30
GROUPS = {
    "家居百货": "artes artes_e_artesanato artigos_de_festas artigos_de_natal cama_mesa_banho casa_conforto casa_conforto_2 casa_construcao construcao_ferramentas_construcao construcao_ferramentas_ferramentas construcao_ferramentas_iluminacao construcao_ferramentas_jardim construcao_ferramentas_seguranca cool_stuff ferramentas_jardim flores la_cuisine market_place moveis_colchao_e_estofado moveis_cozinha_area_de_servico_jantar_e_jardim moveis_decoracao moveis_escritorio moveis_quarto moveis_sala utilidades_domesticas",
    "美妆个护": "beleza_saude perfumaria",
    "数码家电": "audio cine_foto climatizacao consoles_games eletrodomesticos eletrodomesticos_2 eletronicos eletroportateis informatica_acessorios pc_gamer pcs portateis_casa_forno_e_cafe portateis_cozinha_e_preparadores_de_alimentos tablets_impressao_imagem telefonia telefonia_fixa",
    "运动文娱": "esporte_lazer instrumentos_musicais cds_dvds_musicais dvds_blu_ray musica",
    "服饰鞋包": "fashion_bolsas_e_acessorios fashion_calcados fashion_esporte fashion_roupa_feminina fashion_roupa_infanto_juvenil fashion_roupa_masculina fashion_underwear_e_moda_praia malas_acessorios relogios_presentes",
    "母婴玩具": "bebes brinquedos fraldas_higiene",
    "食品饮料": "alimentos alimentos_bebidas bebidas",
    "宠物用品": "pet_shop",
    "汽车用品": "automotivo",
    "图书文具": "livros_importados livros_interesse_geral livros_tecnicos papelaria",
    "工业商用": "agro_industria_e_comercio industria_comercio_e_negocios sinalizacao_e_seguranca",
    "其他服务": "seguros_e_servicos",
}
CATEGORY = {raw: chinese for chinese, raw_list in GROUPS.items() for raw in raw_list.split()}
CATEGORY[""] = "未分类"


def canonical(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def stamp(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def cents(value):
    try:
        number = Decimal(value) * 100
        if not number.is_finite() or number != number.to_integral_value() or number < 0:
            return None
        return int(number)
    except (InvalidOperation, TypeError, ValueError):
        return None


def ratio(numerator, denominator):
    return round(numerator / denominator, 8) if denominator else None


def chinese_category(raw):
    if raw not in CATEGORY:
        raise ValueError("原始品类没有经过中文映射；请先补齐映射再生成")
    return CATEGORY[raw]


def choose_reviews(rows, purchases):
    """Match the frozen pipeline's valid-record filter and deterministic tie breaks."""
    candidates = {}
    valid_records = 0
    for row_number, row in enumerate(rows):
        purchase = purchases.get(row["order_id"])
        answer, created = stamp(row["review_answer_timestamp"]), stamp(row["review_creation_date"])
        try:
            score = int(row["review_score"])
        except (TypeError, ValueError):
            continue
        if not (score in range(1, 6) and purchase and answer and created
                and answer >= purchase and created.date() >= purchase.date()):
            continue
        valid_records += 1
        # Ascending ID/row number is the last tie breaker, not descending.
        key = (-answer.timestamp(), -created.timestamp(), row["review_id"], row_number)
        if row["order_id"] not in candidates or key < candidates[row["order_id"]][0]:
            candidates[row["order_id"]] = (key, score, answer)
    return {oid: {"score": item[1], "answer": item[2]} for oid, item in candidates.items()}, valid_records


def late_facts(status, purchase, delivered, estimated):
    end = datetime.combine(estimated.date(), datetime.min.time()) + timedelta(days=1) if estimated else None
    eligible = bool(status == "delivered" and purchase and delivered and estimated
                    and delivered >= purchase and end > purchase)
    late = bool(eligible and delivered >= end)
    days = max(0, (delivered.date() - estimated.date()).days) if eligible else None
    return eligible, late, days, end


def risk_tier(eligible, late):
    if eligible < MIN_ORDERS:
        return "样本不足"
    r = late / eligible
    return "高危" if r >= HIGH_RISK else "关注" if r >= 0.08 else "稳健"


def read_csv(archive, suffix):
    matches = [name for name in archive.namelist() if name.endswith(suffix)]
    if len(matches) != 1:
        raise ValueError("原始数据文件不唯一或缺失：" + suffix)
    with archive.open(matches[0]) as stream:
        yield from csv.DictReader(io.TextIOWrapper(stream, encoding="utf-8-sig"))


def diagnosis(role, category, eligible, late, growth):
    late_text = f"{late}/{eligible}笔时间有效订单晚收货，比例{late / eligible:.1%}"
    if role == "高营收高延迟":
        return (f"商品记录金额较高，且{late_text}；优先核对发货承诺与承运交接。", [
            "每日拉齐待交运清单，核对承诺截止、仓库出库与承运揽收记录，逐单确定责任环节。",
            f"对{category}建立异常运单跟进表，指定运营负责人在一个工作日内核实长时间无更新的物流。",
            "以七天为一轮复核时效承诺和库存可售量；只有核验通过后再恢复放量，避免仅以成交规模追加流量。",
        ])
    if role == "高营收高履约":
        return (f"商品记录金额较高，且{late_text}；适合作为同品类履约流程对照，不等同于已验证的标杆。", [
            "抽查批准到交运的处理时间、承运交接证据和订单取消记录，确认低延迟不是样本选择造成。",
            f"整理{category}的备货与揽收节点，将可复核的流程转成同品类商家培训材料。",
            "在小流量范围评估新增订单的承接能力，每周同时检查延迟率、差评与人工排查负担，再决定是否放量。",
        ])
    growth_text = f"后期订单较前期增长{growth:.0%}" if growth is not None else "增长窗口订单量有变化"
    return (f"{growth_text}，同时{late_text}；增长前先验证库存、交运和售后承接能力。", [
        "按周对照订单增长、可售库存和每日出库能力，发现积压时先核实承诺时效再追加营销资源。",
        f"对{category}新增订单做分批承接，运营在每批结束后核对交运及时性及买家反馈。",
        "为增长订单设置明确的异常负责人和响应期限；每周复盘延迟与低评分的分母，避免把增长误当作履约改善。",
    ])


def replay_cell(orders, merchant_ids, merchant_aov, days, aov):
    end = AS_OF + timedelta(days=days)
    alerts = bad = observed = late = 0
    for order in orders.values():
        sellers = order["sellers"]
        if len(sellers) != 1:
            continue
        seller = next(iter(sellers))
        if seller not in merchant_ids or merchant_aov.get(seller, 0) < aov * 100:
            continue
        if not (order["approved"] and order["approved"] <= AS_OF and order["promise"]
                and AS_OF < order["promise"] <= end
                and (not order["delivered"] or order["delivered"] > AS_OF)):
            continue
        alerts += 1
        if order["eligible"]:
            late += int(order["late"])
            review = order["review"]
            if review and review["answer"] > AS_OF:
                observed += 1
                bad += int(review["score"] <= 2)
    return {"days": days, "aov": aov, "alerts": alerts, "knownBadReviews": bad,
            "observableOutcomes": observed, "lateOutcomes": late}


def build_dashboard(source, crosscheck=True):
    source = Path(source).resolve()
    zip_path = source / "data/raw/brazilian-ecommerce-v2.zip"
    raw_bytes = zip_path.read_bytes()
    if len(raw_bytes) != SOURCE_BYTES or hashlib.sha256(raw_bytes).hexdigest() != SOURCE_SHA:
        raise ValueError("原始ZIP与冻结来源不符；拒绝生成")
    with ZipFile(io.BytesIO(raw_bytes)) as archive:
        raw_orders = list(read_csv(archive, "olist_orders_dataset.csv"))
        if len(raw_orders) != 99441 or len({r["order_id"] for r in raw_orders}) != 99441:
            raise ValueError("原始订单数或唯一性不符")
        purchases = {r["order_id"]: stamp(r["order_purchase_timestamp"]) for r in raw_orders}
        reviews, review_records = choose_reviews(read_csv(archive, "olist_order_reviews_dataset.csv"), purchases)
        # Customer identifiers never leave this local lookup or enter output/evidence.
        states = {r["customer_id"]: r["customer_state"] for r in read_csv(archive, "olist_customers_dataset.csv")}
        products = {r["product_id"]: chinese_category(r["product_category_name"])
                    for r in read_csv(archive, "olist_products_dataset.csv")}
        raw_items = list(read_csv(archive, "olist_order_items_dataset.csv"))
    if len(raw_items) != 112650:
        raise ValueError("原始商品行数不符")
    orders = {}
    for row in raw_orders:
        oid = row["order_id"]
        delivered, estimated = stamp(row["order_delivered_customer_date"]), stamp(row["order_estimated_delivery_date"])
        eligible, late, days, promise = late_facts(row["order_status"], purchases[oid], delivered, estimated)
        orders[oid] = {"purchase": purchases[oid], "approved": stamp(row["order_approved_at"]),
                       "delivered": delivered, "promise": promise, "eligible": eligible, "late": late,
                       "days": days, "state": states.get(row["customer_id"]), "review": reviews.get(oid),
                       "sellers": set(), "categories": set(), "gmv": 0}
    merchant_orders = defaultdict(dict)
    merchant_categories = defaultdict(Counter)
    category_orders = defaultdict(set)
    category_gmv = Counter()
    total_gmv = 0
    for row in raw_items:
        oid, sid = row["order_id"], row["seller_id"]
        if oid not in orders:
            raise ValueError("商品行引用不存在的订单")
        price = cents(row["price"])
        if price is None:
            raise ValueError("商品价格不能转换为非负整数分")
        category = products.get(row["product_id"], "未分类")
        order = orders[oid]
        order["sellers"].add(sid)
        order["categories"].add(category)
        order["gmv"] += price
        merchant_orders[sid][oid] = merchant_orders[sid].get(oid, 0) + price
        merchant_categories[sid][category] += price
        category_orders[category].add(oid)
        category_gmv[category] += price
        total_gmv += price
    eligible = sum(o["eligible"] for o in orders.values())
    late = sum(o["late"] for o in orders.values())
    late_reviewed = [o for o in orders.values() if o["late"] and o["review"]]
    low_late = sum(o["review"]["score"] <= 2 for o in late_reviewed)
    merchant_stats = {}
    historical_aov = {}
    for sid, own_orders in merchant_orders.items():
        denom = sum(orders[oid]["eligible"] for oid in own_orders)
        numerator = sum(orders[oid]["late"] for oid in own_orders)
        early = sum(datetime(2018, 5, 1) <= orders[oid]["purchase"] < datetime(2018, 7, 1) for oid in own_orders)
        recent = sum(datetime(2018, 7, 1) <= orders[oid]["purchase"] < datetime(2018, 9, 1) for oid in own_orders)
        before = [amount for oid, amount in own_orders.items() if orders[oid]["purchase"] < AS_OF
                  and orders[oid]["approved"] and orders[oid]["approved"] <= AS_OF]
        historical_aov[sid] = sum(before) / len(before) if before else 0
        merchant_stats[sid] = {"gmv": sum(own_orders.values()), "orders": len(own_orders), "eligible": denom,
                               "late": numerator, "rate": numerator / denom if denom else None,
                               "growth": (recent - early) / early if early >= 20 else None,
                               "early": early, "recent": recent,
                               "category": sorted(merchant_categories[sid], key=lambda k: (-merchant_categories[sid][k], k))[0]}
    high_risk_ids = {sid for sid, m in merchant_stats.items() if m["eligible"] >= MIN_ORDERS and m["rate"] >= HIGH_RISK}
    high_gmv = sum(merchant_stats[sid]["gmv"] for sid in high_risk_ids)
    late_rate = late / eligible
    selected, roles = [], {}
    pools = [
        ("高营收高延迟", sorted(high_risk_ids, key=lambda sid: (-merchant_stats[sid]["gmv"], sid))),
        ("高营收高履约", sorted([sid for sid, m in merchant_stats.items() if m["eligible"] >= MIN_ORDERS and m["rate"] <= late_rate / 2], key=lambda sid: (-merchant_stats[sid]["gmv"], sid))),
        ("高增长", sorted([sid for sid, m in merchant_stats.items() if m["eligible"] >= MIN_ORDERS and m["growth"] is not None and m["growth"] > 0], key=lambda sid: (-merchant_stats[sid]["growth"], -merchant_stats[sid]["gmv"], sid))),
    ]
    for role, pool in pools:
        candidates = [sid for sid in pool if sid not in roles][:10]
        if len(candidates) != 10:
            raise ValueError("代表商家分层样本不足，拒绝凑数")
        for sid in candidates:
            selected.append(sid)
            roles[sid] = role
    merchants = []
    for index, sid in enumerate(selected, 1):
        m, role = merchant_stats[sid], roles[sid]
        nickname = {"高营收高延迟": "高危履约大商", "高营收高履约": "稳健履约大商", "高增长": "成长潜力商家"}[role]
        pain, actions = diagnosis(role, m["category"], m["eligible"], m["late"], m["growth"])
        merchants.append({"id": f"商家{index:02d}", "label": f"{nickname}-{index:02d}（{m['category']}）",
                          "role": role, "tier": risk_tier(m["eligible"], m["late"]), "category": m["category"],
                          "orders": m["orders"], "eligible": m["eligible"], "late": m["late"], "lateRate": ratio(m["late"], m["eligible"]),
                          "gmvCents": m["gmv"], "aovCents": round(m["gmv"] / m["orders"]),
                          "growthRate": round(m["growth"], 8) if m["growth"] is not None else None,
                          "pain": pain, "actions": actions})
    band_definitions = [("按期收货", 0, 0), ("延迟一至二天", 1, 2), ("延迟三至五天", 3, 5),
                        ("延迟六至十天", 6, 10), ("延迟十一至二十天", 11, 20), ("延迟二十天以上", 21, 10000)]
    bands = []
    for label, low, high in band_definitions:
        members = [o for o in orders.values() if o["eligible"] and low <= o["days"] <= high]
        reviewed = [o for o in members if o["review"]]
        bad = sum(o["review"]["score"] <= 2 for o in reviewed)
        bands.append({"label": label, "orders": len(members), "reviewed": len(reviewed), "lowReviews": bad,
                      "lowReviewRate": ratio(bad, len(reviewed))})
    categories = []
    for name, ids in sorted(category_orders.items(), key=lambda item: (-category_gmv[item[0]], item[0])):
        denom = sum(orders[oid]["eligible"] for oid in ids)
        num = sum(orders[oid]["late"] for oid in ids)
        categories.append({"name": name, "orders": len(ids), "eligible": denom, "late": num,
                           "lateRate": ratio(num, denom), "gmvCents": category_gmv[name]})
    cells = [replay_cell(orders, set(selected), historical_aov, day, aov) for day in range(8) for aov in range(0, 501, 50)]
    valid_times = [o["purchase"] for o in orders.values() if o["purchase"]]
    data = {"version": 2, "brand": "瞄店", "scope": {"start": min(valid_times).date().isoformat(), "end": max(valid_times).date().isoformat(),
            "sourceOrders": len(orders), "sourceItems": len(raw_items), "moneyUnit": "雷亚尔"},
            "kpis": {"orders": len(orders), "onTime": eligible - late, "eligible": eligible, "late": late,
                     "otd": ratio(eligible - late, eligible), "lateReviewed": len(late_reviewed), "lateLowReviews": low_late,
                     "lateLowReviewRate": ratio(low_late, len(late_reviewed)), "totalGmvCents": total_gmv,
                     "highRiskGmvCents": high_gmv, "highRiskGmvShare": ratio(high_gmv, total_gmv)},
            "delayBands": bands, "categories": categories, "merchants": merchants,
            "quadrants": {"xGmvCents": int(median(m["gmvCents"] for m in merchants)), "yLateRate": HIGH_RISK},
            "replay": {"days": list(range(8)), "aov": list(range(0, 501, 50)), "cells": cells,
                       "recoveryRate": 0.2, "minutesPerAlert": 5,
                       "method": "固定回放至2018年3月15日8时；在代表商家的单商家订单中，筛选已批准、尚未见收货、承诺截止在未来若干天内的订单。商家客单价只用截面前已批准订单的商品记录金额计算。差评覆盖采用事后可见结果；可挽回量按两成情景系数估算，不是实际收益。"},
            "audit": {"sourceOrders": len(orders), "sourceItems": len(raw_items), "selectedMerchants": 30,
                      "sourceMerchants": len(merchant_stats), "highRiskMerchants": len(high_risk_ids),
                      "minimumMerchantSample": MIN_ORDERS, "highRiskLateRate": HIGH_RISK,
                      "categoryGroups": len(categories), "validReviewedOrders": len(reviews),
                      "merchantRoles": {role: 10 for role, _ in pools}, "historicalAsOf": "2018-03-15 08:00",
                      "note": "商品记录金额含全部最终状态、不含运费，不是净营收。跨商家或跨品类的订单可重复计入各自分组，不能相加当作全站订单数。"}}
    checks = cross_check(source, data, orders, merchant_stats) if crosscheck else {"status": "not-requested"}
    evidence = {"passed": True, "sourceSha256": SOURCE_SHA, "sourceBytes": SOURCE_BYTES,
                "sourceOrders": len(orders), "sourceItems": len(raw_items), "validReviewRecords": review_records,
                "chosenReviewedOrders": len(reviews), "rawCategoryMappings": len(CATEGORY) - 1,
                "sourceMerchants": len(merchant_stats), "highRiskMerchants": len(high_risk_ids),
                "selectedRoles": {role: sum(roles[sid] == role for sid in selected) for role, _ in pools},
                "duplicateSellerSelection": len(selected) - len(set(selected)),
                "categoryGmvAddsToTotal": sum(c["gmvCents"] for c in categories) == total_gmv,
                "merchantGmvAddsToTotal": sum(m["gmv"] for m in merchant_stats.values()) == total_gmv,
                "delayBandOrdersAddToEligible": sum(b["orders"] for b in bands) == eligible,
                "replayCells": len(cells), "replayAlertRange": [min(c["alerts"] for c in cells), max(c["alerts"] for c in cells)],
                "replayBadReviewRange": [min(c["knownBadReviews"] for c in cells), max(c["knownBadReviews"] for c in cells)],
                "crosscheck": checks, "privacy": {"rawOrderIds": False, "rawSellerIds": False, "reviewText": False, "customerIds": False}}
    if not all(evidence[k] for k in ("categoryGmvAddsToTotal", "merchantGmvAddsToTotal", "delayBandOrdersAddToEligible")):
        raise ValueError("聚合分母或金额守恒失败")
    return data, evidence


def cross_check(source, data, orders, merchant_stats):
    db = source / "data/processed/olist.sqlite"
    before_hash = hashlib.sha256(db.read_bytes()).hexdigest()
    with sqlite3.connect(db.as_uri() + "?mode=ro", uri=True) as con:
        global_values = con.execute("SELECT count(*),sum(late_valid),sum(CASE WHEN is_late=1 THEN 1 ELSE 0 END),sum(item_amount_cents) FROM fact_orders").fetchone()
        expected = (data["kpis"]["orders"], data["kpis"]["eligible"], data["kpis"]["late"], data["kpis"]["totalGmvCents"])
        if tuple(global_values) != expected:
            raise ValueError("原始CSV聚合与冻结SQLite全量口径不一致")
        reviewed = con.execute("SELECT count(*),sum(CASE WHEN review_score<=2 THEN 1 ELSE 0 END) FROM fact_orders WHERE late_valid=1 AND is_late=1 AND review_valid=1").fetchone()
        if tuple(reviewed) != (data["kpis"]["lateReviewed"], data["kpis"]["lateLowReviews"]):
            raise ValueError("原始CSV评价筛选与冻结SQLite不一致")
        legacy = {}
        for state, expected_pair in [(None, (83696, 5930)), ("RJ", (10891, 1436)), ("SP", (34523, 1432))]:
            subset = [o for o in orders.values() if o["purchase"] and datetime(2017, 1, 1) <= o["purchase"] < datetime(2018, 7, 1)
                      and (state is None or o["state"] == state)]
            pair = (sum(o["eligible"] for o in subset), sum(o["late"] for o in subset))
            sql = "SELECT sum(late_valid),sum(CASE WHEN is_late=1 THEN 1 ELSE 0 END) FROM fact_orders WHERE purchase_at >= '2017-01-01' AND purchase_at < '2018-07-01'"
            params = []
            if state:
                sql += " AND customer_state=?"
                params.append(state)
            stored = con.execute(sql, params).fetchone()
            if pair != expected_pair or tuple(stored) != pair:
                raise ValueError("历史窗口交叉核验不一致")
            legacy[state or "全部"] = {"eligible": pair[0], "late": pair[1]}
        stored_reviews = dict(con.execute("SELECT order_id,review_score FROM fact_orders WHERE review_valid=1"))
        raw_reviews = {oid: o["review"]["score"] for oid, o in orders.items() if o["review"]}
        if raw_reviews != stored_reviews:
            raise ValueError("逐订单有效评分与SQLite不一致")
        compared_merchants = 0
        seller_sql = """SELECT i.seller_id,COUNT(DISTINCT i.order_id),SUM(i.price_cents),
            COUNT(DISTINCT CASE WHEN f.late_valid=1 THEN i.order_id END),
            COUNT(DISTINCT CASE WHEN f.is_late=1 THEN i.order_id END)
            FROM raw_items i JOIN fact_orders f ON f.order_id=i.order_id GROUP BY i.seller_id"""
        for sid, count, gmv, eligible_count, late_count in con.execute(seller_sql):
            m = merchant_stats[sid]
            if (count, gmv, eligible_count, late_count) != (m["orders"], m["gmv"], m["eligible"], m["late"]):
                raise ValueError("逐商家去重订单、金额或履约分母与SQLite不一致")
            compared_merchants += 1
        if compared_merchants != len(merchant_stats):
            raise ValueError("交叉核验商家覆盖不完整")
    after_hash = hashlib.sha256(db.read_bytes()).hexdigest()
    if before_hash != after_hash:
        raise ValueError("交叉核验期间冻结数据库发生变化")
    return {"passed": True, "fullCountsAndGmv": list(expected), "lateReviewCounts": list(reviewed),
            "legacyWindow": legacy, "chosenReviewScoresCompared": len(raw_reviews),
            "merchantOrderGmvAndDenominatorsCompared": compared_merchants,
            "databaseOpenedReadOnly": True, "databaseWritten": False,
            "databaseSha256Before": before_hash, "databaseSha256After": after_hash,
            "databaseUnchanged": True}


def main():
    parser = argparse.ArgumentParser(description="只读原始ZIP，生成小于80000字节的中文聚合数据")
    parser.add_argument("--source", type=Path, default=WORKSPACE / "olist_project")
    parser.add_argument("--output", type=Path, default=ROOT / "src/dashboardData.json")
    parser.add_argument("--evidence", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check and args.evidence:
        parser.error("--check不能写核验回执")
    source, output = args.source.resolve(), args.output.resolve()
    if output == source or source in output.parents:
        parser.error("聚合输出不能写入原始项目目录")
    if args.evidence and (args.evidence.resolve() == source or source in args.evidence.resolve().parents):
        parser.error("核验回执不能写入原始项目目录")
    data, evidence = build_dashboard(source)
    body = canonical(data)
    if len(body) >= 80000:
        raise ValueError("聚合数据达到80000字节，拒绝输出或发布")
    evidence.update({"dashboardBytes": len(body), "dashboardSha256": hashlib.sha256(body).hexdigest()})
    if args.check:
        if output.read_bytes() != body:
            raise ValueError("现有聚合数据不等于原始ZIP只读重算结果")
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(body)
        if args.evidence:
            args.evidence.parent.mkdir(parents=True, exist_ok=True)
            args.evidence.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": True, "check": args.check, "bytes": len(body), "limit": 80000,
                      "merchants": len(data["merchants"]), "kpis": data["kpis"], "replayCells": len(data["replay"]["cells"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
