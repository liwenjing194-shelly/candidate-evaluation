import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { JsonObject, JsonValue, PolicyPackManifest, EvaluationTemplate } from "../domain/types.js";
import { isJsonObject } from "../lib/json.js";
import type { PolicyPackRegistry } from "../policy/policy-pack-registry.js";
import { BenchmarkCollectionService } from "./benchmark-collection-service.js";
import { BenchmarkSampleService } from "./benchmark-sample-service.js";
import { ServiceError } from "./template-service.js";
import { SchemaValidator } from "../validation/schema-validator.js";
import { buildIndustryTemplate } from "../policy/industry-rule-builder.js";

const CODE_PATTERN = /^[a-z][a-z0-9_]{2,48}$/;

export class IndustryTrackSetupService {
  constructor(
    private readonly config: AppConfig,
    private readonly schemas: SchemaValidator,
    private readonly policyPacks: PolicyPackRegistry,
    private readonly benchmarkSamples: BenchmarkSampleService,
    private readonly benchmarkCollector: BenchmarkCollectionService
  ) {}

  listBases(): JsonObject {
    return {
      bases: this.policyPacks.list().map((manifest) => ({
        policy_pack_id: manifest.policy_pack_id,
        name: manifest.name,
        industry: manifest.taxonomy.industry,
        track: manifest.taxonomy.track,
        version: manifest.version
      })),
      notice: "基准模板只用于生成结构草案，新行业的维度、门槛、权重和来源仍需人工确认。"
    } as unknown as JsonObject;
  }

  create(body: unknown): JsonObject {
    const input = requireObject(body);
    const industryCode = requiredCode(input.industry_code, "industry_code");
    const industryName = requiredString(input.industry_name, "industry_name");
    const industryDefinition = requiredString(input.industry_definition, "industry_definition", 8);
    const trackCode = requiredCode(input.track_code, "track_code");
    const trackName = requiredString(input.track_name, "track_name");
    const trackDefinition = requiredString(input.track_definition, "track_definition", 8);
    const confirmedBy = optionalString(input.confirmed_by) ?? "系统自动初始化";
    const confirmationReason = optionalString(input.confirmation_reason) ?? "根据行业与赛道输入自动建立规则草案、独立样本空间和合规来源计划";
    const sourceDomains = normalizeDomains(input.source_domains);
    const targets = parseTargets(input.targets);
    const targetDomains = targets.map((target) => new URL(target.url).hostname.replace(/^www\./i, "").toLowerCase());
    const domains = [...new Set([...sourceDomains, ...targetDomains])];

    const existing = this.policyPacks.list();
    if (existing.some((manifest) => manifest.taxonomy.industry.code === industryCode && manifest.taxonomy.track.code === trackCode)) {
      throw new ServiceError("该行业与赛道已经存在规则包", 409, { industry_code: industryCode, track_code: trackCode });
    }

    const base = this.loadBase(input.base_policy_pack_id);
    const policyPackId = `${trackCode}_team_lead_investment`;
    if (existing.some((manifest) => manifest.policy_pack_id === policyPackId)) {
      throw new ServiceError("根据赛道代码生成的规则包ID已经存在，请调整track_code", 409);
    }

    const fileStem = trackCode.replace(/_/g, "-");
    const templateFileName = `${fileStem}-team-lead-investment.v1.json`;
    const sourceFileName = `${fileStem}-sources.v1.json`;
    const seedFileName = `${fileStem}-samples.seed.v1.json`;
    const methodologyFileName = `${fileStem}-benchmark-methodology.v1.json`;
    const template = this.buildTemplate(base.template, {
      policyPackId, industryCode, industryName, industryDefinition, trackCode, trackName, trackDefinition
    });
    const schemaErrors = this.schemas.validateTemplate(template);
    if (schemaErrors.length > 0) throw new ServiceError("基准模板无法生成有效的模板草案", 400, schemaErrors);

    const manifest = this.buildManifest(base.manifest, {
      policyPackId, industryCode, industryName, industryDefinition, trackCode, trackName, trackDefinition,
      templateFileName, confirmedBy, confirmationReason
    });
    manifest.required_gate_order = template.gates.map(g => String(g.id));
    const sourceCatalog = this.buildSourceCatalog(base.catalog, { industryCode, industryName, trackCode, trackName, domains });
    const methodology = this.buildMethodology(base.methodology, { industryCode, industryName, trackCode, trackName });
    const seed = {
      schema_version: "1.0.0",
      dataset_version: "1.0.0",
      observed_at: new Date().toISOString().slice(0, 10),
      track_code: trackCode,
      notice: "系统自动建立的独立样本空间；将优先导入本地候选线索，样本不足只提示，不阻断模板人工检查与发布。",
      samples: []
    };
    const plan = this.buildCollectionPlan({ industryCode, industryName, trackCode, trackName, targets, sourceCode: `${trackCode}_official_public` });
    const registry = this.readRegistry();
    const libraries = Array.isArray(registry.libraries) ? [...registry.libraries.filter(isJsonObject)] : [];
    libraries.push({
      industry_code: industryCode,
      industry_name: industryName,
      track_code: trackCode,
      track_name: trackName,
      source_catalog_path: sourceFileName,
      seed_path: seedFileName,
      methodology_path: methodologyFileName,
      collection_targets_path: "collection-targets.v1.json"
    });
    registry.libraries = libraries;
    const collectionRegistry = this.readCollectionTargets();
    const plans = Array.isArray(collectionRegistry.plans) ? [...collectionRegistry.plans.filter(isJsonObject)] : [];
    plans.push(plan);
    collectionRegistry.plans = plans;

    const policyPath = path.join(this.config.policyPackDirectory, `${fileStem}-team-lead-investment.v1.policy-pack.json`);
    const templatePath = path.join(this.config.dataRoot, "templates", templateFileName);
    const sourcePath = path.join(this.config.benchmarkLibraryDirectory, sourceFileName);
    const seedPath = path.join(this.config.benchmarkLibraryDirectory, seedFileName);
    const methodologyPath = path.join(this.config.benchmarkLibraryDirectory, methodologyFileName);
    const createdPaths = [policyPath, templatePath, sourcePath, seedPath, methodologyPath];
    if (createdPaths.some((filePath) => fs.existsSync(filePath))) throw new ServiceError("新行业配置文件名已存在，请调整track_code", 409);

    const originalRegistry = fs.readFileSync(this.config.benchmarkLibraryRegistryPath, "utf8");
    const originalCollectionRegistry = fs.readFileSync(this.config.benchmarkCollectionTargetsPath, "utf8");
    try {
      fs.mkdirSync(path.dirname(templatePath), { recursive: true });
      fs.mkdirSync(this.config.policyPackDirectory, { recursive: true });
      fs.mkdirSync(this.config.benchmarkLibraryDirectory, { recursive: true });
      writeJson(policyPath, manifest);
      writeJson(templatePath, template);
      writeJson(sourcePath, sourceCatalog);
      writeJson(seedPath, seed);
      writeJson(methodologyPath, methodology);
      writeJson(this.config.benchmarkLibraryRegistryPath, registry);
      writeJson(this.config.benchmarkCollectionTargetsPath, collectionRegistry);
      this.policyPacks.reload();
      this.benchmarkSamples.reload();
      this.benchmarkCollector.reload();
    } catch (error) {
      fs.writeFileSync(this.config.benchmarkLibraryRegistryPath, originalRegistry, "utf8");
      fs.writeFileSync(this.config.benchmarkCollectionTargetsPath, originalCollectionRegistry, "utf8");
      for (const filePath of createdPaths) if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      this.policyPacks.reload();
      this.benchmarkSamples.reload();
      this.benchmarkCollector.reload();
      throw new ServiceError(`新行业配置未保存：${error instanceof Error ? error.message : "未知错误"}`, 400);
    }

    return {
      created: true,
      confirmed_by: confirmedBy,
      confirmation_reason: confirmationReason,
      industry: { code: industryCode, name: industryName, definition: industryDefinition },
      track: { code: trackCode, name: trackName, definition: trackDefinition },
      policy_pack: { id: policyPackId, status: "approved", version: "1.0.0" },
      sample_library: { sample_count: 0, source_count: domains.length ? 2 : 0, notice: "独立样本空间已建立；样本不足不阻断模板生成、人工发布与评估。" },
      collection_plan: { target_count: targets.length, source_job_count: targets.length },
      notice: "行业和赛道已自动初始化并热加载。模板采用基准规则结构生成，正式投资使用前仍需一次人工总检查并发布。"
    } as unknown as JsonObject;
  }

  private loadBase(policyPackId: unknown): { manifest: PolicyPackManifest; template: EvaluationTemplate; catalog: JsonObject; methodology: JsonObject } {
    const requestedId = typeof policyPackId === "string" && policyPackId.trim() ? policyPackId.trim() : this.policyPacks.list()[0]?.policy_pack_id;
    const manifestPath = fs.readdirSync(this.config.policyPackDirectory)
      .filter((name) => name.endsWith(".policy-pack.json"))
      .map((name) => path.join(this.config.policyPackDirectory, name))
      .find((filePath) => {
        try { return readJsonObject(filePath).policy_pack_id === requestedId; } catch { return false; }
      });
    if (!manifestPath) throw new ServiceError("未找到用于生成草案的基准规则包", 400);
    const manifest = readJsonObject(manifestPath) as unknown as PolicyPackManifest;
    const template = readJsonObject(path.resolve(path.dirname(manifestPath), manifest.template_file)) as unknown as EvaluationTemplate;
    const registry = this.readRegistry();
    const entry = (Array.isArray(registry.libraries) ? registry.libraries.filter(isJsonObject) : [])
      .find((item) => item.track_code === manifest.taxonomy.track.code);
    if (!entry) throw new ServiceError("基准规则包没有对应样本库登记", 400);
    return {
      manifest,
      template,
      catalog: readJsonObject(path.join(this.config.benchmarkLibraryDirectory, requiredString(entry.source_catalog_path, "source_catalog_path"))),
      methodology: readJsonObject(path.join(this.config.benchmarkLibraryDirectory, requiredString(entry.methodology_path, "methodology_path")))
    };
  }

  private buildManifest(base: PolicyPackManifest, input: SetupInput & { templateFileName: string; confirmedBy: string; confirmationReason: string }): JsonObject {
    return {
      schema_version: "1.0",
      policy_pack_id: input.policyPackId,
      version: "1.0.0",
      name: `${input.trackName}团队负责人投资评估规则包`,
      status: "approved",
      default_for_mock: false,
      taxonomy: { industry: { code: input.industryCode, name: input.industryName, aliases: [] }, track: { code: input.trackCode, name: input.trackName, aliases: [] } },
      definitions: { industry: input.industryDefinition, track: input.trackDefinition },
      applicability: base.applicability,
      template_file: `../templates/${input.templateFileName}`,
      required_gate_order: base.required_gate_order,
      governance_rules: base.governance_rules,
      review: { approved_by: input.confirmedBy, approved_at: new Date().toISOString(), approval_note: input.confirmationReason, source: "industry_track_setup_wizard" }
    };
  }

  private buildTemplate(base: EvaluationTemplate, input: SetupInput): EvaluationTemplate {
    const template = structuredClone(base);
    template.template_id = input.policyPackId;
    template.version = "1.0.0";
    template.name = `${input.trackName}团队负责人投资评估模板`;
    template.status = "draft";
    template.description = `新增行业向导基于既有模板结构生成的${input.industryName}/${input.trackName}草案，正式使用前必须人工核验行业维度、门槛和权重。`;
    template.scope = {
      ...template.scope,
      industry: input.industryName,
      track: input.trackName,
      applicability_notes: [`行业定义：${input.industryDefinition}`, `赛道定义：${input.trackDefinition}`, "本模板仅为结构草案，不能替代行业尽调和人工确认"]
    };
    template.generation = {
      ...template.generation,
      method: "base_template_plus_ai_adaptation",
      generated_at: new Date().toISOString(),
      model: "mock-template-provider",
      prompt_version: "industry-track-wizard-v1",
      policy_pack_id: input.policyPackId,
      policy_pack_version: "1.0.0",
      policy_pack_status: "approved",
      policy_pack_match: "exact",
      requires_human_approval: true,
      approved_by: null,
      approved_at: null
    };
    return buildIndustryTemplate(template, input.industryName, input.trackName, input.policyPackId);
  }

  private buildSourceCatalog(base: JsonObject, input: { industryCode: string; industryName: string; trackCode: string; trackName: string; domains: string[] }): JsonObject {
    const governance = isJsonObject(base.governance) ? structuredClone(base.governance) : {};
    return {
      schema_version: "1.0.0",
      catalog_version: "1.0.0",
      industry: { code: input.industryCode, name: input.industryName },
      track: { code: input.trackCode, name: input.trackName },
      governance: { ...governance, purpose: `仅用于${input.trackName}投资研究、候选人评估和模板规则论证，不用于自动作出投资或个人权益决定。` },
      sources: input.domains.length === 0 ? [] : [
        { code: `${input.trackCode}_official_public`, name: `${input.trackName}官方公开披露`, category: "regulatory_and_company_public", source_type: "official_public", url: `https://${input.domains[0]}/`, allowed_domains: input.domains, allowed_methods: ["public_page"], automation_mode: "public_pages_subject_to_terms", scope: ["负责人任职", "产品与业务", "商业化", "风险与合规"], requirements: ["保留原始链接、发布日期和定位", "不得绕过登录、验证码或访问限制"], prohibitions: ["不得将单一公开页面直接转换为高置信度特质"], quality_baseline: 0.8 },
        { code: `${input.trackCode}_company_official`, name: `${input.trackName}企业官网与官方发布`, category: "company_first_party_public", source_type: "public_first_party", url: `https://${input.domains[0]}/`, allowed_domains: input.domains, allowed_methods: ["public_page"], automation_mode: "public_pages_subject_to_terms", scope: ["团队介绍", "产品发布", "合作公告", "负责人公开演讲"], requirements: ["标记为企业自述并尽量寻找独立来源交叉验证"], prohibitions: ["不得把营销表述直接转换为高置信度特质"], quality_baseline: 0.7 }
      ]
    };
  }

  private buildMethodology(base: JsonObject, input: { industryCode: string; industryName: string; trackCode: string; trackName: string }): JsonObject {
    const methodology = structuredClone(base);
    methodology.schema_version = "1.0.0";
    methodology.methodology_version = "1.0.0";
    methodology.industry = { code: input.industryCode, name: input.industryName };
    methodology.track = { code: input.trackCode, name: input.trackName };
    methodology.purpose = `以可核查的负责人和企业经营事实，生成${input.trackName}行业评估规则候选；不根据知名度、媒体评价或单一样本直接认定成功特质。`;
    if (isJsonObject(methodology.success_definition)) methodology.success_definition.label = `可持续、可复制并合规的${input.trackName}经营成果`;
    return methodology;
  }

  private buildCollectionPlan(input: { industryCode: string; industryName: string; trackCode: string; trackName: string; targets: SetupTarget[]; sourceCode: string }): JsonObject {
    return {
      industry_code: input.industryCode,
      industry_name: input.industryName,
      track_code: input.trackCode,
      track_name: input.trackName,
      targets: input.targets.map((target, index) => ({
        target_key: `${input.trackCode}-${index + 1}`,
        target_name: target.name,
        organization_name: target.organization,
        sample_key: null,
        urls: [{ source_code: input.sourceCode, url: target.url }]
      }))
    };
  }

  private readRegistry(): JsonObject { return readJsonObject(this.config.benchmarkLibraryRegistryPath); }
  private readCollectionTargets(): JsonObject { return readJsonObject(this.config.benchmarkCollectionTargetsPath); }
}

interface SetupInput {
  policyPackId: string;
  industryCode: string;
  industryName: string;
  industryDefinition: string;
  trackCode: string;
  trackName: string;
  trackDefinition: string;
}

interface SetupTarget { name: string; organization: string; url: string; }

function parseTargets(value: JsonValue | undefined): SetupTarget[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new ServiceError("targets必须是数组", 400);
  return value.map((item, index) => {
    if (!isJsonObject(item)) throw new ServiceError(`第${index + 1}个采集目标格式不正确`, 400);
    const url = requiredString(item.url, `targets[${index}].url`, 8);
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new ServiceError(`targets[${index}].url必须是有效网址`, 400); }
    if (!/^https?:$/i.test(parsed.protocol)) throw new ServiceError(`targets[${index}].url只允许HTTP或HTTPS`, 400);
    return { name: requiredString(item.name, `targets[${index}].name`), organization: requiredString(item.organization, `targets[${index}].organization`), url };
  });
}

function normalizeDomains(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  const domains = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0] ?? "")
    .filter((item) => /^[a-z0-9.-]+$/.test(item));
  return [...new Set(domains)];
}

function requiredCode(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!CODE_PATTERN.test(result)) throw new ServiceError(`${field}必须是小写字母、数字和下划线组成的代码`, 400);
  return result;
}

function requiredString(value: unknown, field: string, minimumLength = 2): string {
  if (typeof value !== "string" || value.trim().length < minimumLength) throw new ServiceError(`${field}至少需要${minimumLength}个字符`, 400);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new ServiceError("请求体必须是JSON对象", 400);
  return value;
}

function readJsonObject(filePath: string): JsonObject {
  if (!fs.existsSync(filePath)) throw new Error(`JSON文件不存在: ${filePath}`);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isJsonObject(value)) throw new Error(`JSON文件必须是对象: ${filePath}`);
  return value;
}

function writeJson(filePath: string, value: JsonValue): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
