import { createHash } from "node:crypto";
import type {
  EvaluationEvidenceItemRecord,
  EvaluationGateResultRecord,
  EvaluationTemplate,
  JsonObject,
  JsonValue
} from "../domain/types.js";
import { AppDatabase } from "../db/database.js";
import { isJsonObject } from "../lib/json.js";
import { parseEvidenceFile, type ParsedEvidenceItem } from "./evidence-file-parser.js";
import {
  analyzeEvidence,
  type EvidenceConflict,
  type EvidenceDiagnosticsResult
} from "./evidence-diagnostics.js";
import { ServiceError } from "./template-service.js";

const ENGINE_VERSION = "transparent-rules-v2-quality-conflicts";

export const OFFICIAL_DATA_SOURCES = [
  {
    code: "national_enterprise_credit",
    name: "国家企业信用信息公示系统",
    url: "https://www.gsxt.gov.cn/",
    import_mode: "manual_export",
    note: "需要按官网要求实名查询；本系统不绕过登录、验证码或反爬限制。"
  },
  {
    code: "court_enforcement",
    name: "中国执行信息公开网",
    url: "https://zxgk.court.gov.cn/",
    import_mode: "manual_export",
    note: "由尽调人员在官方页面核验后导入查询结果或截图整理表。"
  },
  {
    code: "cnipa_ip_data",
    name: "国家知识产权局公共服务平台",
    url: "https://ggfw.cnipa.gov.cn/",
    import_mode: "download_or_registered_api",
    note: "支持公开检索、数据下载及按官方规则申请数据接口。"
  }
] as const;

export class DataIntelligenceService {
  constructor(private readonly database: AppDatabase) {}

  listOfficialSources(): JsonObject {
    return { sources: OFFICIAL_DATA_SOURCES } as unknown as JsonObject;
  }

  async importFile(taskId: string, input: {
    fileName: string;
    mediaType: string;
    buffer: Buffer;
    importedBy: string;
    officialSourceCode?: string | null;
    sourceUrl?: string | null;
  }): Promise<JsonObject> {
    this.requireMutableTask(taskId);
    if (input.buffer.byteLength > 10 * 1024 * 1024) throw new ServiceError("单个文件不能超过10MB", 413);
    const parsed = await parseEvidenceFile(input.fileName, input.buffer);
    const official = input.officialSourceCode
      ? OFFICIAL_DATA_SOURCES.find((item) => item.code === input.officialSourceCode)
      : null;
    if (input.officialSourceCode && !official) throw new ServiceError("未知的官方数据来源", 400);
    const record = this.database.createDataImport({
      taskId,
      sourceType: official ? "official_public" : "local_file",
      sourceName: official?.name ?? input.fileName,
      fileName: input.fileName,
      mediaType: input.mediaType || "application/octet-stream",
      sourceUrl: input.sourceUrl ?? official?.url ?? null,
      officialSourceCode: official?.code ?? null,
      metadata: parsed.metadata,
      sha256: createHash("sha256").update(input.buffer).digest("hex"),
      importedBy: requiredString(input.importedBy, "imported_by"),
      evidence: parsed.evidence
    });
    return { import: record, data_summary: this.dataSummary(taskId) } as unknown as JsonObject;
  }

  importOfficialRecords(taskId: string, body: unknown): JsonObject {
    this.requireMutableTask(taskId);
    const input = requireObject(body);
    const sourceCode = requiredString(input.official_source_code, "official_source_code");
    const source = OFFICIAL_DATA_SOURCES.find((item) => item.code === sourceCode);
    if (!source) throw new ServiceError("未知的官方数据来源", 400);
    const importedBy = requiredString(input.imported_by, "imported_by");
    if (!Array.isArray(input.records) || input.records.length === 0) {
      throw new ServiceError("records必须是非空数组", 400);
    }
    const evidence = input.records.map((record, index) => parseOfficialRecord(record, index));
    const created = this.database.createDataImport({
      taskId,
      sourceType: "official_public",
      sourceName: source.name,
      fileName: null,
      mediaType: "application/json",
      sourceUrl: optionalString(input.source_url) ?? source.url,
      officialSourceCode: source.code,
      metadata: { queried_at: optionalString(input.queried_at), import_mode: source.import_mode },
      sha256: null,
      importedBy,
      evidence
    });
    return { import: created, data_summary: this.dataSummary(taskId) } as unknown as JsonObject;
  }

  getTaskData(taskId: string): JsonObject {
    this.requireTask(taskId);
    const imports = this.database.listDataImports(taskId);
    const evidence = this.database.listEvidenceItems(taskId);
    const diagnostics = analyzeEvidence(imports, evidence);
    return {
      imports,
      evidence_items: evidence,
      evidence_diagnostics: diagnostics.diagnostics,
      evidence_conflicts: diagnostics.conflicts,
      priority_review_queue: diagnostics.priority_review_queue,
      preassessment_runs: this.database.listPreassessmentRuns(taskId),
      data_summary: this.dataSummary(taskId)
    } as unknown as JsonObject;
  }

  runPreassessment(taskId: string, body: unknown): JsonObject {
    const task = this.requireMutableTask(taskId);
    const input = requireObject(body);
    const createdBy = requiredString(input.created_by, "created_by");
    const version = this.database.getVersion(task.template_version_id);
    if (!version) throw new ServiceError("任务引用的模板版本不存在", 500);
    const evidence = this.database.listEvidenceItems(taskId);
    if (evidence.length === 0) throw new ServiceError("请先导入至少一份本地或官方数据", 409);
    const diagnostics = analyzeEvidence(this.database.listDataImports(taskId), evidence);
    const result = buildPreassessment(version.content, evidence, diagnostics);
    const run = this.database.createPreassessmentRun({
      taskId,
      engineVersion: ENGINE_VERSION,
      result,
      createdBy
    });
    return { run, human_confirmation_required: true } as unknown as JsonObject;
  }

  applyPreassessment(taskId: string, runId: string, body: unknown): JsonObject {
    const task = this.requireMutableTask(taskId);
    const input = requireObject(body);
    const appliedBy = requiredString(input.applied_by, "applied_by");
    const reason = requiredString(input.reason, "reason");
    const run = this.database.requirePreassessmentRun(runId);
    if (run.task_id !== taskId) throw new ServiceError("预评估运行不属于当前任务", 404);
    const gateSuggestions = jsonObjectArray(run.result.gate_suggestions);
    const dimensionSuggestions = jsonObjectArray(run.result.dimension_suggestions);
    let gates = this.database.listGateResults(taskId);
    const dimensions = this.database.listDimensionScores(taskId);
    const dueDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    let appliedGates = 0;
    for (const gate of gates) {
      if (gate.status !== "pending") continue;
      const suggestion = gateSuggestions.find((item) => item.gate_id === gate.gate_id);
      if (!suggestion) continue;
      const status = gateSuggestionStatus(suggestion.suggested_status);
      const references = jsonObjectArray(suggestion.evidence_refs);
      const evidencePayload = references.length > 0 ? references : [{ source: "preassessment", run_id: runId }];
      const gatesAfter = gates.map((item) => item.gate_id === gate.gate_id
        ? { ...item, status, veto_triggered: suggestion.veto_triggered === true }
        : item);
      this.database.recordGateAssessment({
        taskId,
        gateId: gate.gate_id,
        status,
        vetoTriggered: suggestion.veto_triggered === true,
        evidence: evidencePayload,
        note: `人工采纳自动预评估建议：${String(suggestion.rationale ?? "")}`,
        assessedBy: appliedBy,
        modificationReason: reason,
        taskStatus: deriveStatus(gatesAfter, dimensions),
        supplement: status === "unconfirmed" ? {
          material: stringArray(suggestion.missing_evidence).join("；") || `${gate.gate_name}补充核验材料`,
          owner: task.assigned_to,
          dueDate,
          verificationMethod: "投资经理依据原始文件与官方公开数据交叉核验",
          status: "open",
          note: "由自动预评估生成，需人工跟进"
        } : null
      });
      gates = gatesAfter;
      appliedGates += 1;
    }

    const constraints = calculateConstraints(gates);
    let appliedDimensions = 0;
    if (constraints.all_gates_assessed && !constraints.scoring_blocked) {
      const version = this.database.getVersion(task.template_version_id)!;
      let currentDimensions = this.database.listDimensionScores(taskId);
      for (const dimension of currentDimensions) {
        if (dimension.score !== null) continue;
        const suggestion = dimensionSuggestions.find((item) => item.dimension_id === dimension.dimension_id);
        const score = typeof suggestion?.suggested_score === "number" ? suggestion.suggested_score : null;
        if (!suggestion || score === null) continue;
        const definition = version.content.dimensions.find((item) => item.id === dimension.dimension_id);
        const informationStatus = allowedValue(
          suggestion.information_status,
          stringArray(definition?.information_statuses),
          "unconfirmed"
        );
        const confidence = allowedValue(
          suggestion.confidence,
          stringArray(definition?.confidence_levels),
          "low"
        );
        const weightedScore = round2((score / version.content.score_scale) * dimension.weight);
        const after = currentDimensions.map((item) => item.dimension_id === dimension.dimension_id
          ? { ...item, score, weighted_score: weightedScore }
          : item);
        const overall = after.every((item) => item.score !== null)
          ? round2(after.reduce((sum, item) => sum + (item.weighted_score ?? 0), 0))
          : null;
        this.database.recordDimensionScore({
          taskId,
          dimensionId: dimension.dimension_id,
          score,
          weightedScore,
          informationStatus,
          confidence,
          evidence: jsonObjectArray(suggestion.evidence_refs),
          note: `人工采纳自动预评估建议：${String(suggestion.rationale ?? "")}`,
          scoredBy: appliedBy,
          modificationReason: reason,
          taskStatus: deriveStatus(gates, after),
          overallScore: overall
        });
        currentDimensions = after;
        appliedDimensions += 1;
      }
    }
    return {
      applied_gate_count: appliedGates,
      applied_dimension_count: appliedDimensions,
      skipped_existing_results: true,
      human_final_decision_required: true
    } as unknown as JsonObject;
  }

  private dataSummary(taskId: string): JsonObject {
    const imports = this.database.listDataImports(taskId);
    const evidence = this.database.listEvidenceItems(taskId);
    const diagnostics = analyzeEvidence(imports, evidence);
    const latest = this.database.listPreassessmentRuns(taskId)[0] ?? null;
    return {
      import_count: imports.length,
      evidence_count: evidence.length,
      official_source_count: new Set(imports.filter((item) => item.source_type === "official_public")
        .map((item) => item.official_source_code)).size,
      high_quality_count: diagnostics.summary.high_quality_count,
      low_quality_count: diagnostics.summary.low_quality_count,
      conflict_count: diagnostics.summary.conflict_count,
      priority_review_count: diagnostics.summary.priority_review_count,
      average_quality_score: diagnostics.summary.average_quality_score,
      latest_preassessment_run_id: latest?.id ?? null,
      latest_preassessment_at: latest?.created_at ?? null
    };
  }

  private requireTask(taskId: string) {
    const task = this.database.getEvaluationTask(taskId);
    if (!task) throw new ServiceError("未找到候选人评估任务", 404);
    return task;
  }

  private requireMutableTask(taskId: string) {
    const task = this.requireTask(taskId);
    if (task.status === "completed") throw new ServiceError("已完成的评估任务不能继续导入或预评估", 409);
    return task;
  }
}

function buildPreassessment(
  template: EvaluationTemplate,
  evidence: EvaluationEvidenceItemRecord[],
  diagnostics: EvidenceDiagnosticsResult
): JsonObject {
  const gateSuggestions = template.gates
    .slice()
    .sort((left, right) => Number(left.order) - Number(right.order))
    .map((gate) => buildGateSuggestion(gate, evidence, diagnostics));
  const dimensionSuggestions = template.dimensions
    .map((dimension) => buildDimensionSuggestion(dimension, evidence, diagnostics));
  const evidenceUsed = new Set([
    ...gateSuggestions.flatMap((item) => jsonObjectArray(item.evidence_refs).map((ref) => String(ref.evidence_id))),
    ...dimensionSuggestions.flatMap((item) => jsonObjectArray(item.evidence_refs).map((ref) => String(ref.evidence_id)))
  ]).size;
  return {
    engine_version: ENGINE_VERSION,
    generated_at: new Date().toISOString(),
    method: "结构化字段优先，其次按模板所需证据计算覆盖率；冲突证据不自动合并，缺失信息不自动判失败",
    gate_suggestions: gateSuggestions,
    dimension_suggestions: dimensionSuggestions,
    evidence_quality: diagnostics.summary,
    evidence_conflicts: diagnostics.conflicts as unknown as JsonValue,
    priority_review_queue: diagnostics.priority_review_queue as unknown as JsonValue,
    summary: {
      evidence_total: evidence.length,
      evidence_used: evidenceUsed,
      suggested_pass_gates: gateSuggestions.filter((item) => item.suggested_status === "pass").length,
      suggested_fail_gates: gateSuggestions.filter((item) => item.suggested_status === "fail").length,
      suggested_unconfirmed_gates: gateSuggestions.filter((item) => item.suggested_status === "unconfirmed").length,
      scorable_dimensions: dimensionSuggestions.filter((item) => typeof item.suggested_score === "number").length
    },
    safeguards: {
      ai_can_auto_reject: false,
      human_confirmation_required: true,
      missing_information_is_not_failure: true,
      conflicting_evidence_requires_human_review: true,
      score_cannot_offset_gate_results: true
    }
  };
}

function buildGateSuggestion(
  gate: JsonObject,
  evidence: EvaluationEvidenceItemRecord[],
  diagnostics: EvidenceDiagnosticsResult
): JsonObject {
  const id = String(gate.id);
  const explicit = findExplicit(evidence, [`gate.${id}.status`, `${id}.status`]);
  const conflict = findConflict(diagnostics.conflicts, [`gate.${id}.status`, `${id}.status`]);
  const required = stringArray(gate.required_evidence);
  const matches = matchRequiredEvidence(required, evidence);
  const refs = uniqueEvidence(matches.flatMap((item) => item.matches)).map(evidenceReference);
  const missing = matches.filter((item) => item.matches.length === 0).map((item) => item.requirement);
  if (conflict) {
    return {
      gate_id: id,
      gate_name: String(gate.name),
      suggested_status: "unconfirmed",
      veto_triggered: false,
      confidence: "low",
      basis: "conflicting_evidence",
      coverage_ratio: required.length ? round2((required.length - missing.length) / required.length) : 1,
      rationale: `检测到同一门槛字段存在${conflict.values.length}个冲突值，系统不会自动选择其中一个，必须人工复核。`,
      evidence_refs: evidence.filter((item) => conflict.evidence_ids.includes(item.id)).map(evidenceReference),
      missing_evidence: missing,
      conflict_id: conflict.id
    };
  }
  if (explicit) {
    const normalized = normalizeStatus(explicit.value);
    if (normalized) {
      return {
        gate_id: id,
        gate_name: String(gate.name),
        suggested_status: normalized,
        veto_triggered: normalized === "fail" && truthyValue(findExplicit(evidence, [`gate.${id}.veto_triggered`])?.value),
        confidence: "high",
        basis: "explicit_structured_field",
        coverage_ratio: required.length ? round2((required.length - missing.length) / required.length) : 1,
        rationale: `导入数据明确给出${statusLabel(normalized)}状态，仍需人工核验原始证据。`,
        evidence_refs: uniqueEvidence([explicit, ...refs.map((ref) => evidence.find((item) => item.id === ref.evidence_id)!)].filter(Boolean)).map(evidenceReference),
        missing_evidence: missing
      };
    }
  }
  const coverage = required.length ? (required.length - missing.length) / required.length : 0;
  return {
    gate_id: id,
    gate_name: String(gate.name),
    suggested_status: coverage >= 0.99 ? "pass" : "unconfirmed",
    veto_triggered: false,
    confidence: coverage >= 0.99 ? "medium" : "low",
    basis: coverage >= 0.99 ? "evidence_coverage" : "insufficient_evidence",
    coverage_ratio: round2(coverage),
    rationale: coverage >= 0.99
      ? "所需材料名称已全部覆盖，建议通过仅为材料完整性判断，真实性仍需人工核验。"
      : `已覆盖${required.length - missing.length}/${required.length}类所需材料，缺失项不能自动判为不符合。`,
    evidence_refs: refs,
    missing_evidence: missing
  };
}

function buildDimensionSuggestion(
  dimension: JsonObject,
  evidence: EvaluationEvidenceItemRecord[],
  diagnostics: EvidenceDiagnosticsResult
): JsonObject {
  const id = String(dimension.id);
  const explicit = findExplicit(evidence, [`dimension.${id}.score`, `${id}.score`]);
  const conflict = findConflict(diagnostics.conflicts, [`dimension.${id}.score`, `${id}.score`]);
  const required = stringArray(dimension.required_evidence);
  const matches = matchRequiredEvidence(required, evidence);
  const refs = uniqueEvidence(matches.flatMap((item) => item.matches)).map(evidenceReference);
  const missing = matches.filter((item) => item.matches.length === 0).map((item) => item.requirement);
  const coverage = required.length ? (required.length - missing.length) / required.length : 0;
  const explicitScore = Number(explicit?.value);
  const score = conflict ? null : Number.isFinite(explicitScore) && explicitScore >= 1 && explicitScore <= 5
    ? explicitScore
    : coverage >= 0.99 ? 4 : coverage >= 0.66 ? 3 : coverage > 0 ? 2 : null;
  return {
    dimension_id: id,
    dimension_name: String(dimension.name),
    suggested_score: score,
    information_status: conflict ? "conflicting" : coverage >= 0.99 ? "sufficient" : coverage > 0 ? "partially_sufficient" : "unconfirmed",
    confidence: conflict ? "low" : explicit ? "high" : coverage >= 0.99 ? "medium" : "low",
    basis: conflict ? "conflicting_evidence" : explicit ? "explicit_structured_field" : "evidence_coverage",
    coverage_ratio: round2(coverage),
    rationale: conflict
      ? `检测到同一评分字段存在${conflict.values.length}个冲突值，暂不建议分数，需人工核验来源和期间。`
      : explicit
      ? "导入数据提供了结构化评分，系统仅做范围校验并交由人工确认。"
      : score === null
        ? "没有匹配到所需材料，暂不建议分数。"
        : `依据${required.length - missing.length}/${required.length}类材料覆盖率生成保守建议分，尚未验证材料真实性和同业基准。`,
    evidence_refs: refs,
    missing_evidence: missing,
    conflict_id: conflict?.id ?? null
  };
}

function findConflict(conflicts: EvidenceConflict[], keys: string[]): EvidenceConflict | undefined {
  const wanted = keys.map(normalizeKey);
  return conflicts.find((item) => wanted.includes(normalizeKey(item.evidence_key)));
}

function matchRequiredEvidence(required: string[], evidence: EvaluationEvidenceItemRecord[]) {
  return required.map((requirement) => ({
    requirement,
    matches: evidence.filter((item) => textMatches(requirement, item.normalized_text)).slice(0, 5)
  }));
}

function textMatches(requirement: string, evidenceText: string): boolean {
  const text = evidenceText.toLowerCase();
  const normalized = requirement.toLowerCase();
  if (text.includes(normalized)) return true;
  const tokens = keywordTokens(normalized);
  return tokens.filter((token) => text.includes(token)).length >= Math.min(2, tokens.length);
}

function keywordTokens(value: string): string[] {
  const chunks = value.match(/[\p{Script=Han}]{2,}|[a-z0-9_]{2,}/gu) ?? [];
  const tokens = new Set<string>();
  for (const chunk of chunks) {
    tokens.add(chunk);
    if (/^[\p{Script=Han}]+$/u.test(chunk)) {
      for (let index = 0; index < chunk.length - 1; index += 1) tokens.add(chunk.slice(index, index + 2));
    }
  }
  return [...tokens].filter((item) => !["材料", "记录", "数据", "报告", "清单", "系统"].includes(item));
}

function findExplicit(evidence: EvaluationEvidenceItemRecord[], keys: string[]) {
  const wanted = keys.map(normalizeKey);
  return evidence.find((item) => wanted.includes(normalizeKey(item.evidence_key)));
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\p{L}]+/gu, ".").replace(/^\.+|\.+$/g, "");
}

function normalizeStatus(value: JsonValue): "pass" | "fail" | "unconfirmed" | null {
  const status = String(value).trim().toLowerCase();
  if (["pass", "符合", "通过"].includes(status)) return "pass";
  if (["fail", "不符合", "失败"].includes(status)) return "fail";
  if (["unconfirmed", "未确认", "待确认"].includes(status)) return "unconfirmed";
  return null;
}

function parseOfficialRecord(value: JsonValue, index: number): ParsedEvidenceItem {
  const record = requireObject(value, `records[${index}]`);
  const key = requiredString(record.evidence_key, `records[${index}].evidence_key`);
  const label = optionalString(record.label) ?? key;
  const itemValue = record.value ?? null;
  return {
    evidenceKey: key,
    label,
    value: itemValue,
    normalizedText: `${key} ${label} ${typeof itemValue === "string" ? itemValue : JSON.stringify(itemValue)}`.toLowerCase(),
    sourceLocator: optionalString(record.source_locator),
    observedAt: optionalString(record.observed_at),
    qualityScore: typeof record.quality_score === "number" ? Math.max(0, Math.min(1, record.quality_score)) : 0.9
  };
}

function evidenceReference(item: EvaluationEvidenceItemRecord): JsonObject {
  return { evidence_id: item.id, import_id: item.import_id, key: item.evidence_key, label: item.label, locator: item.source_locator };
}

function uniqueEvidence(items: EvaluationEvidenceItemRecord[]): EvaluationEvidenceItemRecord[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function calculateConstraints(gates: EvaluationGateResultRecord[]) {
  const failedCritical = gates.filter((gate) => gate.critical && gate.status === "fail").length;
  return {
    all_gates_assessed: gates.length > 0 && gates.every((gate) => gate.status !== "pending"),
    scoring_blocked: failedCritical >= 2 || gates.some((gate) => gate.veto_triggered)
  };
}

function deriveStatus(gates: EvaluationGateResultRecord[], dimensions: Array<{ score: number | null }>) {
  const constraints = calculateConstraints(gates);
  if (!constraints.all_gates_assessed) return "gate_review" as const;
  if (constraints.scoring_blocked) return "blocked_for_review" as const;
  if (dimensions.some((dimension) => dimension.score === null)) return "scoring" as const;
  return "decision_pending" as const;
}

function requireObject(value: unknown, field = "请求体"): JsonObject {
  if (!isJsonObject(value)) throw new ServiceError(`${field}必须是JSON对象`, 400);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length < 2) throw new ServiceError(`${field}至少需要2个字符`, 400);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function jsonObjectArray(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

function gateSuggestionStatus(value: JsonValue | undefined): "pass" | "fail" | "unconfirmed" {
  return value === "pass" || value === "fail" ? value : "unconfirmed";
}

function statusLabel(value: string): string {
  return value === "pass" ? "符合" : value === "fail" ? "不符合" : "未确认";
}

function truthyValue(value: JsonValue | undefined): boolean {
  return value === true || ["true", "1", "是", "已触发"].includes(String(value).toLowerCase());
}

function allowedValue(value: JsonValue | undefined, allowed: string[], fallback: string): string {
  return typeof value === "string" && allowed.includes(value) ? value : allowed.includes(fallback) ? fallback : allowed[0] ?? fallback;
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
