"""Read-only reference cases from the original Python implementation.

Called by test_static.mjs, not a replacement for independent raw-data checks.
"""
import json
import sqlite3
import sys
from pathlib import Path

def main():
    source = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(source))
    from demo_server import DemoApp, APIError
    from replay import at_time, alerts_at, rule_matches, load_config
    
    app = DemoApp.__new__(DemoApp)
    app.data_db, app.root = source / "data" / "processed" / "olist.sqlite", source
    app.config = load_config(source / "evaluation_config.json")
    app.actions = lambda: {}
    app.action_for = lambda oid: ({"order_id": oid, "status": "pending", "note": "", "updated_at": None, "simulated": True}, [])
    con = app.connection()
    seller = con.execute("SELECT single_item_seller_id FROM fact_orders WHERE replay_eligible=1 AND customer_state='RJ' ORDER BY order_id LIMIT 1").fetchone()[0]
    category = con.execute("SELECT single_category FROM fact_orders WHERE single_item_seller_id=? AND replay_eligible=1 AND customer_state='RJ' LIMIT 1", (seller,)).fetchone()[0]
    default = {"start": "2017-01-01", "end": "2018-06-30"}
    cases = []
    def add(path, query):
        try:
            cases.append({"path": path, "query": query, "expected": app.get(path, query)})
        except APIError as e:
            cases.append({"path": path, "query": query, "error": e.code})
    
    filters = [{}, default, default | {"state": "RJ"}, default | {"state": "SP"}, {"start":"2018-03-01","end":"2018-03-31"}, {"seller":seller}, {"category":category}, {"seller":seller,"category":category,"state":"RJ"}, {"start":"2019-01-01","end":"2019-12-31"}, {"category":"no_such_category"}, {"start":"2017-12-25","end":"2018-01-05","state":"MG"}]
    for q in filters:
        add("/api/overview", q)
        add("/api/orders", q | {"limit":"17","page":"2"})
    for late in ("late", "on_time", "unknown"):
        add("/api/orders", default | {"late":late})
    for t in ("2016-09-04T21:15:19","2017-05-20T23:59:59","2018-03-15T08:00","2018-08-21T09:01:02","2018-09-30T23:59:59"):
        add("/api/alerts", {"as_of":t,"limit":"40"})
    for rule in ("R1","R2","R3","R4"):
        add("/api/alerts", {"rule":rule,"state":"RJ","as_of":"2018-03-15T08:00"})
    add("/api/alerts", {"action_status":"resolved"})
    add("/api/alerts", {"seller":seller,"category":category,"as_of":"2018-08-15T08:00"})
    for where in ("item_count=0", "item_count>1", "timeline_valid=0", "review_valid=0", "replay_eligible=1", "customer_state='SP' AND is_late=1"):
        row = dict(con.execute("SELECT * FROM fact_orders WHERE " + where + " ORDER BY order_id LIMIT 1").fetchone())
        add("/api/order/"+row["order_id"], {"mode":"history"})
        if row["replay_eligible"]:
            for t in (row["purchase_at"], row["approved_at"], row["carrier_at"], row["delivered_at"], "2018-03-15T08:00"):
                add("/api/order/"+row["order_id"], {"mode":"replay","as_of":t})
    for path,q in [("/api/overview",{"start":"2018-02-30"}),("/api/overview",{"start":"2018-06-02","end":"2018-05-01"}),("/api/overview",{"state":"rj"}),("/api/overview",{"seller":"bad"}),("/api/orders",{"late":"invalid"}),("/api/orders",{"limit":"201"}),("/api/alerts",{"as_of":"2018-10-01T00:00"}),("/api/alerts",{"as_of":"2018-02-30T08:00"}),("/api/alerts",{"rule":"R5"}),("/api/order/"+"0"*32,{}),("/api/orders",{"unsupported":"x"})]:
        add(path,q)
    synthetic = {"order_id":"1"*32,"purchase_at":"2018-01-01 01:00:00","approved_at":"2018-01-01 02:00:00","carrier_at":"2018-01-03 12:00:00","delivered_at":"2018-01-06 08:00:00","shipping_limit_min":"2018-01-03 02:00:00","estimated_at":"2018-01-04 00:00:00","item_count":1,"seller_count":1,"customer_state":"SP","item_amount_cents":1234,"freight_amount_cents":500,"single_item_seller_id":"a"*32,"single_product_id":"b"*32,"single_category":"books"}
    boundaries=[]
    for t in ("2018-01-01 00:59:59","2018-01-01 01:00:00","2018-01-01 01:59:59","2018-01-01 02:00:00","2018-01-02 01:59:59","2018-01-02 02:00:00","2018-01-03 02:00:00","2018-01-03 02:00:01","2018-01-03 12:00:00","2018-01-03 23:59:59","2018-01-04 00:00:00","2018-01-04 23:59:59","2018-01-05 00:00:00","2018-01-06 07:59:59","2018-01-06 08:00:00"):
        for change in ({}, {"carrier_at":None}, {"delivered_at":None}, {"item_count":2}, {"shipping_limit_min":"2017-12-31 00:00:00"}, {"review_score":1,"order_status":"canceled","is_late":1,"late_valid":0,"replay_eligible":0}):
            row=synthetic|change
            view=at_time(row,t)
            boundaries.append({"row":row,"t":t,"view":view,"matches":rule_matches(view,app.config),"alerts":alerts_at(row,t,app.config)})
    # Include real-data equal-event boundaries and arbitrary observation points.
    for record in con.execute("SELECT * FROM fact_orders WHERE replay_eligible=1 ORDER BY order_id LIMIT 100"):
        row=dict(record)
        for t in (row["approved_at"],row["carrier_at"],row["delivered_at"],"2018-03-15 08:00:00"):
            view=at_time(row,t)
            boundaries.append({"row":{k:row[k] for k in synthetic.keys()},"t":t,"view":view,"matches":rule_matches(view,app.config),"alerts":alerts_at(row,t,app.config)})
    con.close()
    print(json.dumps({"cases":cases,"boundaries":boundaries,"config":app.config},ensure_ascii=False,allow_nan=False))
    
if __name__ == "__main__":
    main()
