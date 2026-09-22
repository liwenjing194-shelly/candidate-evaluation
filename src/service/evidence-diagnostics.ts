import type {
  EvaluationDataImportRecord,
  EvaluationEvidenceItemRecord,
  JsonObject,
  JsonValue
} from "../domain/types.js";

export interface EvidenceDiagnostic {
  evidence_id: string;
  import_id: string;
  evidence_key: string;
  source_name: string;
  original_quality_score: number;
  computed_quality_score: number;
  quality_level: "high" | "medium" | "low";
  conflict_status: "none" | "conflicting";
  conflict_id: string | null;
  review_required: boolean;
  review_priority: 1 | 2 | 3;
  reasons: string[];
}

export interface EvidenceConflict {
  id: string;
  evidence_key: string;
  observed_period: string;
  severity: "medium" | "high";
  value_type: "status" | "number" | "text";
  values: Array<{
    normalized_value: string;
    display_value: string;
    evidence_ids: string[];
    source_names: string[];
  }>;
  evidence_ids: string[];
  requires_human_review: true;
  reason: string;
}

export interface EvidenceDiagnosticsResult {
  diagnostics: EvidenceDiagnostic[];
  conflicts: EvidenceConflict[];
  priority_review_queue: EvidenceDiagnostic[];
  summary: {
    evidence_count: number;
    high_quality_count: number;
    medium_quality_count: number;
    low_quality_count: number;
    conflict_count: number;
    conflicting_evidence_count: number;
    priority_review_count: number;
    average_quality_score: number;
  };
}

const CRITICAL_KEY = /gate|copyright|ip|integrity|conflict|compliance|authorization|security|payment|litigation|enforcement|financial|cash|诚信|版权|合规|利益冲突|诉讼|执行|财务|现金/u;

export function analyzeEvidence(
  imports: EvaluationDataImportRecord[],
  evidence: EvaluationEvidenceItemRecord[]
): EvidenceDiagnosticsResult {
  const importById = new Map(imports.map((item) => [item.id, item]));
  const groups = new Map<string, EvaluationEvidenceItemRecord[]>();
  const corroboration = new Map<string, Set<string>>();

  for (const item of evidence) {
    const key = normalizeKey(item.evidence_key);
    const period = normalizePeriod(item.observed_at);
    const groupKey = `${key}|${period}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), item]);
    const valueKey = `${key}|${canonicalValue(item.value).normalized}`;
    const sourceIdentity = importById.get(item.import_id)?.source_name ?? item.import_id;
    const sources = corroboration.get(valueKey) ?? new Set<string>();
    sources.add(sourceIdentity);
    corroboration.set(valueKey, sources);
  }

  const conflicts: EvidenceConflict[] = [];
  const conflictByEvidence = new Map<string, EvidenceConflict>();
  for (const [groupKey, items] of groups) {
    if (items.length < 2 || isNarrativeKey(items[0]!.evidence_key)) continue;
    const values = new Map<string, EvaluationEvidenceItemRecord[]>();
    for (const item of items) {
      const canonical = canonicalValue(item.value);
      values.set(canonical.normalized, [...(values.get(canonical.normalized) ?? []), item]);
    }
    if (values.size < 2) continue;
    const evidenceKey = items[0]!.evidence_key;
    const critical = CRITICAL_KEY.test(evidenceKey.toLowerCase());
    const conflict: EvidenceConflict = {
      id: `conflict:${groupKey}`,
      evidence_key: evidenceKey,
      observed_period: normalizePeriod(items[0]!.observed_at),
      severity: critical ? "high" : "medium",
      value_type: canonicalValue(items[0]!.value).type,
      values: [...values.entries()].map(([normalized, grouped]) => ({
        normalized_value: normalized,
        display_value: displayValue(grouped[0]!.value),
        evidence_ids: grouped.map((item) => item.id),
        source_names: [...new Set(grouped.map((item) => importById.get(item.import_id)?.source_name ?? "未知来源"))]
      })),
      evidence_ids: items.map((item) => item.id),
      requires_human_review: true,
      reason: `同一字段在${normalizePeriod(items[0]!.observed_at) === "unspecified" ? "未标明期间" : normalizePeriod(items[0]!.observed_at)}出现${values.size}个不同值，禁止自动合并。`
    };
    conflicts.push(conflict);
    items.forEach((item) => conflictByEvidence.set(item.id, conflict));
  }

  const diagnostics = evidence.map((item) => {
    const source = importById.get(item.import_id);
    const conflict = conflictByEvidence.get(item.id);
    const critical = CRITICAL_KEY.test(item.evidence_key.toLowerCase());
    const canonical = canonicalValue(item.value);
    const corroboratingSources = corroboration.get(`${normalizeKey(item.evidence_key)}|${canonical.normalized}`)?.size ?? 1;
    const reasons: string[] = [];
    let score = Math.max(0, Math.min(1, item.quality_score)) * 0.15;

    if (source?.source_type === "official_public") {
      score += 0.25;
      reasons.push("官方公开来源");
    } else {
      score += 0.14;
      reasons.push("本地或授权尽调文件");
    }
    if (source?.source_url) { score += 0.08; reasons.push("保留来源链接"); }
    if (item.source_locator) { score += 0.12; reasons.push("可定位到原始位置"); }
    if (source?.sha256) { score += 0.05; reasons.push("保留文件指纹"); }
    score += freshnessScore(item.observed_at, reasons);
    if (isNarrativeKey(item.evidence_key)) {
      score += 0.04;
      reasons.push("非结构化叙述字段");
    } else {
      score += 0.1;
      reasons.push("结构化业务字段");
    }
    if (canonical.normalized) score += 0.1;
    if (corroboratingSources >= 2) {
      score += 0.15;
      reasons.push(`${corroboratingSources}个独立来源一致印证`);
    } else {
      score += 0.05;
      reasons.push("尚缺第二来源印证");
    }
    if (conflict) {
      score -= 0.25;
      reasons.push("同字段同期间存在冲突值");
    }
    score = round2(Math.max(0, Math.min(1, score)));
    const qualityLevel = score >= 0.8 ? "high" : score >= 0.6 ? "medium" : "low";
    const reviewRequired = Boolean(conflict) || qualityLevel === "low" || critical;
    const reviewPriority: 1 | 2 | 3 = conflict?.severity === "high" || critical ? 3
      : conflict || qualityLevel === "low" ? 2 : 1;
    if (critical) reasons.push("涉及关键门槛或高风险字段");
    return {
      evidence_id: item.id,
      import_id: item.import_id,
      evidence_key: item.evidence_key,
      source_name: source?.source_name ?? "未知来源",
      original_quality_score: round2(item.quality_score),
      computed_quality_score: score,
      quality_level: qualityLevel,
      conflict_status: conflict ? "conflicting" : "none",
      conflict_id: conflict?.id ?? null,
      review_required: reviewRequired,
      review_priority: reviewPriority,
      reasons
    } satisfies EvidenceDiagnostic;
  });

  const priorityReviewQueue = diagnostics
    .filter((item) => item.review_required)
    .sort((left, right) => right.review_priority - left.review_priority
      || left.computed_quality_score - right.computed_quality_score);
  const average = diagnostics.length
    ? round2(diagnostics.reduce((sum, item) => sum + item.computed_quality_score, 0) / diagnostics.length)
    : 0;
  return {
    diagnostics,
    conflicts,
    priority_review_queue: priorityReviewQueue,
    summary: {
      evidence_count: diagnostics.length,
      high_quality_count: diagnostics.filter((item) => item.quality_level === "high").length,
      medium_quality_count: diagnostics.filter((item) => item.quality_level === "medium").length,
      low_quality_count: diagnostics.filter((item) => item.quality_level === "low").length,
      conflict_count: conflicts.length,
      conflicting_evidence_count: conflictByEvidence.size,
      priority_review_count: priorityReviewQueue.length,
      average_quality_score: average
    }
  };
}

function normalizeKey(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9\p{L}]+/gu, ".").replace(/^\.+|\.+$/g, "");
}

function normalizePeriod(value: string | null): string {
  if (!value) return "unspecified";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value.trim() : date.toISOString().slice(0, 10);
}

function canonicalValue(value: JsonValue): { normalized: string; type: "status" | "number" | "text" } {
  const text = typeof value === "string" ? value.trim() : JSON.stringify(value);
  const lower = text.toLowerCase();
  if (["pass", "符合", "通过", "true", "是"].includes(lower)) return { normalized: "pass", type: "status" };
  if (["fail", "不符合", "失败", "false", "否"].includes(lower)) return { normalized: "fail", type: "status" };
  if (["unconfirmed", "未确认", "待确认"].includes(lower)) return { normalized: "unconfirmed", type: "status" };
  const numericText = text.replace(/[,，%￥¥$\s]/g, "");
  if (numericText !== "" && Number.isFinite(Number(numericText))) {
    return { normalized: String(Number(numericText)), type: "number" };
  }
  return { normalized: lower.replace(/\s+/g, " "), type: "text" };
}

function displayValue(value: JsonValue): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function isNarrativeKey(key: string): boolean {
  return /(^|\.)document(\.|$)|(^|\.)line(\.|$)|^column_/i.test(key);
}

function freshnessScore(observedAt: string | null, reasons: string[]): number {
  if (!observedAt) {
    reasons.push("未标明观察时间");
    return 0.02;
  }
  const timestamp = new Date(observedAt).getTime();
  if (Number.isNaN(timestamp)) {
    reasons.push("观察时间格式待核验");
    return 0.02;
  }
  const ageDays = Math.max(0, (Date.now() - timestamp) / 86400000);
  if (ageDays <= 730) {
    reasons.push("两年内数据");
    return 0.1;
  }
  reasons.push("历史数据，需检查时效性");
  return 0.06;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
