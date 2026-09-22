import fs from "node:fs";
import type { AppDatabase } from "../db/database.js";
import type { JsonObject } from "../domain/types.js";
import { isJsonObject } from "../lib/json.js";
import type { BenchmarkSampleService } from "./benchmark-sample-service.js";
import { ServiceError } from "./template-service.js";

export class TrackDiscoveryService {
  private readonly sources: JsonObject[];
  private readonly targets: JsonObject[];

  constructor(
    private readonly database: AppDatabase,
    private readonly benchmarkSamples: BenchmarkSampleService,
    catalogPath: string
  ) {
    if (!fs.existsSync(catalogPath)) throw new Error(`赛道发现目录不存在：${catalogPath}`);
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as unknown;
    if (!isJsonObject(catalog)) throw new Error("赛道发现目录必须是JSON对象");
    this.sources = objectArray(catalog.sources);
    this.targets = objectArray(catalog.targets);
  }

  discover(draftId: string): JsonObject {
    const record = this.database.getTrackOnboardingDraft(draftId);
    if (!record) throw new ServiceError("未找到该赛道接入草案", 404);
    const industryName = requiredString(record.industry.name, "industry.name");
    const trackName = requiredString(record.track.name, "track.name");
    const contextTerms = [industryName, trackName].map(normalize);

    const sourceCandidates = this.sources
      .map((source) => ({ source, score: sourceScore(source, contextTerms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .map(({ source, score }) => ({
        code: source.code ?? null,
        name: source.name ?? null,
        category: source.category ?? null,
        source_type: source.source_type ?? null,
        url: source.url ?? null,
        allowed_domains: Array.isArray(source.allowed_domains) ? source.allowed_domains : [],
        allowed_methods: Array.isArray(source.allowed_methods) ? source.allowed_methods : [],
        quality_baseline: source.quality_baseline ?? null,
        collection_ready: source.collection_ready === true,
        relevance_score: score,
        status: "candidate",
        requires_batch_confirmation: true
      }));

    const targetCandidates = this.targets
      .map((target) => ({ target, score: targetScore(target, contextTerms) }))
      .filter((item) => item.score >= 40)
      .sort((left, right) => right.score - left.score)
      .map(({ target, score }) => ({
        target_key: target.target_key ?? null,
        organization_name: target.organization_name ?? null,
        market: target.market ?? null,
        ticker: target.ticker ?? null,
        jurisdiction: target.jurisdiction ?? null,
        sample_type_suggestion: target.sample_type_suggestion ?? "benchmark",
        sector_tags: Array.isArray(target.sector_tags) ? target.sector_tags : [],
        discovery_reason: target.discovery_reason ?? "待补充发现理由",
        official_sources: Array.isArray(target.official_sources) ? target.official_sources : [],
        relevance_score: score,
        status: "candidate",
        facts_verified: false,
        requires_evidence_review: true
      }));

    const draft = structuredClone(record.draft);
    draft.discovery = {
      engine_version: "catalog-discovery-v1",
      discovered_at: new Date().toISOString(),
      source_candidates: sourceCandidates,
      target_candidates: targetCandidates,
      discovery_queries: buildDiscoveryQueries(industryName, trackName),
      governance: {
        catalog_candidates_are_not_verified_facts: true,
        no_login_or_access_control_bypass: true,
        no_automatic_benchmark_approval: true,
        one_batch_confirmation_before_registration: true
      }
    };
    draft.source_discovery_plan = {
      ...(isJsonObject(draft.source_discovery_plan) ? draft.source_discovery_plan : {}),
      status: sourceCandidates.length > 0 ? "candidates_ready" : "no_candidate_source",
      discovered_source_count: sourceCandidates.length,
      automatic_collection_ready: false,
      required_next_step: sourceCandidates.length > 0
        ? "批量确认来源范围后，系统才能写入域名白名单和正式采集计划"
        : "当前目录未命中专属来源，需要执行公开检索任务并补充来源目录"
    };
    draft.sample_discovery_plan = {
      ...(isJsonObject(draft.sample_discovery_plan) ? draft.sample_discovery_plan : {}),
      status: targetCandidates.length > 0 ? "candidates_ready" : "pending_public_search",
      discovered_target_count: targetCandidates.length,
      benchmark_candidate_count: targetCandidates.filter((item) => item.sample_type_suggestion === "benchmark").length,
      control_candidate_count: targetCandidates.filter((item) => item.sample_type_suggestion === "control").length,
      risk_candidate_count: targetCandidates.filter((item) => item.sample_type_suggestion === "risk").length,
      reason: targetCandidates.length > 0
        ? "目标企业来自可审计种子索引；仍需采集公开披露并验证赛道相关性和负责人信息"
        : "当前种子索引未命中目标企业，已生成官方来源公开检索任务"
    };
    draft.readiness = {
      ...(isJsonObject(draft.readiness) ? draft.readiness : {}),
      formal_rule_pack: "not_ready",
      discovery: sourceCandidates.length > 0 ? "candidate_sources_ready" : "public_search_required",
      blockers: ["来源候选尚未批量确认", "目标企业尚未完成证据采集与相关性核验", "评分维度和门槛尚未由跨样本证据验证"]
    };

    const updated = this.database.updateTrackOnboardingDraft({
      id: record.id,
      status: "discovery_ready",
      draft
    });
    return {
      draft: updated,
      summary: {
        source_candidate_count: sourceCandidates.length,
        collection_ready_source_count: sourceCandidates.filter((item) => item.collection_ready === true).length,
        target_candidate_count: targetCandidates.length,
        benchmark_candidate_count: targetCandidates.filter((item) => item.sample_type_suggestion === "benchmark").length,
        control_candidate_count: targetCandidates.filter((item) => item.sample_type_suggestion === "control").length,
        risk_candidate_count: targetCandidates.filter((item) => item.sample_type_suggestion === "risk").length
      },
      notice: "发现结果是候选清单，不是可信事实、标杆批准或投资建议；确认后才会进入来源注册和采集计划。"
    } as unknown as JsonObject;
  }

  importOfflineCandidates(body: unknown): JsonObject {
    if (!isJsonObject(body)) throw new ServiceError("离线样本导入请求必须是JSON对象", 400);
    const trackCode = requiredString(body.track_code, "track_code");
    const industryName = requiredString(body.industry_name, "industry_name");
    const trackName = requiredString(body.track_name, "track_name");
    const importedBy = requiredString(body.imported_by ?? "离线目录导入", "imported_by");
    const contextTerms = [industryName, trackName].map(normalize);
    const candidates = this.targets
      .map((target) => ({ target, score: targetScore(target, contextTerms) }))
      .filter((item) => item.score >= 40)
      .sort((left, right) => right.score - left.score);
    const imported: JsonObject[] = [];
    const skipped: JsonObject[] = [];
    const observationDate = new Date().toISOString().slice(0, 10);
    for (const { target, score } of candidates) {
      const targetKey = requiredString(target.target_key, "catalog.target_key");
      const sampleKey = `offline-${trackCode}-${targetKey}`.slice(0, 120);
      const existing = this.benchmarkSamples.getSampleByKey(sampleKey);
      if (existing) {
        skipped.push({ sample_key: sampleKey, reason: "already_imported" });
        continue;
      }
      const organizationName = requiredString(target.organization_name, "catalog.organization_name");
      const sampleType = ["benchmark", "control", "risk"].includes(String(target.sample_type_suggestion))
        ? String(target.sample_type_suggestion)
        : "control";
      const result = this.benchmarkSamples.createSample({
        sample_key: sampleKey,
        sample_type: sampleType,
        person_name: "负责人待核验",
        person_role: "企业负责人（待核验）",
        organization_name: organizationName,
        track_code: trackCode,
        jurisdiction: typeof target.jurisdiction === "string" ? target.jurisdiction : "待核验",
        organization_stage: "公开候选企业（待核验）",
        observation_date: observationDate,
        status: "collecting",
        summary: `离线候选索引：${String(target.discovery_reason ?? "赛道相关性待核验")}`,
        metadata: {
          offline_seed: true,
          imported_by: importedBy,
          imported_at: new Date().toISOString(),
          leader_identity_status: "unconfirmed",
          facts_verified: false,
          relevance_score: score,
          market: target.market ?? null,
          ticker: target.ticker ?? null,
          sector_tags: Array.isArray(target.sector_tags) ? target.sector_tags : [],
          discovery_reason: target.discovery_reason ?? null,
          official_sources: Array.isArray(target.official_sources) ? target.official_sources : [],
          sample_type_is_suggestion: true
        }
      });
      imported.push(result.sample as unknown as JsonObject);
    }
    const matchingSources = this.sources
      .map((source) => ({ source, score: sourceScore(source, contextTerms) }))
      .filter((item) => item.score > 0)
      .map(({ source, score }) => ({
        code: source.code ?? null,
        name: source.name ?? null,
        url: source.url ?? null,
        quality_baseline: source.quality_baseline ?? null,
        relevance_score: score,
        document_fetched: false
      }));
    return {
      mode: "offline_catalog_seed",
      track_code: trackCode,
      imported_sample_count: imported.length,
      skipped_sample_count: skipped.length,
      source_lead_count: matchingSources.length,
      imported_samples: imported,
      skipped_samples: skipped,
      source_leads: matchingSources,
      safeguards: {
        leader_identity_unconfirmed: true,
        facts_verified: false,
        no_automatic_benchmark_approval: true,
        no_outbound_network_access: true
      },
      notice: "离线目录只导入候选企业线索和来源地址，不等同于已采集原始披露、负责人事实或标杆批准。"
    } as unknown as JsonObject;
  }
}

function sourceScore(source: JsonObject, contextTerms: string[]): number {
  const industryTerms = stringArray(source.industry_keywords).map(normalize);
  const trackTerms = stringArray(source.track_keywords).map(normalize);
  const global = industryTerms.includes("*") || trackTerms.includes("*");
  const industryMatch = contextTerms.some((term) => industryTerms.includes(term));
  const trackMatch = contextTerms.some((term) => trackTerms.includes(term));
  if (!global && !industryMatch && !trackMatch) return 0;
  const quality = Math.round(Number(source.quality_baseline ?? 0.5) * 40);
  return Math.min(100, quality + (global ? 20 : 0) + (industryMatch ? 20 : 0) + (trackMatch ? 30 : 0));
}

function targetScore(target: JsonObject, contextTerms: string[]): number {
  const tags = stringArray(target.sector_tags).map(normalize);
  const exactMatches = contextTerms.filter((term) => tags.includes(term)).length;
  const fuzzyMatches = contextTerms.filter((term) => tags.some((tag) => tag.includes(term) || term.includes(tag))).length;
  const officialSourceCount = objectArray(target.official_sources).length;
  return Math.min(100, exactMatches * 35 + fuzzyMatches * 15 + Math.min(officialSourceCount, 2) * 10);
}

function buildDiscoveryQueries(industryName: string, trackName: string): JsonObject[] {
  return [
    { purpose: "上市公司候选", query: `${trackName} 上市公司 年报 负责人`, preferred_sources: ["交易所", "证券监管机构"] },
    { purpose: "监管与许可", query: `${trackName} 监管 许可 备案`, preferred_sources: ["政府监管网站", "官方数据库"] },
    { purpose: "科技企业候选", query: `${industryName} ${trackName} 企业 产品 商业化`, preferred_sources: ["企业官网", "政府项目公示", "行业协会"] },
    { purpose: "风险对照", query: `${trackName} 处罚 诉讼 召回 经营风险`, preferred_sources: ["监管处罚", "司法公开", "公司公告"] }
  ];
}

function objectArray(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ServiceError(`${field}不能为空`, 400);
  return value.trim();
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_-]+/g, "");
}
