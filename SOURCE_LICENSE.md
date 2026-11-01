# 数据来源、署名与许可说明

## 来源记录

- 数据集名称：**Brazilian E-Commerce Public Dataset by Olist**。
- 提供方与发布账号：Olist，Kaggle账号 `olistbr`；官方元数据同时列出creatorName为Francisco Magioli。
- 官方页面：[Kaggle Olist数据集](https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce)。
- 本项目实际下载：[官方版本2下载接口](https://www.kaggle.com/api/v1/datasets/download/olistbr/brazilian-ecommerce?datasetVersionNumber=2)。版本由下载参数与回执固定，不推断它就是网页所有历史版本中的最新版本。
- 本项目来源核验日期：2026-10-09；官方接口返回的更新时间与订单业务发生时间不同。
- 本地原始文件：`data/raw/brazilian-ecommerce-v2.zip`，44,717,580字节；9个CSV解压后共126,186,995字节。
- 原始ZIP SHA-256：`967e41e04fc306fe604e2a693f488995a8b41e5047418f8a5c8e4abd6deca784`。
- 下载回执：`data/raw/download_receipt.json`；官方元数据存档：`data/raw/kaggle_metadata.json`；实测结构：`data/raw/schema_coverage_audit.json`。

官方说明将其描述为匿名化真实商业数据，订单来自巴西多个电商渠道，并说明部分企业和合作方名称在评价文本中已替换。本项目能够核验来源声明与实际文件，不能独立审计底层企业交易；也没有Olist内部身份、合作授权或背书。

实测共有99,441个订单，下单时间为2016-09-04 21:15:19至2018-10-17 17:30:18。金额保留BRL原币，时间沿用源文件未注明时区的时间值。历史数据不是当前经营状况，也不代表整个巴西电商市场。

## 数据许可

官方元数据标注 **Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International（CC BY-NC-SA 4.0）**。参见 [官方许可摘要](https://creativecommons.org/licenses/by-nc-sa/4.0/)及 [完整许可文本](https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.en)。

使用或分发许可材料时，应保留适当署名、来源与许可链接，并说明修改；不得暗示原提供方认可本项目。许可包含非商业限制。公开分发基于材料的改编成果时，应按相同许可或许可允许的兼容方式共享；不得附加限制许可已允许行为的条件。[Creative Commons官方说明](https://creativecommons.org/licenses/by-nc-sa/4.0/)

本项目按学习与非商业展示的定位处理数据。商用或其他许可不覆盖的使用，需另行确认授权。本说明不作出额外的数据使用授权。

## 本项目做了哪些修改

原始ZIP保留未改动。派生数据进行了字段类型转换、金额分转换、时间和质量标记、品类翻译补充、订单级聚合及商家商品金额归属，保留问题记录而不是把所有异常订单直接删除。评价按文档规定选择最新有效回答，历史回放另设合格样本、观察边界和时间可见白名单。

分析表、图表、截图及回放输出均源自该公开数据与本项目计算，不是Olist官方产品或官方结论。对其中属于许可材料改编的部分，分发时保留CC BY-NC-SA 4.0及来源、修改说明。产品角色、功能流程和建议动作属于本项目设计假设；本机保存的处置记录属于模拟操作。

可在作品集或共享的分析成果中使用以下署名文字：

> 数据来源：[Brazilian E-Commerce Public Dataset by Olist](https://www.kaggle.com/datasets/olistbr/brazilian-ecommerce)，Olist / Kaggle（olistbr），本项目使用官方接口版本2。许可：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)。本项目对数据进行了清洗、聚合、指标计算与历史规则回放。原提供方未参与或认可本项目，结果不代表其官方结论。

## 程序与数据分别处理

CC BY-NC-SA 4.0是源数据的许可，不能据此宣称本项目所有程序自动使用该许可。本项目目前没有另外指定软件代码许可证，也没有自行替原数据提供方授予更多权利；如后续公开发布代码，应另行选择并明确代码许可，同时保留数据及改编材料的许可说明。
