import fs from "node:fs";
import path from "node:path";
import type {
  BenchmarkEvidenceRecord,
  BenchmarkSampleRecord,
  JsonObject,
  JsonValue
} from "../domain/types.js";
import { AppDatabase } from "../db/database.js";
import { isJsonObject } from "../lib/json.js";
import { ServiceError } from "./template-service.js";

const SAMPLE_TYPES = ["benchmark", "control", "risk", "internal_candidate"] as const;
const SAMPLE_STATUSES = ["collecting", "ready_for_review", "approved", "retired"] as const;
const CONFIDENCE_LEVELS = ["low", "medium", "high"] as const;
const REVIEW_STATUSES = ["pending", "verified", "rejected"] as const;
const REVIEW_DECISIONS = ["verified", "rejected"] as const;
// Seed evidence is idempotently merged into SQLite whenever the service starts.

interface BenchmarkLibrary {
  industryCode: string;
  industryName: string;
  trackCode: string;
  trackName: string;
  catalog: JsonObject;
  sources: JsonObject[];
  methodology: JsonObject;
  seed: JsonObject;
}

export class BenchmarkSampleService {
  private registry: JsonObject = {};
  private libraries: Map<string, BenchmarkLibrary> = new Map();
  private defaultTrackCode = "";
  private readonly registryPath: string;
  private readonly libraryDirectory: string;

  constructor(
    private readonly database: AppDatabase,
    registryPath: string,
    libraryDirectory: string
  ) {
    this.registryPath = registryPath;
    this.libraryDirectory = libraryDirectory;
    this.reload();
  }

  reload(): void {
    this.registry = readJsonObject(this.registryPath, "标杆样本库注册表");
    const entries = objectArray(this.registry.libraries);
    if (entries.length === 0) throw new Error("标杆样本库注册表不能为空");
    this.defaultTrackCode = optionalString(this.registry.default_track_code) ?? requiredString(entries[0]?.track_code, "libraries.track_code");
    const libraries = new Map<string, BenchmarkLibrary>();
    for (const entry of entries) {
      const trackCode = requiredString(entry.track_code, "libraries.track_code");
      const catalog = readJsonObject(path.resolve(this.libraryDirectory, requiredString(entry.source_catalog_path, "libraries.source_catalog_path")), `${trackCode}数据源目录`);
      const sources = objectArray(catalog.sources);
      if (!Array.isArray(catalog.sources)) throw new Error(`${trackCode}数据源目录必须是数组`);
      const methodology = readJsonObject(path.resolve(this.libraryDirectory, requiredString(entry.methodology_path, "libraries.methodology_path")), `${trackCode}样本方法`);
      const seed = readJsonObject(path.resolve(this.libraryDirectory, requiredString(entry.seed_path, "libraries.seed_path")), `${trackCode}样本种子`);
      const industry = isJsonObject(catalog.industry) ? catalog.industry : {};
      const track = isJsonObject(catalog.track) ? catalog.track : {};
      libraries.set(trackCode, {
        industryCode: optionalString(entry.industry_code) ?? String(industry.code ?? ""),
        industryName: optionalString(entry.industry_name) ?? String(industry.name ?? ""),
        trackCode,
        trackName: optionalString(entry.track_name) ?? String(track.name ?? trackCode),
        catalog,
        sources,
        methodology,
        seed
      });
    }
    this.libraries = libraries;
    for (const library of this.libraries.values()) this.seedLibrary(library);
  }

  listLibraries(): JsonObject {
    return {
      schema_version: this.registry.schema_version ?? "1.0.0",
      registry_version: this.registry.registry_version ?? "1.0.0",
      default_track_code: this.defaultTrackCode,
      libraries: [...this.libraries.values()].map((library) => ({
        industry: { code: library.industryCode, name: library.industryName },
        track: { code: library.trackCode, name: library.trackName },
        source_count: library.sources.length,
        outcome_dimension_count: objectArray(library.methodology.outcome_dimensions).length,
        sample_count: this.database.listBenchmarkSamples({ trackCode: library.trackCode }).length
      })),
      governance: this.registry.governance ?? null
    };
  }

  getMethodology(trackCode = this.defaultTrackCode): JsonObject {
    return this.requireLibrary(trackCode).methodology;
  }

  listSources(trackCode = this.defaultTrackCode): JsonObject {
    const library = this.requireLibrary(trackCode);
    const catalog = library.catalog;
    return {
      schema_version: catalog.schema_version ?? "1.0.0",
      catalog_version: catalog.catalog_version ?? "1.0.0",
      industry: catalog.industry ?? { code: library.industryCode, name: library.industryName },
      track: catalog.track ?? { code: library.trackCode, name: library.trackName },
      governance: catalog.governance ?? null,
      sources: library.sources,
      source_count: library.sources.length
    };
  }

  getSource(trackCode: string, sourceCode: string): JsonObject {
    const library = this.requireLibrary(trackCode);
    const source = library.sources.find((item) => item.code === sourceCode);
    if (!source) throw new ServiceError("当前赛道不存在该数据来源", 400, { track_code: trackCode, source_code: sourceCode });
    return source;
  }

  listSamples(query: { trackCode?: string; sampleType?: string }): JsonObject {
    const trackCode = query.trackCode ?? this.defaultTrackCode;
    const library = this.findLibrary(trackCode);
    const sampleType = query.sampleType && SAMPLE_TYPES.includes(query.sampleType as typeof SAMPLE_TYPES[number])
      ? query.sampleType
      : undefined;
    if (!library) {
      return {
        track_code: trackCode,
        library_available: false,
        samples: [],
        summary: this.coverageSummary([], null),
        safeguards: this.safeguards(),
        notice: "当前赛道尚未建立独立样本库，请先登记数据源、样本种子和方法论。"
      };
    }
    const samples = this.database.listBenchmarkSamples({
      trackCode,
      ...(sampleType ? { sampleType } : {})
    }).map((sample) => this.sampleSummary(sample));
    return {
      track_code: trackCode,
      library_available: true,
      library: this.libraryInfo(library),
      samples,
      summary: this.coverageSummary(samples, library.methodology),
      safeguards: this.safeguards()
    };
  }

  getCohortAnalysis(trackCode = this.defaultTrackCode): JsonObject {
    const library = this.findLibrary(trackCode);
    if (!library) {
      return {
        track_code: trackCode,
        library_available: false,
        analysis_mode: "unavailable",
        evidence_scope: "verified_only",
        cohort_counts: { benchmark: 0, control: 0, risk: 0 },
        approved_cohort_counts: { benchmark: 0, control: 0, risk: 0 },
        verified_evidence_count: 0,
        matrix: [],
        template_suggestions: [],
        readiness: { approved_cohort_ready: false, template_change_allowed: false, missing_approved_samples: {} },
        safeguards: this.safeguards(),
        notice: "当前赛道尚未建立独立样本库，暂不能生成样本差异矩阵。"
      };
    }
    const methodology = library.methodology;
    const samples = this.database.listBenchmarkSamples({ trackCode })
      .filter((sample) => sample.sample_type !== "internal_candidate");
    const dimensions = objectArray(methodology.outcome_dimensions);
    const verifiedEvidence = samples.flatMap((sample) => this.database.listBenchmarkEvidence(sample.id)
      .filter((item) => item.review_status === "verified")
      .map((item) => ({ sample, evidence: item, dimension: classifyOutcomeDimension(item, dimensions) }))
      .filter((item) => item.dimension));
    const cohortCounts = Object.fromEntries(["benchmark", "control", "risk"].map((type) => [
      type, samples.filter((sample) => sample.sample_type === type).length
    ]));
    const approvedCounts = Object.fromEntries(["benchmark", "control", "risk"].map((type) => [
      type, samples.filter((sample) => sample.sample_type === type && sample.status === "approved").length
    ]));
    const minimum = isJsonObject(methodology.minimum_pilot_cohort) ? methodology.minimum_pilot_cohort : {};
    const cohortReady = ["benchmark", "control", "risk"].every((type) => (
      Number(cohortCounts[type] ?? 0) >= Number(minimum[type] ?? 0)
    )) && verifiedEvidence.length > 0;

    const matrix = dimensions.map((dimension) => {
      const code = String(dimension.code);
      const related = verifiedEvidence.filter((item) => item.dimension === code);
      const cohort = Object.fromEntries(["benchmark", "control", "risk"].map((type) => {
        const cohortEvidence = related.filter((item) => item.sample.sample_type === type);
        const sampleIds = new Set(cohortEvidence.map((item) => item.sample.id));
        const positiveIds = new Set(cohortEvidence.filter((item) => evidenceDirection(item.evidence) === "positive").map((item) => item.sample.id));
        const negativeIds = new Set(cohortEvidence.filter((item) => evidenceDirection(item.evidence) === "negative").map((item) => item.sample.id));
        const denominator = Number(cohortCounts[type] ?? 0);
        return [type, {
          sample_count: denominator,
          covered_sample_count: sampleIds.size,
          positive_sample_count: positiveIds.size,
          negative_sample_count: negativeIds.size,
          verified_evidence_count: cohortEvidence.length,
          coverage_rate: denominator ? round2(sampleIds.size / denominator) : 0,
          positive_rate: denominator ? round2(positiveIds.size / denominator) : 0,
          negative_rate: denominator ? round2(negativeIds.size / denominator) : 0
        }];
      }));
      const benchmarkRate = Number((cohort.benchmark as JsonObject).positive_rate ?? 0);
      const controlRate = Number((cohort.control as JsonObject).positive_rate ?? 0);
      const riskNegativeRate = Number((cohort.risk as JsonObject).negative_rate ?? 0);
      const verifiedCount = related.length;
      const classification = verifiedCount < 3 ? "insufficient_evidence"
        : benchmarkRate - controlRate >= 0.15 ? "potential_differentiator"
          : riskNegativeRate >= 0.25 ? "risk_guardrail"
            : "common_or_unclear";
      return {
        dimension_code: code,
        dimension_name: String(dimension.name),
        reference_examples: stringArray(dimension.examples),
        cohort,
        benchmark_vs_control_delta: round2(benchmarkRate - controlRate),
        risk_negative_rate: riskNegativeRate,
        verified_evidence_count: verifiedCount,
        classification,
        interpretation: matrixInterpretation(classification, verifiedCount)
      };
    });

    const suggestions = matrix
      .filter((item) => item.classification === "potential_differentiator" || item.classification === "risk_guardrail")
      .map((item) => ({
        suggestion_id: `cohort:${item.dimension_code}:${item.classification}`,
        dimension_code: item.dimension_code,
        dimension_name: item.dimension_name,
        suggestion_type: item.classification === "potential_differentiator"
          ? "scoring_dimension_candidate" : "risk_constraint_candidate",
        proposed_action: item.classification === "potential_differentiator"
          ? "考虑补充评分子指标和对应证据要求，不建议仅凭当前结果直接增加权重。"
          : "考虑增加负向评分锚点；涉及IP合规或治理时再由人工判断是否升级为投资门槛。",
        evidence_basis: {
          verified_evidence_count: item.verified_evidence_count,
          benchmark_vs_control_delta: item.benchmark_vs_control_delta,
          risk_negative_rate: item.risk_negative_rate
        },
        dimension_draft: buildSuggestedDimensionDraft(item),
        status: "candidate_only",
        ready_for_template_change: cohortReady,
        human_approval_required: true
      }));

    return {
      track_code: trackCode,
      library_available: true,
      library: this.libraryInfo(library),
      analysis_mode: cohortReady ? "verified_evidence_reference" : "provisional_preview",
      evidence_scope: "verified_only",
      cohort_counts: cohortCounts,
      approved_cohort_counts: approvedCounts,
      verified_evidence_count: verifiedEvidence.length,
      matrix,
      template_suggestions: suggestions,
      readiness: {
        sample_cohort_ready: cohortReady,
        template_change_allowed: cohortReady && suggestions.length > 0,
        missing_samples: Object.fromEntries(["benchmark", "control", "risk"].map((type) => [
          type, Math.max(0, Number(minimum[type] ?? 0) - Number(cohortCounts[type] ?? 0))
        ]))
      },
      safeguards: {
        pending_or_rejected_evidence_excluded: true,
        company_fact_is_not_automatic_leader_attribution: true,
        suggestions_do_not_modify_template: true,
        human_approval_and_version_history_required: true
      },
      notice: cohortReady
        ? "样本分组和已复核证据达到参考条件；建议仍需在最终模板检查中由人工决定是否采用。"
        : "当前仅为预览矩阵；样本数量或已复核证据不足，不阻断模板检查和发布。"
    } as unknown as JsonObject;
  }

  getSample(id: string): JsonObject {
    const sample = this.database.getBenchmarkSample(id);
    if (!sample) throw new ServiceError("未找到标杆样本", 404);
    return {
      sample,
      evidence: this.database.listBenchmarkEvidence(id),
      evidence_reviews: this.database.listBenchmarkEvidenceReviews(id),
      trait_hypotheses: this.database.listBenchmarkTraits(id),
      notice: "样本事实、证据完整度、特质假设和模板规则相互独立；未经人工批准的特质不得进入正式模板。"
    } as unknown as JsonObject;
  }

  getSampleByKey(sampleKey: string): JsonObject | null {
    const sample = this.database.getBenchmarkSampleByKey(sampleKey);
    return sample ? this.getSample(sample.id) : null;
  }

  createSample(body: unknown): JsonObject {
    const input = requireObject(body);
    const sampleType = allowedValue(input.sample_type, SAMPLE_TYPES, "sample_type");
    const status = allowedValue(input.status ?? "collecting", SAMPLE_STATUSES, "status");
    const trackCode = optionalString(input.track_code) ?? this.defaultTrackCode;
    const library = this.requireLibrary(trackCode);
    const catalogIndustry = isJsonObject(library.catalog.industry) ? library.catalog.industry : {};
    const sample = this.database.createBenchmarkSample({
      sampleKey: requiredString(input.sample_key, "sample_key"),
      sampleType,
      personName: requiredString(input.person_name, "person_name"),
      personRole: requiredString(input.person_role, "person_role"),
      organizationName: requiredString(input.organization_name, "organization_name"),
      industryCode: optionalString(input.industry_code) ?? library.industryCode ?? String(catalogIndustry.code ?? ""),
      trackCode,
      jurisdiction: requiredString(input.jurisdiction, "jurisdiction"),
      organizationStage: requiredString(input.organization_stage, "organization_stage"),
      observationDate: requiredDate(input.observation_date, "observation_date"),
      status,
      summary: optionalString(input.summary),
      metadata: isJsonObject(input.metadata) ? input.metadata : {}
    });
    return { sample, human_review_required: true } as unknown as JsonObject;
  }

  addEvidence(sampleId: string, body: unknown): JsonObject {
    const input = requireObject(body);
    const sample = this.database.getBenchmarkSample(sampleId);
    if (!sample) throw new ServiceError("未找到标杆样本", 404);
    const library = this.requireLibrary(sample.track_code);
    const sourceCode = requiredString(input.source_code, "source_code");
    const source = library.sources.find((item) => item.code === sourceCode);
    if (!source) throw new ServiceError("未知或未批准的数据来源", 400);
    const collectionMethod = requiredString(input.collection_method, "collection_method");
    const allowedMethods = stringArray(source.allowed_methods);
    if (!allowedMethods.includes(collectionMethod)) {
      throw new ServiceError(`采集方式不在${String(source.name)}的允许清单中`, 400, { allowed_methods: allowedMethods });
    }
    const evidence = this.database.createBenchmarkEvidence({
      sampleId,
      fieldKey: requiredString(input.field_key, "field_key"),
      title: requiredString(input.title, "title"),
      value: (input.value ?? null) as JsonValue,
      sourceCode,
      sourceName: optionalString(input.source_name) ?? String(source.name),
      sourceUrl: requiredString(input.source_url, "source_url"),
      sourceLocator: optionalString(input.source_locator),
      publisherType: requiredString(input.publisher_type, "publisher_type"),
      publicationDate: optionalDate(input.publication_date, "publication_date"),
      observedAt: requiredDate(input.observed_at, "observed_at"),
      collectionMethod,
      accessBasis: requiredString(input.access_basis, "access_basis"),
      qualityScore: boundedNumber(input.quality_score, "quality_score", 0, 1),
      confidence: allowedValue(input.confidence, CONFIDENCE_LEVELS, "confidence"),
      reviewStatus: allowedValue(input.review_status ?? "pending", REVIEW_STATUSES, "review_status"),
      collectedBy: requiredString(input.collected_by, "collected_by")
    });
    return {
      evidence,
      fact_only: true,
      trait_inference_created: false,
      human_review_required: evidence.review_status === "pending"
    } as unknown as JsonObject;
  }

  reviewEvidence(sampleId: string, evidenceId: string, body: unknown): JsonObject {
    const input = requireObject(body);
    const reviewer = requiredString(input.reviewer, "reviewer");
    const reason = requiredString(input.reason, "reason", 4);
    const decision = allowedValue(input.decision, REVIEW_DECISIONS, "decision");
    let result;
    try {
      result = this.database.reviewBenchmarkEvidence({ sampleId, evidenceId, decision, reviewer, reason });
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw new ServiceError("未找到待复核的样本或证据", 404);
      }
      if (error instanceof Error && error.message.includes("does not belong")) {
        throw new ServiceError("证据不属于当前样本", 400);
      }
      throw error;
    }
    return {
      ...result,
      human_action_recorded: true,
      automatic_decision: false,
      notice: "复核结果仅更新证据状态，不会自动批准样本、生成特质或修改模板。"
    } as unknown as JsonObject;
  }

  listReviewQueue(trackCode = this.defaultTrackCode): JsonObject {
    const samples = this.database.listBenchmarkSamples({ trackCode });
    const allPending: JsonObject[] = [];
    const documents = new Map<string, { document_key: string; source_name: string; source_url: string; evidence_ids: string[]; sample_names: string[]; priority: number; review_mode: string }>();
    let sampledOut = 0;
    for (const sample of samples) {
      const evidence = this.database.listBenchmarkEvidence(sample.id);
      evidence.forEach((item, index) => {
        if (item.review_status !== "pending") return;
        const risk = evidenceRisk(item, sample.sample_type);
        const sampled = risk.level === "low" && stableSample(item.id, index) % 3 !== 0;
        if (sampled) {
          sampledOut += 1;
          return;
        }
        const documentKey = item.source_url || `${item.source_code}:${item.source_name}`;
        const existing = documents.get(documentKey) ?? {
          document_key: documentKey,
          source_name: item.source_name,
          source_url: item.source_url,
          evidence_ids: [],
          sample_names: [],
          priority: 0,
          review_mode: "batch_review"
        };
        existing.evidence_ids.push(item.id);
        if (!existing.sample_names.includes(sample.person_name)) existing.sample_names.push(sample.person_name);
        existing.priority = Math.max(existing.priority, risk.priority);
        documents.set(documentKey, existing);
        allPending.push({
          evidence_id: item.id,
          sample_id: sample.id,
          sample_name: sample.person_name,
          sample_type: sample.sample_type,
          title: item.title,
          field_key: item.field_key,
          source_name: item.source_name,
          source_url: item.source_url,
          document_key: documentKey,
          risk_level: risk.level,
          risk_score: risk.score,
          priority: risk.priority,
          review_mode: risk.level === "high" ? "required_review" : "batch_or_sample_review",
          review_reason: risk.reason
        });
      });
    }
    allPending.sort((a, b) => Number(b.priority) - Number(a.priority) || String(a.sample_name).localeCompare(String(b.sample_name), "zh-CN"));
    const queue = allPending;
    return {
      track_code: trackCode,
      library_available: Boolean(this.findLibrary(trackCode)),
      queue,
      documents: [...documents.values()].sort((a, b) => b.priority - a.priority),
      summary: {
        pending_evidence_count: samples.reduce((sum, sample) => sum + this.database.listBenchmarkEvidence(sample.id).filter((item) => item.review_status === "pending").length, 0),
        required_review_count: queue.length,
        sampled_out_count: sampledOut,
        document_count: documents.size,
        high_risk_count: queue.filter((item) => item.risk_level === "high").length,
        batch_review_available: queue.length > 0
      },
      policy: {
        automatic_status_is_not_human_review: true,
        high_risk_requires_human_review: true,
        low_risk_sampling_ratio: "1/3",
        sampled_out_items_remain_pending: true,
        batch_review_still_requires_reviewer_and_reason: true
      }
    } as unknown as JsonObject;
  }

  reviewQueueBatch(body: unknown): JsonObject {
    const input = requireObject(body);
    const evidenceIds = Array.isArray(input.evidence_ids)
      ? input.evidence_ids.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    if (evidenceIds.length === 0) throw new ServiceError("evidence_ids不能为空", 400);
    const reviewer = requiredString(input.reviewer, "reviewer");
    const reason = requiredString(input.reason, "reason", 4);
    const decision = allowedValue(input.decision, REVIEW_DECISIONS, "decision");
    try {
      const result = this.database.reviewBenchmarkEvidenceBatch({ evidenceIds, decision, reviewer, reason });
      return {
        ...result,
        reviewed_count: result.evidence.length,
        human_action_recorded: true,
        automatic_decision: false,
        notice: "批量复核仅更新选中的证据状态，不会自动批准样本、生成特质或修改模板。"
      } as unknown as JsonObject;
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        throw new ServiceError("复核队列中存在不存在的证据", 404);
      }
      throw error;
    }
  }

  private seedLibrary(library: BenchmarkLibrary): void {
    const seedTrackCode = optionalString(library.seed.track_code);
    if (seedTrackCode && seedTrackCode !== library.trackCode) {
      throw new Error(`样本种子赛道与注册表不一致: ${seedTrackCode} != ${library.trackCode}`);
    }
    for (const item of objectArray(library.seed.samples)) {
      const sample = this.database.createBenchmarkSample({
        sampleKey: requiredString(item.sample_key, "seed.sample_key"),
        sampleType: allowedValue(item.sample_type, SAMPLE_TYPES, "seed.sample_type"),
        personName: requiredString(item.person_name, "seed.person_name"),
        personRole: requiredString(item.person_role, "seed.person_role"),
        organizationName: requiredString(item.organization_name, "seed.organization_name"),
        industryCode: requiredString(item.industry_code, "seed.industry_code"),
        trackCode: requiredString(item.track_code, "seed.track_code"),
        jurisdiction: requiredString(item.jurisdiction, "seed.jurisdiction"),
        organizationStage: requiredString(item.organization_stage, "seed.organization_stage"),
        observationDate: requiredDate(item.observation_date, "seed.observation_date"),
        status: allowedValue(item.status, SAMPLE_STATUSES, "seed.status"),
        summary: optionalString(item.summary),
        metadata: isJsonObject(item.metadata) ? item.metadata : {}
      });
      for (const evidence of objectArray(item.evidence)) this.seedEvidence(sample.id, evidence, library.sources);
    }
  }

  private seedEvidence(sampleId: string, item: JsonObject, sources: JsonObject[]): BenchmarkEvidenceRecord {
    const sourceCode = requiredString(item.source_code, "seed.evidence.source_code");
    const collectionMethod = requiredString(item.collection_method, "seed.evidence.collection_method");
    const source = sources.find((candidate) => candidate.code === sourceCode);
    if (!source) throw new Error(`标杆样本种子使用了未知数据来源: ${sourceCode}`);
    if (!stringArray(source.allowed_methods).includes(collectionMethod)) {
      throw new Error(`样本种子的采集方式不在${String(source.name)}允许清单中: ${collectionMethod}`);
    }
    return this.database.createBenchmarkEvidence({
      sampleId,
      fieldKey: requiredString(item.field_key, "seed.evidence.field_key"),
      title: requiredString(item.title, "seed.evidence.title"),
      value: (item.value ?? null) as JsonValue,
      sourceCode,
      sourceName: requiredString(item.source_name, "seed.evidence.source_name"),
      sourceUrl: requiredString(item.source_url, "seed.evidence.source_url"),
      sourceLocator: optionalString(item.source_locator),
      publisherType: requiredString(item.publisher_type, "seed.evidence.publisher_type"),
      publicationDate: optionalDate(item.publication_date, "seed.evidence.publication_date"),
      observedAt: requiredDate(item.observed_at, "seed.evidence.observed_at"),
      collectionMethod,
      accessBasis: requiredString(item.access_basis, "seed.evidence.access_basis"),
      qualityScore: boundedNumber(item.quality_score, "seed.evidence.quality_score", 0, 1),
      confidence: allowedValue(item.confidence, CONFIDENCE_LEVELS, "seed.evidence.confidence"),
      reviewStatus: allowedValue(item.review_status, REVIEW_STATUSES, "seed.evidence.review_status"),
      collectedBy: requiredString(item.collected_by, "seed.evidence.collected_by")
    });
  }

  private sampleSummary(sample: BenchmarkSampleRecord): JsonObject {
    const evidence = this.database.listBenchmarkEvidence(sample.id);
    const traits = this.database.listBenchmarkTraits(sample.id);
    const cohortRule = this.cohortRule(sample.sample_type, this.findLibrary(sample.track_code)?.methodology ?? null);
    const minimumEvidence = Number(cohortRule?.minimum_evidence ?? 0);
    const minimumSourceCategories = Number(cohortRule?.minimum_independent_source_categories ?? 0);
    const sourceCategoryCount = new Set(evidence.map((item) => item.source_code)).size;
    return {
      ...sample,
      evidence_count: evidence.length,
      verified_evidence_count: evidence.filter((item) => item.review_status === "verified").length,
      source_count: sourceCategoryCount,
      minimum_evidence_required: minimumEvidence,
      minimum_source_categories_required: minimumSourceCategories,
      evidence_gap: Math.max(0, minimumEvidence - evidence.length),
      source_category_gap: Math.max(0, minimumSourceCategories - sourceCategoryCount),
      nomination_evidence_complete: minimumEvidence > 0
        && evidence.length >= minimumEvidence
        && sourceCategoryCount >= minimumSourceCategories,
      trait_hypothesis_count: traits.length,
      approved_trait_count: traits.filter((item) => item.review_status === "approved").length
    } as unknown as JsonObject;
  }

  private coverageSummary(samples: JsonObject[], methodology: JsonObject | null): JsonObject {
    const count = (type: string) => samples.filter((item) => item.sample_type === type).length;
    const approvedSampleCount = samples.filter((item) => item.status === "approved").length;
    const verifiedEvidenceCount = samples.reduce((sum, item) => sum + Number(item.verified_evidence_count ?? 0), 0);
    const cohortStructureComplete = count("benchmark") > 0 && count("control") > 0 && count("risk") > 0;
    const pilot = methodology && isJsonObject(methodology.minimum_pilot_cohort)
      ? methodology.minimum_pilot_cohort
      : {};
    const cohortGaps = {
      benchmark: Math.max(0, Number(pilot.benchmark ?? 0) - count("benchmark")),
      control: Math.max(0, Number(pilot.control ?? 0) - count("control")),
      risk: Math.max(0, Number(pilot.risk ?? 0) - count("risk"))
    };
    const pilotCohortCountComplete = Object.values(cohortGaps).every((gap) => gap === 0);
    return {
      sample_count: samples.length,
      benchmark_count: count("benchmark"),
      control_count: count("control"),
      risk_count: count("risk"),
      internal_candidate_count: count("internal_candidate"),
      evidence_count: samples.reduce((sum, item) => sum + Number(item.evidence_count ?? 0), 0),
      approved_sample_count: approvedSampleCount,
      cohort_structure_complete: cohortStructureComplete,
      pilot_cohort_gaps: cohortGaps,
      pilot_cohort_count_complete: pilotCohortCountComplete,
      evidence_complete_sample_count: samples.filter((item) => item.nomination_evidence_complete === true).length,
      ready_for_template_learning: pilotCohortCountComplete && verifiedEvidenceCount > 0
    };
  }

  private cohortRule(sampleType: string, methodology: JsonObject | null): JsonObject | null {
    if (sampleType === "internal_candidate" || !methodology || !isJsonObject(methodology.cohort_rules)) return null;
    const rule = methodology.cohort_rules[sampleType];
    return isJsonObject(rule) ? rule : null;
  }

  private findLibrary(trackCode: string): BenchmarkLibrary | null {
    return this.libraries.get(trackCode) ?? null;
  }

  private requireLibrary(trackCode: string): BenchmarkLibrary {
    const library = this.findLibrary(trackCode);
    if (!library) throw new ServiceError(`当前赛道尚未建立样本库: ${trackCode}`, 404, { track_code: trackCode });
    return library;
  }

  private libraryInfo(library: BenchmarkLibrary): JsonObject {
    return {
      industry: { code: library.industryCode, name: library.industryName },
      track: { code: library.trackCode, name: library.trackName }
    };
  }

  private safeguards(): JsonObject {
    return {
      benchmark_status_is_not_automatic: true,
      trait_inference_requires_evidence: true,
      template_rule_changes_require_human_approval: true,
      sensitive_fields_excluded: true,
      sample_approval_feature: false
    };
  }
}

function readJsonObject(filePath: string, name: string): JsonObject {
  if (!fs.existsSync(filePath)) throw new Error(`${name}不存在: ${filePath}`);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isJsonObject(value)) throw new Error(`${name}必须是JSON对象`);
  return value;
}

function requireObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new ServiceError("请求体必须是JSON对象", 400);
  return value;
}

function objectArray(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function requiredString(value: unknown, field: string, minimumLength = 2): string {
  if (typeof value !== "string" || value.trim().length < minimumLength) {
    throw new ServiceError(`${field}至少需要${minimumLength}个字符`, 400);
  }
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requiredDate(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(result)) throw new ServiceError(`${field}必须是ISO日期`, 400);
  return result;
}

function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") return null;
  return requiredDate(value, field);
}

function boundedNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw new ServiceError(`${field}必须在${min}到${max}之间`, 400);
  }
  return value;
}

function allowedValue<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value as T[number])) {
    throw new ServiceError(`${field}必须是${allowed.join("、")}之一`, 400);
  }
  return value as T[number];
}

function evidenceRisk(item: BenchmarkEvidenceRecord, sampleType: string): { level: "high" | "medium" | "low"; score: number; priority: number; reason: string } {
  const field = item.field_key.toLowerCase();
  const critical = /copyright|integrity|conflict|compliance|litigation|legal|enforcement|financial_risk|cash|gate/.test(field);
  if (critical || sampleType === "risk") return { level: "high", score: 0.95, priority: 3, reason: "涉及投资门槛、风险或反向约束，必须人工复核" };
  if (item.source_code === "public_media_and_interviews" || item.source_code === "licensed_commercial_data") {
    return { level: "medium", score: 0.65, priority: 2, reason: "来源需要核对出处、上下文与是否为二手转述" };
  }
  if (item.source_code === "company_official_channels" || field.startsWith("leader.")) {
    return { level: "medium", score: 0.55, priority: 2, reason: "涉及负责人或公司一方表述，建议人工批量核验" };
  }
  return { level: "low", score: 0.25, priority: 1, reason: "官方披露的一般经营事实，可抽样复核" };
}

function stableSample(value: string, index: number): number {
  let hash = index + 17;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) % 1000003;
  return hash;
}

function classifyOutcomeDimension(item: BenchmarkEvidenceRecord, dimensions: JsonObject[]): string | null {
  const text = `${item.field_key} ${item.title} ${typeof item.value === "string" ? item.value : JSON.stringify(item.value)}`.toLowerCase();
  const available = new Set(dimensions.map((dimension) => String(dimension.code)));
  const matches = [
    ["ip_and_compliance", /copyright|\bip\b|compliance|filing|license|备案|许可|版权|合规|内容安全|模型授权/u],
    ["unit_economics", /unit|cost|revenue|profit|loss|cash|margin|payback|gmv|成本|收入|利润|亏损|现金|回收|毛利/u],
    ["distribution_and_commercialization", /distribution|platform|overseas|commercial|channel|localization|发行|渠道|平台|出海|海外|商业化|本地化/u],
    ["production_system", /production|pipeline|workflow|cycle|efficien|ai_|aigc|制作|生产|流程|周期|效率|工业化|生成式/u],
    ["content_output", /output|content|slate|retention|completion|hit|short_drama|作品|内容|片单|完播|留存|爆款|短剧/u],
    ["organization_and_governance", /leader|team|governance|control|organization|role|internal|负责人|团队|治理|内控|组织|控制权|任职/u],
    ["product_value_and_use_case", /user|use_case|adoption|value|用户|场景|采用|需求|产品|授权意愿/u],
    ["agent_capability_and_reliability", /agent|task|reliab|model|tool|eval|observab|智能体|任务|可靠|模型|工具|评测|监控|异常/u],
    ["commerce_integration_and_interoperability", /merchant|protocol|interoper|fulfillment|integration|商户|协议|互操作|履约|接口|库存|对账/u],
    ["authorization_security_and_auditability", /authoriz|security|audit|dispute|permission|credential|授权|安全|审计|争议|权限|凭证|越权/u],
    ["commercialization_and_unit_economics", /unit|cost|revenue|profit|loss|cash|margin|payback|gmv|成本|收入|利润|亏损|现金|回收|毛利|付费|回款|退款/u],
    ["ecosystem_data_and_defensibility", /ecosystem|data|defens|switching|生态|数据|壁垒|迁移|合作网络|反馈闭环/u],
    ["team_leadership_and_scaling", /leader|team|governance|organization|role|负责人|团队|治理|组织|规模化|招聘|里程碑/u]
  ] as const;
  for (const [code, pattern] of matches) if (available.has(code) && pattern.test(text)) return code;
  return null;
}

function evidenceDirection(item: BenchmarkEvidenceRecord): "positive" | "negative" | "neutral" {
  const text = `${item.field_key} ${item.title} ${typeof item.value === "string" ? item.value : JSON.stringify(item.value)}`.toLowerCase();
  if (/loss|decline|overdue|risk|defect|weakness|violation|investigation|lawsuit|auction|亏损|下降|逾期|风险|缺陷|违规|调查|诉讼|拍卖|待验证|尚未/u.test(text)) return "negative";
  if (/current_role|任职|董事长|chief executive|负责人职责/u.test(text)) return "neutral";
  return "positive";
}

function matrixInterpretation(classification: string, verifiedCount: number): string {
  if (classification === "insufficient_evidence") return `仅有${verifiedCount}条已复核证据，暂不能进行跨组归因。`;
  if (classification === "potential_differentiator") return "标杆组正向覆盖率高于普通对照，可作为候选差异能力继续核验。";
  if (classification === "risk_guardrail") return "风险组负向信号较集中，可作为候选风险约束继续核验。";
  return "各组差异尚不清晰，可能是行业共性或需要更多样本。";
}

function buildSuggestedDimensionDraft(item: {
  dimension_code: string;
  dimension_name: string;
  reference_examples: string[];
  classification: string;
  interpretation: string;
}): JsonObject {
  const examples = item.reference_examples.length >= 2
    ? item.reference_examples.slice(0, 4)
    : ["持续经营表现", "可复制能力"];
  const questionByCode: Record<string, string> = {
    content_output: "候选负责人能否持续形成适配AI短剧渠道的内容产出，并用多期数据证明命中表现？",
    unit_economics: "候选负责人能否建立可持续的单剧经济模型，并控制成本、回收周期和现金风险？",
    production_system: "候选负责人能否建立可复制的AI短剧工业化生产体系，并持续提升效率和质量？",
    ip_and_compliance: "候选负责人能否建立完整的IP、模型、素材和内容合规管理机制？",
    distribution_and_commercialization: "候选负责人能否建立多渠道发行和可持续商业化能力，并降低单一平台依赖？",
    organization_and_governance: "候选负责人能否建立与规模化生产相匹配的组织、治理和风险控制体系？",
    product_value_and_use_case: "候选负责人能否证明智能体解决高频商业任务，并获得用户持续授权和重复使用？",
    agent_capability_and_reliability: "候选负责人能否建立稳定、可观测并可处理异常的智能体任务执行体系？",
    commerce_integration_and_interoperability: "候选负责人能否以可维护方式连接商户、订单、履约和协议生态？",
    authorization_security_and_auditability: "候选负责人能否建立可验证授权、交易安全和完整审计追踪机制？",
    commercialization_and_unit_economics: "候选负责人能否证明收入可重复，并在模型、支付、客服和履约成本后保持合理单位经济？",
    ecosystem_data_and_defensibility: "候选负责人能否在合法边界内形成数据反馈、生态合作和可持续竞争壁垒？",
    team_leadership_and_scaling: "候选负责人能否协调产品、工程、安全、商业和合规团队完成规模化？"
  };
  return {
    name: item.dimension_name,
    suggested_weight: 5,
    investment_question: questionByCode[item.dimension_code] ?? `候选负责人是否具备可核查、可持续的${item.dimension_name}？`,
    sub_indicators: examples.map((name, index) => ({
      name,
      question: `请核验候选团队在“${name}”方面是否形成可持续、可复核的结果。`,
      order: index + 1
    })),
    required_evidence: [
      ...examples.map((name) => `${name}的原始记录或连续经营数据`),
      "至少两个独立来源的交叉验证材料"
    ],
    verification_methods: ["核对原始合同、后台数据、财务或运营底表", "与官方披露、平台数据或第三方材料交叉验证", "检查至少两个观察期的一致性"],
    anchors: [
      { score: 1, description: `缺少${item.dimension_name}的可核查结果，或存在明确反向证据。` },
      { score: 2, description: `仅有零散案例或计划性描述，${item.dimension_name}尚未形成稳定机制。` },
      { score: 3, description: `已形成基本方法和部分结果，但连续性、独立来源或规模化证据不足。` },
      { score: 4, description: `具有多期可核查结果和明确复盘机制，${item.dimension_name}能够稳定支持规模化经营。` },
      { score: 5, description: `形成可复制的方法体系，经多个项目和独立来源持续验证，并能带动组织稳定执行。` }
    ],
    reference_note: `${item.interpretation} 当前建议类型为${item.classification === "potential_differentiator" ? "候选差异能力" : "候选风险约束"}，仅供人工新增维度时参考。`
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
