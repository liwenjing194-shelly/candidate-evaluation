# 投资评估系统

面向投资部门的行业/赛道候选人评估系统。系统根据行业和赛道生成独立的投资规则模板，支持门槛判断、加权评分、证据管理、自动预评估、报告归因和人工结论。

> 当前仓库是可公开阅读的演示版本。全部内置候选人、标杆样本和经营数据均为模拟或脱敏测试材料，不代表真实企业、真实人物或投资建议。

## 在线演示

- Render 演示地址：<https://candidate-evaluation.onrender.com>
- 用户名：`reviewer`
- 访问密码：由部署者在 Render 环境变量中设置，不写入仓库

免费实例可能在闲置后休眠，首次访问需要等待唤醒。免费服务的本地 SQLite 数据可能在重启、休眠或重新部署后丢失，请使用系统中的“备份与恢复”功能保存规则和报告。

## 主要功能

### 行业规则模板

- 输入行业和赛道，生成对应的评分维度、投资门槛、权重和评分锚点草案
- 不同赛道独立维护行业定义、赛道定义、规则包、样本和数据源
- 支持企业办公软件SaaS、智慧医疗、广告自动化、AI短剧、Agentic Commerce等测试规则
- 支持保存草案、检查规则、人工确认和发布版本
- 已发布模板按版本保存，评估任务使用模板快照

### 样本和证据

- 支持标杆候选、普通对照、风险样本和内部候选人分组
- 支持离线候选样本和本地材料导入
- 支持证据质量评分、证据冲突提示、来源类别和复核状态
- 样本和证据只用于归因参考，不会自动修改评分维度、门槛或权重

### 候选人评估

- 选择已发布的行业模板创建评估任务
- 导入候选人材料和证据
- 自动生成门槛判断建议、维度预评分、综合得分、结论理由和重点复核项
- 关键门槛不被综合评分抵消
- AI只能提出建议，人工保留门槛修改、最终评分、发布和投资结论权限

### 数据安全与备份

- 默认使用 Mock Provider，不调用真实模型
- Render 免费演示强制使用 Mock Provider，不配置模型密钥
- 页面和 API 支持共享密码保护
- 支持导出规则和报告便携备份
- 备份恢复会生成待检查规则草案，报告作为只读存档，不覆盖现有数据

## 技术栈

- Node.js 24+
- TypeScript、Fastify、SQLite
- AJV JSON Schema 校验
- Vitest 自动化测试
- 单页 HTML/CSS/JavaScript 前端
- Render Free Web Service 部署

## 本地运行

要求 Node.js 24 或更高版本。

```powershell
Set-Location -LiteralPath 'D:\候选人评估系统'
npm.cmd install
npm.cmd run dev
```

打开 <http://127.0.0.1:3000>。本地开发默认使用 Mock Provider，不需要 API Key。

## 验证命令

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
npm.cmd run validate:config
```

## Render 免费部署

项目根目录的 `render.yaml` 已配置为：

- Free Web Service
- `TEMPLATE_PROVIDER=mock`
- `FREE_DEMO_MODE=true`
- 不创建磁盘、数据库或付费资源
- 健康检查：`/api/health`

部署时连接 GitHub 仓库并创建 Blueprint，确认只有一个 Free Web Service；设置 `APP_ACCESS_PASSWORD`，至少16位，不要写入源码。构建命令为 `npm ci --include=dev && npm run build`，启动命令为 `npm start`。

Render 免费服务可能休眠，且无持久磁盘。不要将真实候选人材料、身份证明、未脱敏财务数据或生产数据库上传到本仓库或免费演示环境。

## 项目结构

```text
src/                         后端、领域模型、规则、Provider和业务服务
public/index.html             单页前端
schemas/                      JSON Schema
data/policy-packs/            行业规则包
data/templates/               模板样例
data/benchmark-library/       样本、来源和归因方法
data/golden/                  测试基线和预期结果
```

## 真实模型说明

项目保留了真实模型 Provider 的适配接口，但免费部署默认不会调用真实模型。真实模型输出仍必须经过 JSON Schema、业务规则和人工确认。

## 测试材料

仓库内包含 AI短剧、Agentic Commerce、企业办公软件SaaS、智慧医疗和广告自动化测试材料。A/B/C 案例分别覆盖强、中、弱或风险场景。请先选择对应赛道的已发布模板，再上传同赛道材料，避免跨赛道误用规则。

## 当前边界

本项目是候选人投资评估辅助工具，不是自动投资决策系统：

- 综合得分不能抵消关键门槛风险
- “未确认”不能自动转换为“不符合”
- AI不能自动否决候选人或自动生成最终投资结论
- 最终投资判断、门槛修改、模板发布和报告使用都需要人工负责

## 公开说明

公开仓库不包含本机运行数据库、候选人原始附件、聊天记录和部署密钥。生产使用前，应另行完成身份权限、持久化存储、审计、加密、备份和合规评估。
