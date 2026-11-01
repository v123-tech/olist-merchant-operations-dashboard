"""Generate an editable evidence-grounded analysis report from the executed outputs."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def pct(numerator, denominator):
    return f"{100 * numerator / denominator:.2f}%" if denominator else "不适用"


def main():
    results = json.loads((ROOT / "evidence/analysis_results.json").read_text(encoding="utf-8"))
    quality = json.loads((ROOT / "evidence/quality_report.json").read_text(encoding="utf-8"))
    verification = json.loads((ROOT / "evidence/stage2_verification.json").read_text(encoding="utf-8"))
    if not verification["passed"]:
        raise ValueError("Cannot publish analysis before independent calculation checks pass")
    query = results["query_results"]
    scope = query["primary_scope"][0]
    month = next(row for row in query["monthly_lateness"] if row["month"] == "2018-03")
    states = {row["customer_state"]: row for row in query["state_lateness"]}
    rj, sp = states["RJ"], states["SP"]
    reviews = {row["is_late"]: row for row in query["review_lateness"]}
    after = {row["is_late"]: row for row in query["review_timing_sensitivity"]
             if row["answer_timing"] == "after_delivery"}
    before = {row["is_late"]: row for row in query["review_timing_sensitivity"]
              if row["answer_timing"] == "before_delivery"}
    stages = {row["is_late"]: row for row in results["stage_quantiles"]}
    payment = query["payment_difference"][0]
    n_diff = payment["comparable_orders"] - payment["exact_matches"]
    report = f"""# 第二阶段：真实历史分析、业务问题与产品决策

这是Olist公开匿名历史数据上的独立产品实践。分析已执行；没有企业任职、真实产品上线、用户反馈或业务提升记录。

## 分析范围与证据

- 业务发现窗口：2017-01-01至2018-06-30下单，共{scope['orders']:,}单；2018-07用于规则验证，2018-08留出评价。
- 原始ZIP共99,441单，保留全部订单。数据版本2，SHA-256 `{results['source_sha256']}`。
- 本报告是按数据集已记录的最终事件进行历史描述；模拟回放另受固定人工截止C和字段可见规则限制。
- 有效晚收货样本：最终delivered、收货/预计/下单时间有效且局部合理。分子{scope['late_orders']:,}，分母{scope['late_valid_orders']:,}，晚收货率 **{pct(scope['late_orders'],scope['late_valid_orders'])}**。
- 有效晚收货样本占窗口全部订单{pct(scope['late_valid_orders'],scope['orders'])}，占最终delivered订单{pct(scope['late_valid_orders'],scope['delivered_status_orders'])}；不把取消、未收货或缺事件订单判为按时。
- 窗口已妥投商品记录金额BRL {scope['delivered_item_cents']/100:,.2f}，不含运费，是GMV代理而非净收入。

执行结果可追溯至[evidence/analysis_results.json](evidence/analysis_results.json)、[sql/analysis.sql](sql/analysis.sql)和各查询对应CSV。原始重算检查见[evidence/stage2_verification.json](evidence/stage2_verification.json)。

## 发现一：时间与地区差异使单个平均值不足以支持运营

2018-03下单订单晚收货为 **{month['late_orders']:,}/{month['valid_delivered']:,}={pct(month['late_orders'],month['valid_delivered'])}**。窗口总体比例掩盖了这个月份的较高异常比例。这里按下单月份分组，不能把它写成“3月实际签收发生的延误”。证据：[monthly_lateness.csv](evidence/monthly_lateness.csv)。

| 收货州 | 有效妥投订单 | 晚收货订单 | 晚收货率 |
|---|---:|---:|---:|
| RJ | {rj['valid_delivered']:,} | {rj['late_orders']:,} | {pct(rj['late_orders'],rj['valid_delivered'])} |
| SP | {sp['valid_delivered']:,} | {sp['late_orders']:,} | {pct(sp['late_orders'],sp['valid_delivered'])} |

RJ比例较高，SP比例较低但异常数量与RJ接近。若只按比例排序，可能忽视大体量地区；若只按数量排序，又可能忽视较高风险地区。不能从这一对比推断地区、商家或物流的独立因果责任。证据：[state_lateness.csv](evidence/state_lateness.csv)。

**产品决策**：经营概览必须同时展示异常数量、比例、分母与日期筛选；支持按收货州下钻。商家风险用于优先检查，不能作为处罚排名；需要结合订单地区、品类和时期分层。

## 发现二：需要完整时间线，运输中订单也值得监控

为比较阶段耗时，下表额外要求完整有序事件；按时组{stages[0]['orders']:,}单，晚收货组{stages[1]['orders']:,}单。该分母比晚收货指标更严格，不能混用。

| 阶段中位数 | 按时组（天） | 晚收货组（天） |
|---|---:|---:|
| 批准至交承运商 | {stages[0]['handoff_hours_p50']/24:.2f} | {stages[1]['handoff_hours_p50']/24:.2f} |
| 交承运商至客户收货 | {stages[0]['transit_hours_p50']/24:.2f} | {stages[1]['transit_hours_p50']/24:.2f} |
| 下单至客户收货 | {stages[0]['total_delivery_hours_p50']/24:.2f} | {stages[1]['total_delivery_hours_p50']/24:.2f} |

晚收货分组本身与实际履约耗时有关，因此这个对比不是独立的“延误原因证明”。它说明仅做“未交运”队列会遗漏运输中需要检查的订单；没有逐包裹事件，不能认定具体承运商责任。证据：[stage_quantiles.csv](evidence/stage_quantiles.csv)、[stage_means.csv](evidence/stage_means.csv)。

**产品决策**：订单详情展示下单、批准、交承运商、收货及承诺时间；工作台区分交运截止异常与收货承诺异常，分别提供检查建议。

## 发现三：评价时点会显著改变结论

评价口径为最新有效回答，低分定义为1—2分，按订单计算。

| 评价范围 | 按时组低分/评价订单 | 晚收货组低分/评价订单 |
|---|---|---|
| 全部有效最新回答 | {reviews[0]['low_score_orders']:,}/{reviews[0]['reviewed_orders']:,}，{pct(reviews[0]['low_score_orders'],reviews[0]['reviewed_orders'])} | {reviews[1]['low_score_orders']:,}/{reviews[1]['reviewed_orders']:,}，{pct(reviews[1]['low_score_orders'],reviews[1]['reviewed_orders'])} |
| 仅客户收货后回答 | {after[0]['low_score_orders']:,}/{after[0]['reviewed_orders']:,}，{pct(after[0]['low_score_orders'],after[0]['reviewed_orders'])} | {after[1]['low_score_orders']:,}/{after[1]['reviewed_orders']:,}，{pct(after[1]['low_score_orders'],after[1]['reviewed_orders'])} |

晚收货有评价组中 **{before[1]['reviewed_orders']:,}单的回答发生在客户收货前**。全口径中的强关联可能包含未收到货时的体验反馈；不能称为“收货后满意度下降”。限定收货后回答也改变了样本构成，仍然不能证明延误导致低分，或预警能改善评分。证据：[review_timing_sensitivity.csv](evidence/review_timing_sensitivity.csv)。

**产品决策**：评分作为辅助历史诊断，不用于首版预警触发；展示评价覆盖和回答时点，不把它拆为多商家独立评分。低分改善不列为本项目已实现成果。

## 数据质量与处理取舍

| 事实 | 处理与影响 |
|---|---|
| 775订单无商品行 | 保留订单；金额未知；显示金额覆盖，而非内连接删除 |
| 1,359订单交运早于批准，23订单收货早于交运 | 受影响阶段耗时无效；其他可信局部指标仍可使用 |
| 547订单多条评价，202订单存在评分冲突（独立原始核查） | 保留原始记录，明示最新有效回答选择规则 |
| 789个review_id共享同一客户/评分/回答时间（独立原始核查） | 不全局按review_id删除；不把订单评分记录称独立反馈人数 |
| {payment['comparable_orders']:,}可比订单中{n_diff:,}存在非零付款差额 | 总净差BRL {payment['net_difference_cents']/100:,.2f}；保留原金额并输出诊断，不能编造手续费或退款解释 |
| 2020交运截止涉及4条商品行、3订单 | 保留订单/金额，隔离截止规则；不能当正常长期履约 |
| 产品品类缺失610行，13行无英文映射 | 缺失显示unknown；无映射回退原始标签，不丢弃记录 |

详见[quality_report.json](evidence/quality_report.json)、[order_quality_flags.csv](evidence/order_quality_flags.csv)及[独立质量核查说明](work/quality/独立质量核查说明.md)。订单标记数和商品行标记数需区分，例如2020截止为4行但3单。

## 验证结果与限制

本次{len(verification['checks'])}项核心计算检查通过：源ZIP哈希、全部订单一单一行、原始整数分金额与订单聚合一致、商家金额与订单聚合一致、回放合格范围、原始日期比较与晚收货标签一致、同日收货不算晚到。

独立重算确认业务发现窗口83,696个有效订单及5,930个晚收货订单。不同阶段耗时/评价报告若采用不同有效样本，必须解释分母再比较结果，不能只对照四舍五入数字。

数据没有访谈、用户行为、成本、状态修改日志、事件入库延迟和真实干预。当前只能提出有数据支持的产品方案；经营利润、商业ROI、上线使用效果及降延迟收益均没有证据。

## 给第三阶段的需求输入

| 需求 | 优先级 | 证据或假设 |
|---|---|---|
| 日期/地区筛选、数量+比例+分母、订单下钻 | P0 | 时间/地区差异及大体量异常 |
| 交运前与运输中异常队列、触发原因、订单时间线 | P0 | 观察到的阶段差异；处置方式需用户验证 |
| 本地模拟处置状态和备注 | P0 | 闭环工作流假设，无真实使用效果 |
| 时间回放、未来事件遮蔽、规则验证和样本说明 | P0 | 当前历史数据限制，需要验证机制可信性 |
| 商家/品类风险排序 | P1 | 描述分层可做；订单结构差异与归责风险需控制 |
| AI摘要/复杂模型/实时物流/库存营销 | P2 | 非首版必要；当前没有充分验证证据 |

第一版产品主张：帮助运营看到值得检查的经营及履约异常，并清楚记录处理；不是承诺消除延误。后续需真实用户任务观察和经授权的影子试点检验这一主张。
"""
    target = ROOT / "第二阶段_数据分析与业务结论.md"
    target.write_text(report, encoding="utf-8")
    print(target)


if __name__ == "__main__":
    main()
