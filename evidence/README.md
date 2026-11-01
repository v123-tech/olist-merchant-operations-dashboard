# 证据目录说明

本目录选择性保留汇总结果与来源回执，不分发原始 ZIP、SQLite 数据库、逐订单质量记录、逐订单首次提示或原本地工作目录。

| 文件 | 来源与用途 |
|---|---|
| `source_download_receipt.json` | 原项目 2026-10-09 官方版本 2 下载回执，含公开来源 URL、版本、字节数和 SHA-256；没有本地路径或凭据 |
| `analysis_results.json` 与分析 CSV | 原项目实际查询的汇总结果，供月份、地区、耗时、评价时序和金额核对 |
| `stage2_verification.json`、`replay_test_results.json`、`replay_receipt.json` | 2026-10-09 历史核查、测试和哈希记录，不替代本次测试 |
| `replay_results.json`、`replay_window_rules.csv`、`replay_group_counts.csv` | 固定规则的分窗口和分组离线汇总，存在样本选择偏差，不代表生产效果 |
| `quality_report.json` | 缺失、质量标记及表粒度的汇总，不含评价文本、客户标识或地理坐标 |
| `raw_export_reconciliation.json` | 本次从原 ZIP 的 CSV 独立重算，并与静态导出核对的报告 |
| `original_tests_current.txt`、`original_tests_current.json` | 本次重跑原测试的结果；必须阅读实际结果判断通过范围 |

历史回执中的输入路径是项目内的相对文件标识，相关大文件并未随仓库分发。保留某产物的哈希不表示仓库包含该产物。新的静态版和浏览器验收证据由当前交付补充，状态以当前 README 与交付报告为准。

数据来源为 Olist / Kaggle，版本 2；数据及其改编材料遵守 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)。项目进行了清洗、聚合、指标计算、规则回放和静态导出。原提供方未参与或认可项目；详见 [SOURCE_LICENSE.md](../SOURCE_LICENSE.md)。
