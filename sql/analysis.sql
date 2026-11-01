-- This file runs against data/processed/olist.sqlite. Amounts are integer BRL cents.
-- name: raw_status
SELECT order_status, COUNT(*) AS orders FROM raw_orders
GROUP BY order_status ORDER BY orders DESC;

-- name: monetary_reconciliation
SELECT (SELECT SUM(price_cents) FROM raw_items) AS raw_item_cents,
       (SELECT SUM(item_amount_cents) FROM fact_orders) AS order_item_cents,
       (SELECT SUM(item_amount_cents) FROM fact_order_sellers) AS seller_item_cents,
       (SELECT SUM(freight_cents) FROM raw_items) AS raw_freight_cents,
       (SELECT SUM(freight_amount_cents) FROM fact_orders) AS order_freight_cents,
       (SELECT SUM(payment_cents) FROM raw_payments) AS raw_payment_cents,
       (SELECT SUM(payment_amount_cents) FROM fact_orders) AS order_payment_cents;

-- name: primary_scope
SELECT COUNT(*) AS orders,
       SUM(CASE WHEN order_status='delivered' THEN 1 ELSE 0 END) AS delivered_status_orders,
       SUM(late_valid) AS late_valid_orders,
       SUM(CASE WHEN late_valid=1 THEN is_late ELSE 0 END) AS late_orders,
       SUM(CASE WHEN order_status='delivered' THEN item_amount_cents ELSE 0 END) AS delivered_item_cents,
       SUM(CASE WHEN late_valid=1 AND review_valid=1 THEN 1 ELSE 0 END) AS reviewed_late_valid_orders
FROM fact_orders
WHERE purchase_at >= '2017-01-01' AND purchase_at < '2018-07-01';

-- name: monthly_lateness
SELECT substr(purchase_at,1,7) AS month, COUNT(*) AS orders,
       SUM(late_valid) AS valid_delivered,
       SUM(CASE WHEN late_valid=1 THEN is_late ELSE 0 END) AS late_orders,
       SUM(CASE WHEN order_status='delivered' THEN item_amount_cents ELSE 0 END) AS delivered_item_cents
FROM fact_orders WHERE purchase_at >= '2017-01-01' AND purchase_at < '2018-07-01'
GROUP BY month ORDER BY month;

-- name: state_lateness
SELECT customer_state, SUM(late_valid) AS valid_delivered,
       SUM(CASE WHEN late_valid=1 THEN is_late ELSE 0 END) AS late_orders,
       ROUND(1.0*SUM(CASE WHEN late_valid=1 THEN is_late ELSE 0 END)/NULLIF(SUM(late_valid),0),6) AS late_rate
FROM fact_orders WHERE purchase_at >= '2017-01-01' AND purchase_at < '2018-07-01'
GROUP BY customer_state HAVING SUM(late_valid)>=100
ORDER BY late_rate DESC;

-- name: review_lateness
SELECT is_late, COUNT(*) AS reviewed_orders,
       SUM(CASE WHEN review_score<=2 THEN 1 ELSE 0 END) AS low_score_orders,
       AVG(review_score) AS mean_score
FROM fact_orders WHERE purchase_at >= '2017-01-01' AND purchase_at < '2018-07-01'
AND late_valid=1 AND review_valid=1
GROUP BY is_late;

-- name: review_timing_sensitivity
SELECT CASE WHEN review_answer_at >= delivered_at THEN 'after_delivery' ELSE 'before_delivery' END AS answer_timing,
       is_late, COUNT(*) AS reviewed_orders,
       SUM(CASE WHEN review_score<=2 THEN 1 ELSE 0 END) AS low_score_orders,
       AVG(review_score) AS mean_score
FROM fact_orders WHERE purchase_at >= '2017-01-01' AND purchase_at < '2018-07-01'
AND late_valid=1 AND review_valid=1
GROUP BY answer_timing,is_late ORDER BY answer_timing,is_late;

-- name: single_item_category
SELECT single_category AS category, COUNT(*) AS valid_delivered,
       SUM(is_late) AS late_orders,
       ROUND(1.0*SUM(is_late)/COUNT(*),6) AS late_rate,
       SUM(item_amount_cents) AS item_cents
FROM fact_orders WHERE purchase_at >= '2017-01-01' AND purchase_at < '2018-07-01'
AND late_valid=1 AND item_count=1
GROUP BY single_category HAVING COUNT(*)>=100 ORDER BY late_rate DESC;

-- name: single_seller_performance
SELECT single_seller_id AS seller_id, COUNT(*) AS valid_delivered,
       SUM(is_late) AS late_orders,
       ROUND(1.0*SUM(is_late)/COUNT(*),6) AS late_rate,
       SUM(item_amount_cents) AS item_cents
FROM fact_orders WHERE purchase_at >= '2017-01-01' AND purchase_at < '2018-07-01'
AND late_valid=1 AND seller_count=1
GROUP BY single_seller_id HAVING COUNT(*)>=100 ORDER BY late_orders DESC;

-- name: stage_means
SELECT is_late, COUNT(*) AS sequential_valid_orders,
       AVG(approval_hours) AS mean_approval_hours,
       AVG(handoff_hours) AS mean_handoff_hours,
       AVG(transit_hours) AS mean_transit_hours,
       AVG(total_delivery_hours) AS mean_total_hours
FROM fact_orders WHERE purchase_at >= '2017-01-01' AND purchase_at < '2018-07-01'
AND late_valid=1 AND timeline_valid=1 GROUP BY is_late;

-- name: payment_difference
SELECT COUNT(*) AS comparable_orders,
       SUM(CASE WHEN payment_difference_cents=0 THEN 1 ELSE 0 END) AS exact_matches,
       SUM(CASE WHEN ABS(payment_difference_cents)<=1 THEN 1 ELSE 0 END) AS within_one_cent,
       SUM(payment_difference_cents) AS net_difference_cents
FROM fact_orders WHERE payment_count>0 AND item_count>0;
