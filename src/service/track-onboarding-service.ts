import { randomUUID } from "node:crypto";
import type { JsonObject, TrackOnboardingDraftRecord, TemplateGeneratorInput } from "../domain/types.js";
import { isJsonObject } from "../lib/json.js";
import type { AppDatabase } from "../db/database.js";
import type { PolicyPackRegistry } from "../policy/policy-pack-registry.js";
import { ServiceError } from "./template-service.js";

/**
 * 为尚未登记的行业/赛道生成“接入草案”。
 *
 * 这里故意只生成候选规则、来源类别和发现计划，不伪造企业名单、网址或事实证据。
 * 真实来源接入仍受来源白名单约束；人工确认集中在最终模板发布环节。
 */
export class TrackOnboardingService {
  constructor(
    private readonly database: AppDatabase,
    private readonly policyPacks: PolicyPackRegistry
  ) {}

  createOrGet(body: unknown): JsonObject {
    const input = requireObject(body);
    const industryName = requiredString(input.industry_name, "industry_name");
    const trackName = requiredString(input.track_name, "track_name");
    const formalPack = this.findFormalPack(industryName, trackName);
    if (formalPack) {
      return {
        created: false,
        match: "exact",
        formal_rule_pack: {
          id: formalPack.policy_pack_id,
          version: formalPack.version,
          industry: formalPack.taxonomy.industry,
          track: formalPack.taxonomy.track
        },
        notice: "该行业和赛道已有正式规则包，系统应直接加载正式样本库和采集计划。"
      } as unknown as JsonObject;
    }

    const industryCode = normalizeCode(input.industry_code, industryName, "industry");
    const trackCode = normalizeCode(input.track_code, trackName, "track");
    const contextKey = `${industryCode}::${trackCode}`;
    const existing = this.database.getTrackOnboardingDraftByKey(contextKey);
    if (existing) return this.toResponse(existing, false);

    const draft = buildDraft({ industryCode, industryName, trackCode, trackName });
    const record = this.database.createTrackOnboardingDraft({
      contextKey,
      industry: { code: industryCode, name: industryName },
      track: { code: trackCode, name: trackName },
      status: "ready_for_review",
      draft
    });
    return this.toResponse(record, true);
  }

  get(id: string): JsonObject {
    const record = this.database.getTrackOnboardingDraft(id);
    if (!record) throw new ServiceError("未找到该赛道接入草案", 404);
    return this.toResponse(record, false);
  }

  private toResponse(record: TrackOnboardingDraftRecord, created: boolean): JsonObject {
    // 接入参考与最终生成使用同一套规则，避免两个界面展示不同的行业指标。
    const context = record.draft as JsonObject;
    if (isJsonObject(context.industry) && isJsonObject(context.track)) {
      const resolved = this.policyPacks.resolve({ industry: { name: String(context.industry.name) }, track: { name: String(context.track.name) } } as TemplateGeneratorInput);
      context.recommended_dimensions = resolved.template.dimensions.map(d => ({ id: d.id!, name: d.name!, weight: d.weight!, investment_question: d.investment_question!, confidence: "low", basis: "本地行业适配框架；权重未经样本统计校准" }));
      context.recommended_gates = resolved.template.gates.map(g => ({ id: g.id!, name: g.name!, order: g.order!, critical: true, initial_status: "unconfirmed", reason: g.question! }));
      context.next_actions = ["生成赛道适配模板草案", "样本作为可选优化参考，不阻断生成", "人工总检查并发布", "在候选人评估中选择已发布版本"];
    }
    return {
      created,
      match: "exploration",
      draft: record,
      notice: "这是探索性接入草案，不会自动发布正式规则包、自动认定标杆特质或触发投资否决。"
    } as unknown as JsonObject;
  }

  private findFormalPack(industryName: string, trackName: string) {
    const industry = normalize(industryName);
    const track = normalize(trackName);
    return this.policyPacks.list().find((pack) => {
      const industryTerms = [pack.taxonomy.industry.code, pack.taxonomy.industry.name, ...pack.taxonomy.industry.aliases.map(String)];
      const trackTerms = [pack.taxonomy.track.code, pack.taxonomy.track.name, ...pack.taxonomy.track.aliases.map(String)];
      return industryTerms.some((item) => normalize(item) === industry)
        && trackTerms.some((item) => normalize(item) === track);
    }) ?? null;
  }
}

function buildDraft(input: {
  industryCode: string;
  industryName: string;
  trackCode: string;
  trackName: string;
}): JsonObject {
  const medical = /医疗|医药|health|medical|medtech/i.test(`${input.industryName} ${input.trackName}`);
  const dimensions: Array<[string, string, string, number]> = medical
    ? [
      ["clinical_or_user_value", "临床或用户价值", "是否解决明确的医疗服务问题，并能以合规方式证明真实需求和持续使用？", 16],
      ["technology_and_product_reliability", "技术与产品可靠性", "核心模型、产品和交付流程能否稳定运行并支持规模化？", 17],
      ["clinical_safety_and_risk_control", "医疗安全与风险控制", "是否建立误用、误诊、责任边界和异常处置机制？", 18],
      ["regulatory_and_data_compliance", "监管与数据合规能力", "是否覆盖医疗器械、诊疗服务、数据安全和隐私等适用要求？", 18],
      ["commercialization_and_reimbursement", "商业化与支付路径", "客户、付费方、采购流程和收入模型是否清晰可验证？", 13],
      ["delivery_and_scale", "交付与规模化能力", "团队能否把试点结果复制到更多医院、机构或用户场景？", 10],
      ["leader_execution_and_integrity", "负责人执行与诚信", "负责人是否能持续交付、如实披露并处理利益冲突？", 8]
    ]
    : [
      ["user_or_market_value", "用户/市场价值", "是否解决明确且高频的问题，并有可验证的真实需求？", 16],
      ["technology_or_product_reliability", "技术/产品可靠性", "核心产品和技术能否稳定交付，并形成可复用能力？", 16],
      ["regulatory_and_data_compliance", "监管与数据合规", "是否识别并控制该行业的监管、数据、知识产权和责任风险？", 16],
      ["commercialization_path", "商业化路径", "客户、付费意愿、销售周期和收入模型是否清晰可验证？", 16],
      ["delivery_and_scale", "交付与规模化能力", "团队能否将试点结果稳定复制，并支持规模化生产或服务？", 14],
      ["competitive_and_ecosystem_position", "竞争与生态位", "是否形成差异化能力、渠道优势或关键合作网络？", 12],
      ["leader_execution_and_integrity", "负责人执行与诚信", "负责人是否能持续交付、如实披露并处理利益冲突？", 10]
    ];

  return {
    schema_version: "1.0.0",
    onboarding_draft_id: randomUUID(),
    generated_by: "mock-track-onboarding-provider",
    generated_at: new Date().toISOString(),
    status: "exploration_draft",
    industry: {
      code: input.industryCode,
      name: input.industryName,
      definition: `围绕${input.industryName}相关产品、技术、服务和经营主体的投资研究范围。`
    },
    track: {
      code: input.trackCode,
      name: input.trackName,
      definition: `以${input.trackName}为核心应用或商业模式的企业与团队，不等同于泛行业概念。`
    },
    recommended_dimensions: dimensions.map(([id, name, question, weight]) => ({ id, name, investment_question: question, weight, confidence: "low", basis: "通用行业评估框架与关键词适配，待公开数据验证" })),
    recommended_gates: [
      { id: "rights_and_regulatory_compliance", name: "权利与监管合规", critical: true, order: 1, initial_status: "unconfirmed", reason: "先确认是否存在不可接受的许可、知识产权或监管障碍" },
      { id: "leader_integrity_and_verifiability", name: "负责人诚信与可核查性", critical: true, order: 2, initial_status: "unconfirmed", reason: "需要可核查的履历、披露和关键事实" },
      { id: "commercialization_path", name: "商业化路径", critical: true, order: 3, initial_status: "unconfirmed", reason: "需要验证客户、付费方和收入路径" },
      { id: "conflict_of_interest", name: "利益冲突", critical: true, order: 4, initial_status: "unconfirmed", reason: "需要识别关联交易、兼职、持股和项目冲突" }
    ],
    source_discovery_plan: {
      status: "pending_source_registration",
      automatic_collection_ready: false,
      recommended_categories: ["监管与备案", "交易所或公司法定披露", "企业官网与官方发布", "知识产权与司法公开信息", "行业协会或公共统计"],
      discovery_method: "仅在公开页面、官方接口或已授权数据范围内检索；不绕过登录、验证码或访问限制",
      required_next_step: "从来源目录中确认可采集域名和允许的访问方式"
    },
    sample_discovery_plan: {
      status: "pending_target_discovery",
      automatic_classification: "数据进入后按标杆候选、普通对照、风险对照进行规则初分，异常项进入重点复核",
      target_universe: "上市公司、公开披露充分的科技企业、行业头部服务商及可核查的失败/风险对照样本",
      discovered_target_count: 0,
      reason: "当前未调用真实搜索或外部模型，不伪造企业名单；正式接入后由合规数据源发现器填充"
    },
    readiness: {
      formal_rule_pack: "not_ready",
      template_generation: "exploration_only",
      human_confirmation: "系统自动初始化规则和样本空间；最终模板发布前进行一次人工总检查",
      blockers: ["评分维度和门槛尚未由赛道证据充分验证；不阻断进入人工检查"]
    },
    next_actions: [
      "自动发现并去重合规公开数据源",
      "形成目标企业候选清单并按样本类型初分",
      "采集原始公开文档并进入证据质量与冲突检查",
      "达到样本和证据门槛后生成正式规则包候选"
    ]
  };
}

function requireObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new ServiceError("赛道接入请求必须是JSON对象", 400);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length < 2) {
    throw new ServiceError(`${field}至少需要2个字符`, 400);
  }
  return value.trim();
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function normalizeCode(value: unknown, name: string, prefix: string): string {
  if (typeof value === "string" && /^[a-z][a-z0-9_]{2,48}$/.test(value.trim())) return value.trim();
  const ascii = name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (ascii.length >= 3) return ascii.slice(0, 48);
  const hex = Array.from(name).map((character) => character.codePointAt(0)?.toString(16) ?? "").join("").slice(0, 42);
  return `${prefix}_${hex || "term"}`.slice(0, 50);
}
