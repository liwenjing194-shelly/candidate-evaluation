import { createHash } from "node:crypto";
import type { EvaluationTemplate } from "../domain/types.js";

type Dimension = [string, string, number, string];
const profiles: { pattern: RegExp; name: string; dimensions: Dimension[]; risk: string }[] = [
  { pattern: /医疗|医药|medical|health/i, name: "医疗科技", risk: "临床安全、产品准入与患者数据授权", dimensions: [
    ["clinical_value", "临床需求与实际价值", 18, "临床终点、适用人群、现有诊疗方案对照"],
    ["clinical_validation", "临床验证与泛化能力", 20, "外部验证、样本代表性、误诊漏诊与亚组表现"],
    ["patient_safety", "安全与质量管理", 17, "不良事件、风险处置、质量体系与人工接管记录"],
    ["medical_compliance", "准入与数据治理能力", 15, "产品适用范围、准入材料、数据授权与隐私保护"],
    ["hospital_adoption", "客户落地与商业化", 12, "医院采购、实际使用、付费回款与客户续约"],
    ["medical_delivery", "部署交付与单位经济", 10, "部署周期、系统集成、运维成本与项目毛利"],
    ["team_execution", "负责人及跨学科团队执行", 8, "临床技术协作、负责人贡献与里程碑兑现"] ] },
  { pattern: /影游|游戏|game|gaming/i, name: "互动娱乐", risk: "内容权属、发行准入与用户权益保护", dimensions: [
    ["interactive_experience", "互动设计与玩家体验", 20, "分支选择有效性、交互反馈、试玩反馈与完成率"],
    ["player_retention", "用户验证与留存", 18, "次日及周期留存、复玩率、付费用户与样本口径"],
    ["game_production", "研发制作与技术稳定性", 17, "引擎构建、分支测试、崩溃率与版本交付"],
    ["release_distribution", "发行获客与渠道能力", 15, "发行协议、渠道转化、获客成本与平台依赖"],
    ["game_economics", "商业模式与项目回报", 12, "销量回款、付费转化、退款率与完整开发成本"],
    ["content_pipeline", "内容供给与持续运营", 10, "内容更新周期、资产复用、版本计划与玩家反馈闭环"],
    ["team_execution", "负责人及制作团队执行", 8, "制作分工、关键人员稳定性与里程碑兑现"] ] },
  { pattern: /机器人|制造|物流|robot|manufact|logistic/i, name: "工业与实体交付", risk: "作业安全、产品准入与核心技术权属", dimensions: [
    ["operating_value", "作业需求与客户价值", 18, "作业效率、替代成本与真实客户验收"],
    ["field_reliability", "现场可靠性与安全", 20, "任务成功率、故障间隔、事故记录与环境适应性"],
    ["core_engineering", "核心技术与工程化", 17, "关键部件性能、技术权属与量产一致性"],
    ["supply_delivery", "供应链及规模交付", 15, "供应商备选、良率、交付周期与产能利用率"],
    ["unit_economics", "单位经济与回款", 12, "物料成本、服务成本、毛利与账期"],
    ["customer_expansion", "客户复购与应用拓展", 10, "复购订单、部署场景与客户集中度"],
    ["team_execution", "负责人及工程团队执行", 8, "工程履历、组织协作与里程碑兑现"] ] },
  { pattern: /软件|saas|企业服务|software/i, name: "企业软件", risk: "软件权属、数据授权与服务安全", dimensions: [
    ["customer_value", "业务痛点与客户价值", 18, "目标客户流程改善、用户访谈与实际使用"],
    ["product_reliability", "产品可靠性与技术能力", 17, "可用性、性能、故障恢复与架构扩展性"],
    ["retention_expansion", "留存与客户扩张", 20, "客户流失、续费率、净收入留存与统计周期"],
    ["sales_efficiency", "销售效率与可复制获客", 15, "销售周期、获客成本与渠道转化"],
    ["unit_economics", "收入质量与单位经济", 12, "经常性收入、毛利、回款与交付成本"],
    ["data_security", "安全治理与交付能力", 10, "访问控制、审计、客户部署及服务承诺"],
    ["team_execution", "负责人及产品团队执行", 8, "产品迭代、客户成功协作与里程碑兑现"] ] }
];

/** Reuse only the schema envelope and universal governance, never another sector's business rules. */
export function buildIndustryTemplate(base: EvaluationTemplate, industry: string, track: string, id?: string): EvaluationTemplate {
  const profile = profiles.find(p => p.pattern.test(track)) ?? profiles.find(p => p.pattern.test(industry));
  const dimensions: Dimension[] = profile?.dimensions ?? [
    ["market_value", `${track}客户需求与价值`, 18, "目标客户、实际痛点、替代方案与需求验证"],
    ["product_validation", `${track}产品与服务验证`, 18, "真实使用、交付质量、验收结果与复现记录"],
    ["commercial_economics", "商业化与单位经济", 16, "订单回款、成本毛利、复购与现金流"],
    ["scale_delivery", "规模化交付能力", 15, "交付周期、资源瓶颈、质量一致性与扩张成本"],
    ["competitive_position", "竞争差异与持续性", 13, "客户选择理由、替代难度与独立对照"],
    ["risk_governance", "权利合规与风险管理", 10, "经营资质适用性、权利链、风险清单与处置记录"],
    ["team_execution", "负责人及团队执行", 10, "负责人实际贡献、组织分工与里程碑兑现"]
  ];
  const template = structuredClone(base);
  template.template_id = id ?? `industry_${createHash("sha256").update(`${industry}/${track}`).digest("hex").slice(0, 20)}`;
  template.name = `${track}团队负责人投资评估模板`;
  template.version = "1.0.0";
  template.status = "ai_generated_draft";
  template.description = `${industry} / ${track}：${profile ? `${profile.name}行业适配规则` : "通用经营框架（尚无专属行业规则）"}。由本地规则生成器生成，不调用真实模型；不是样本统计结论。样本不足不阻止使用，人工总检查并发布后可评估。`;
  template.scope = { ...base.scope, industry, track, non_applicable_scenarios: [], applicability_notes: [
    "权重为初始建议，不代表实证成功概率；按项目阶段及适用地区检查后发布。",
    "缺少候选人证据时应标记未确认，不得自动填入低分或推定合规。",
    profile ? `当前适配领域：${profile.name}` : "当前为通用经营框架；发布前请补充该细分赛道的专属指标与监管要求。"
  ] };
  template.dimensions = dimensions.map(([key, name, weight, metrics]) => ({
    id: key, name, weight, investment_question: `在${track}业务中，团队能否以可核验材料证明${name}？重点核对${metrics}。`,
    sub_indicators: [{ id: `${key}_result`, name: "实际成果", question: `是否提供${metrics}的原始结果和统计口径？` }, { id: `${key}_repeat`, name: "可复制性", question: "不同客户、项目或周期是否能够重复取得结果？" }],
    required_evidence: [`${metrics}的原始记录`, "对应客户或项目的合同、验收或第三方验证材料"],
    verification_methods: ["核对来源、观察周期、样本范围和分母口径", "交叉验证原始记录及客户反馈，不以计划替代已实现结果"],
    anchors: ["经证据核实，关键要求尚未达到，或实际效果持续低于团队承诺", "已有单次试验或局部成果，但关键要求尚未稳定达到", "在目标场景完成验证，关键要求基本达到且原始结果可追溯", "跨多个项目或周期稳定达到要求，有可重复流程和异常处置记录", "跨场景持续验证优于明确对照，规模扩大仍保持结果且有独立证据支持"].map((description, index) => ({ score: index + 1, description: `${name}：${description}；核对${metrics}。` })),
    information_statuses: ["sufficient", "partially_sufficient", "unconfirmed", "conflicting", "not_applicable"], confidence_levels: ["high", "medium", "low"]
  }));
  const gates = [
    ["sector_rights_and_safety", profile?.risk ?? `${track}经营准入、权利与安全`, "适用资质、授权边界及风险控制有可核验证据", "存在已证实的重大无权经营、侵权或未处置安全风险"],
    ["leader_integrity_and_verifiability", "负责人诚信与可核查性", "身份履历、实际贡献及关键经营数据可交叉核验", "存在已证实的身份、履历或经营数据造假"],
    ["commercialization_path", "商业化路径", "付费主体、合同回款及成本逻辑明确且可核验", "核心交易被证实虚假或收入路径明确不可执行"],
    ["conflict_of_interest", "利益冲突", "实际控制、关联交易和外部利益已披露并有管理措施", "存在已证实的隐瞒重大关联交易、利益输送或资金挪用"]
  ];
  template.gates = gates.map(([key, name, pass, fail], index) => ({
    id: key!, name: name!, order: index + 1, critical: true, question: `在${industry}/${track}业务中，${name}是否满足要求？`,
    criteria: [{ status: "pass", criteria: [pass!] }, { status: "fail", criteria: [fail!] }, { status: "unconfirmed", criteria: ["材料缺失、口径冲突或适用性尚不明确，不能推定符合或不符合"] }],
    required_evidence: [`支持“${pass}”的原始材料`, "适用范围、出具主体及日期说明"], verification_methods: ["核对原始出处与适用范围，必要时专业复核"], veto_conditions: [fail!],
    unconfirmed_action: { generate_supplement_request: true, required_fields: ["material", "owner", "due_date", "verification_method", "status"] }
  }));
  template.workflow.ordered_steps = [...template.gates.map(g => String(g.id)), "weighted_dimension_scoring", "human_review", "authorized_final_decision"];
  template.sources = [];
  template.decision_rules.score_bands = [
    { min: 80, max: 100, meaning: "能力表现较强；仅在门槛满足且证据充分后进入投资讨论" },
    { min: 65, max: 79.99, meaning: "基本具备条件，仍需核实短板与关键假设" },
    { min: 50, max: 64.99, meaning: "能力或证据不足，需补充验证" },
    { min: 0, max: 49.99, meaning: "当前能力表现尚未达到规模化要求" }
  ];
  template.generation = { ...base.generation, generated_at: new Date().toISOString(), prompt_version: "industry-rules-v2", policy_pack_id: template.template_id, policy_pack_match: "exact", requires_human_approval: true, approved_by: null, approved_at: null };
  return template;
}
