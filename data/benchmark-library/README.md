# 多行业样本库接入说明

样本库按 `track_code` 隔离。服务启动时读取 `registry.v1.json`，为每个已登记赛道加载三类文件：

1. `source_catalog_path`：合规数据源目录，定义允许的采集方式和来源质量基线。
2. `seed_path`：样本和事实证据种子。样本可以分为 `benchmark`、`control`、`risk`、`internal_candidate`，证据默认进入待复核队列。
3. `methodology_path`：该赛道的成功定义、结果维度、分组证据门槛和样本分析规则。

## 新增一个行业赛道

推荐方式：直接在首页“行业”和“赛道”输入框输入关键词。已登记的行业会给出提示并匹配正式规则包；未登记的新关键词会生成探索性模板草案，提示当前没有行业专属规则包，不能直接用于真实投资或发布。

探索性草案只是降低输入成本的起点，评分维度和投资门槛必须进入模板检查页人工修改、校验并发布。若要让新行业拥有独立样本库和自动采集计划，管理员可通过后台配置接口登记行业规则包、来源和目标企业；普通评估人员不需要操作这些配置。

如需批量配置或代码审查，也可以手工维护：复制一套最接近的新赛道 JSON 文件，替换行业代码、赛道代码、维度和证据来源；不要直接复用 AI 短剧的维度或样本。然后在 `registry.v1.json` 登记样本库，在 `collection-targets.v1.json` 登记自动采集目标和来源。

## 约束

- 仅使用官方公开、企业公开、候选人授权或具有明确许可的数据。
- 每条事实保留原始链接或本地材料定位、观察日期、采集方式和复核状态。
- 不采集与经营评估无关的敏感个人信息。
- 不设置额外的样本批准层；事实证据复核和模板人工确认是必要的人工作业点。
- 不同赛道只共享代码和流程，不共享样本、来源目录或归因方法。

## 按赛道自动采集器 MVP

页面中的“查看自动采集计划”会展示当前赛道的采集范围。选择赛道后，系统自动触发该计划；也可以通过以下接口执行整批采集：

```text
GET  /api/benchmark-library/collector/targets?track_code=agentic_commerce
POST /api/benchmark-library/collector/auto-runs
```

自动执行请求只需提供赛道和执行人：

```json
{ "track_code": "agentic_commerce", "requested_by": "尽调负责人" }
```

系统会从 `collection-targets.v1.json` 读取目标、来源、网址和样本绑定，逐条校验来源类型、允许的采集方式和 URL 域名白名单，再批量下载并将原始文档写入待复核证据队列。目标清单不是“全网所有企业”的承诺，而是可审计、可维护的赛道目标宇宙。

底层单条接口仍保留，主要用于测试、失败重试和后台运维，不再作为普通使用者的页面入口：

```text
POST /api/benchmark-library/collector/jobs
```

请求至少包含 `track_code`、`source_code`、`target_name`、`target_url` 和 `requested_by`；如需让文档进入已有样本的证据队列，再填写 `sample_id`。服务会校验来源类型、允许的采集方式和 URL 域名白名单，并把原始文件保存到 `data/runtime/benchmark-collector`。

采集任务与结果可通过以下接口查看或重试：

```text
GET  /api/benchmark-library/collector/jobs?track_code=agentic_commerce
GET  /api/benchmark-library/collector/jobs/:id
POST /api/benchmark-library/collector/jobs/:id/retry
```

当前自动采集器不跟随跳转、不绕过验证码或登录、不连接真实模型，也不自动抽取和确认负责人特质。HTML 只保存正文摘要；PDF 保存原始文件，页码和事实仍由复核人员定位确认。
