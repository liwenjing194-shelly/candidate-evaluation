import type {
  EvaluationDimensionScoreRecord,
  EvaluationGateResultRecord,
  EvaluationTaskRecord,
  EvaluationTaskStatus,
  EvaluationTemplate,
  JsonObject,
  JsonValue,
  SupplementRequestRecord,
  TemplateVersionRecord
} from "../domain/types.js";
import { AppDatabase } from "../db/database.js";
import { isJsonObject } from "../lib/json.js";
import { analyzeEvidence } from "./evidence-diagnostics.js";
import { ServiceError } from "./template-service.js";

type FinalConclusion =
  | "recommend_investment"
  | "needs_more_information"
  | "hold"
  | "do_not_invest"
  | "investment_suspended";

interface DecisionConstraints {
  all_gates_assessed: boolean;
  failed_critical_gate_count: number;
  unconfirmed_gate_count: number;
  veto_triggered: boolean;
  scoring_blocked: boolean;
  scoring_mode: "official" | "reference_only" | "blocked";
  recommendation_blocked: boolean;
  next_gate_id: string | null;
  allowed_conclusions: FinalConclusion[];
  ai_can_auto_reject: false;
  human_final_decision_required: true;
}

export class EvaluationTaskService {
  constructor(private readonly database: AppDatabase) {}

  listPublishedTemplateVersions(): JsonObject {
    const allVersions = this.database.listPublishedVersions();
    const versionCounts = new Map<string, number>();
    const latestByTemplateKey = new Map<string, TemplateVersionRecord>();
    for (const version of allVersions) {
      const key = version.content.template_id;
      versionCounts.set(key, (versionCounts.get(key) ?? 0) + 1);
      const current = latestByTemplateKey.get(key);
      if (!current || comparePublishedVersions(version, current) > 0) {
        latestByTemplateKey.set(key, version);
      }
    }
    const activeVersions = [...latestByTemplateKey.values()]
      .sort((left, right) => left.content.name.localeCompare(right.content.name, "zh-CN"));
    return {
      template_versions: activeVersions.map((version) => ({
        id: version.id,
        template_id: version.template_id,
        template_key: version.content.template_id,
        version: version.version,
        name: version.content.name,
        scope: version.content.scope,
        gate_count: version.content.gates.length,
        dimension_count: version.content.dimensions.length,
        approved_by: version.approved_by,
        published_at: version.published_at,
        historical_version_count: (versionCounts.get(version.content.template_id) ?? 1) - 1
      })),
      total_published_versions: allVersions.length,
      active_template_count: activeVersions.length
    } as unknown as JsonObject;
  }

  createTask(body: unknown): JsonObject {
    const input = requireObject(body);
    const templateVersionId = requiredString(input.template_version_id, "template_version_id");
    const candidate = requireObject(input.candidate, "candidate");
    const candidateName = requiredString(candidate.name, "candidate.name");
    const candidateReference = optionalString(candidate.reference, "candidate.reference");
    const createdBy = requiredString(input.created_by, "created_by");
    const assignedTo = requiredString(input.assigned_to, "assigned_to");
    const version = this.database.getVersion(templateVersionId);
    if (!version) throw new ServiceError("未找到已发布模板版本", 404);
    if (version.content.status !== "published") {
      throw new ServiceError("评估任务只能使用已发布模板版本", 409);
    }

    const gates = readTemplateGates(version.content);
    const dimensions = readTemplateDimensions(version.content);
    const task = this.database.createEvaluationTask({
      templateVersion: version,
      candidateName,
      candidateReference,
      candidateSnapshot: candidate,
      createdBy,
      assignedTo,
      gates,
      dimensions
    });
    return this.getTask(task.id);
  }

  listTasks(): JsonObject {
    const tasks = this.database.listEvaluationTasks().map((task) => {
      const gates = this.database.listGateResults(task.id);
      const constraints = calculateConstraints(gates);
      return {
        ...task,
        progress: {
          gates_completed: gates.filter((gate) => gate.status !== "pending").length,
          gates_total: gates.length,
          next_gate_id: constraints.next_gate_id
        },
        decision_constraints: constraints
      };
    });
    return { tasks } as unknown as JsonObject;
  }

  getTask(id: string): JsonObject {
    const task = this.requireTask(id);
    const version = this.requireVersion(task.template_version_id);
    const gates = this.database.listGateResults(id);
    const dimensions = this.database.listDimensionScores(id);
    const supplements = this.database.listSupplementRequests(id);
    const decisions = this.database.listDecisions(id);
    const imports = this.database.listDataImports(id);
    const evidenceItems = this.database.listEvidenceItems(id);
    const evidenceDiagnostics = analyzeEvidence(imports, evidenceItems);
    const preassessmentRuns = this.database.listPreassessmentRuns(id);
    const constraints = calculateConstraints(gates);
    const systemReferenceConclusion = buildSystemReferenceConclusion(
      task,
      gates,
      dimensions,
      constraints,
      version.content
    );
    return {
      task,
      template: templateSummary(version),
      progress: buildProgress(gates, dimensions, constraints),
      decision_constraints: constraints,
      gates,
      supplement_requests: supplements,
      dimensions,
      decisions,
      system_reference_conclusion: systemReferenceConclusion,
      data_summary: {
        import_count: imports.length,
        evidence_count: evidenceItems.length,
        official_source_count: new Set(imports
          .filter((item) => item.source_type === "official_public")
          .map((item) => item.official_source_code)).size,
        high_quality_count: evidenceDiagnostics.summary.high_quality_count,
        low_quality_count: evidenceDiagnostics.summary.low_quality_count,
        conflict_count: evidenceDiagnostics.summary.conflict_count,
        priority_review_count: evidenceDiagnostics.summary.priority_review_count,
        average_quality_score: evidenceDiagnostics.summary.average_quality_score,
        latest_preassessment_run_id: preassessmentRuns[0]?.id ?? null,
        latest_preassessment_at: preassessmentRuns[0]?.created_at ?? null
      },
      latest_preassessment: preassessmentRuns[0] ?? null
    } as unknown as JsonObject;
  }

  assessGate(taskId: string, gateId: string, body: unknown): JsonObject {
    const task = this.requireMutableTask(taskId);
    const input = requireObject(body);
    const status = gateStatus(input.status);
    const assessedBy = requiredString(input.assessed_by, "assessed_by");
    const evidence = jsonArray(input.evidence, "evidence", true);
    const note = optionalString(input.note, "note");
    const vetoTriggered = optionalBoolean(input.veto_triggered, "veto_triggered") ?? false;
    if (status === "pass" && vetoTriggered) {
      throw new ServiceError("门槛通过时不能同时触发否决性问题", 400);
    }

    const gates = this.database.listGateResults(taskId);
    const existing = gates.find((gate) => gate.gate_id === gateId);
    if (!existing) throw new ServiceError("当前模板不存在该投资门槛", 404);
    const nextGate = gates.find((gate) => gate.status === "pending");
    if (existing.status === "pending" && nextGate?.gate_id !== gateId) {
      throw new ServiceError(`必须先检查顺序第${nextGate?.gate_order ?? 1}项门槛：${nextGate?.gate_name ?? "未知门槛"}`, 409);
    }

    const conclusionChanged = existing.status !== "pending"
      && (existing.status !== status || existing.veto_triggered !== vetoTriggered);
    const modificationReason = optionalString(input.modification_reason, "modification_reason");
    if (conclusionChanged && !modificationReason) {
      throw new ServiceError("人工修改既有门槛结论时必须填写modification_reason", 400);
    }

    const existingSupplement = this.database.listSupplementRequests(taskId)
      .find((item) => item.gate_id === gateId);
    const supplement = status === "unconfirmed"
      ? parseSupplement(input.supplement_request, existingSupplement)
      : null;

    const gatesAfter = gates.map((gate) => gate.gate_id === gateId
      ? { ...gate, status, veto_triggered: vetoTriggered }
      : gate);
    const dimensions = this.database.listDimensionScores(taskId);
    const taskStatus = deriveTaskStatus(gatesAfter, dimensions);
    this.database.recordGateAssessment({
      taskId,
      gateId,
      status,
      vetoTriggered,
      evidence,
      note,
      assessedBy,
      modificationReason,
      taskStatus,
      supplement
    });
    return this.getTask(task.id);
  }

  scoreDimension(taskId: string, dimensionId: string, body: unknown): JsonObject {
    const task = this.requireMutableTask(taskId);
    const version = this.requireVersion(task.template_version_id);
    const gates = this.database.listGateResults(taskId);
    const constraints = calculateConstraints(gates);
    if (!constraints.all_gates_assessed) {
      throw new ServiceError("必须先按顺序完成全部投资门槛检查", 409);
    }
    if (constraints.scoring_blocked) {
      throw new ServiceError("关键门槛结果已阻止正式评分，必须转人工复核", 409, constraints);
    }

    const input = requireObject(body);
    const score = requiredScore(input.score, version.content.score_scale);
    const scoredBy = requiredString(input.scored_by, "scored_by");
    const informationStatus = requiredString(input.information_status, "information_status");
    const confidence = requiredString(input.confidence, "confidence");
    const evidence = jsonArray(input.evidence, "evidence", true);
    const note = optionalString(input.note, "note");
    const dimensions = this.database.listDimensionScores(taskId);
    const existing = dimensions.find((dimension) => dimension.dimension_id === dimensionId);
    if (!existing) throw new ServiceError("当前模板不存在该评分维度", 404);

    const templateDimension = version.content.dimensions.find((item) => item.id === dimensionId);
    if (!templateDimension) throw new ServiceError("模板版本缺少对应评分维度", 500);
    const allowedStatuses = stringArray(templateDimension.information_statuses);
    const allowedConfidence = stringArray(templateDimension.confidence_levels);
    if (!allowedStatuses.includes(informationStatus)) {
      throw new ServiceError(`information_status必须为：${allowedStatuses.join("、")}`, 400);
    }
    if (!allowedConfidence.includes(confidence)) {
      throw new ServiceError(`confidence必须为：${allowedConfidence.join("、")}`, 400);
    }

    const modificationReason = optionalString(input.modification_reason, "modification_reason");
    if (existing.score !== null && existing.score !== score && !modificationReason) {
      throw new ServiceError("人工修改既有评分时必须填写modification_reason", 400);
    }
    const weightedScore = round2((score / version.content.score_scale) * existing.weight);
    const dimensionsAfter = dimensions.map((dimension) => dimension.dimension_id === dimensionId
      ? { ...dimension, score, weighted_score: weightedScore }
      : dimension);
    const allScored = dimensionsAfter.every((dimension) => dimension.score !== null);
    const overallScore = allScored
      ? round2(dimensionsAfter.reduce((sum, dimension) => sum + (dimension.weighted_score ?? 0), 0))
      : null;
    const taskStatus = deriveTaskStatus(gates, dimensionsAfter);
    this.database.recordDimensionScore({
      taskId,
      dimensionId,
      score,
      weightedScore,
      informationStatus,
      confidence,
      evidence,
      note,
      scoredBy,
      modificationReason,
      taskStatus,
      overallScore
    });
    return this.getTask(task.id);
  }

  updateSupplement(taskId: string, supplementId: string, body: unknown): JsonObject {
    this.requireMutableTask(taskId);
    const input = requireObject(body);
    const updatedBy = requiredString(input.updated_by, "updated_by");
    const reason = requiredString(input.reason, "reason");
    const status = requiredString(input.status, "status");
    const allowed = ["open", "submitted", "verified", "closed", "cancelled"];
    if (!allowed.includes(status)) {
      throw new ServiceError(`status必须为：${allowed.join("、")}`, 400);
    }
    if (!this.database.getSupplementRequest(taskId, supplementId)) {
      throw new ServiceError("未找到补件事项", 404);
    }
    this.database.updateSupplementRequest({
      taskId,
      id: supplementId,
      status,
      note: optionalString(input.note, "note"),
      updatedBy,
      reason
    });
    return this.getTask(taskId);
  }

  recordDecision(taskId: string, body: unknown): JsonObject {
    const task = this.requireMutableTask(taskId);
    const input = requireObject(body);
    const conclusion = finalConclusion(input.conclusion);
    const decidedBy = requiredString(input.decided_by, "decided_by");
    const reason = requiredString(input.reason, "reason");
    const gates = this.database.listGateResults(taskId);
    const dimensions = this.database.listDimensionScores(taskId);
    const constraints = calculateConstraints(gates);
    if (!constraints.all_gates_assessed) {
      throw new ServiceError("必须先完成全部投资门槛检查", 409, constraints);
    }
    if (!constraints.scoring_blocked && dimensions.some((dimension) => dimension.score === null)) {
      throw new ServiceError("必须先完成全部评分维度，才能提交人工最终结论", 409);
    }
    if (!constraints.allowed_conclusions.includes(conclusion)) {
      throw new ServiceError(
        `当前门槛结果只允许人工选择：${constraints.allowed_conclusions.join("、")}`,
        409,
        constraints
      );
    }
    this.database.recordHumanDecision({
      taskId,
      conclusion,
      reason,
      decidedBy,
      constraintsSnapshot: constraints as unknown as JsonObject
    });
    return this.getTask(task.id);
  }

  getAuditHistory(taskId: string): JsonObject {
    this.requireTask(taskId);
    return {
      task_id: taskId,
      events: this.database.listAuditEvents(taskId)
    } as unknown as JsonObject;
  }

  getReport(taskId: string): JsonObject {
    const detail = this.getTask(taskId);
    const task = detail.task as unknown as EvaluationTaskRecord;
    const constraints = detail.decision_constraints as unknown as DecisionConstraints;
    const version = this.requireVersion(task.template_version_id);
    const dimensions = this.database.listDimensionScores(taskId);
    const reportDimensions = buildDimensionAttribution(dimensions, version.content);
    return {
      report_version: "1.1",
      generated_at: new Date().toISOString(),
      report_status: task.status === "completed" ? "final" : "working_draft",
      human_final_decision_required: true,
      task: detail.task,
      template: detail.template,
      executive_summary: {
        candidate_name: task.candidate_name,
        task_status: task.status,
        overall_score: task.overall_score,
        final_conclusion: task.final_conclusion,
        failed_critical_gate_count: constraints.failed_critical_gate_count,
        unconfirmed_gate_count: constraints.unconfirmed_gate_count,
        veto_triggered: constraints.veto_triggered,
        score_cannot_offset_gate_results: true,
        system_reference_conclusion: detail.system_reference_conclusion
      },
      gates: detail.gates,
      supplement_requests: detail.supplement_requests,
      dimensions: reportDimensions,
      score_attribution: reportDimensions.map((item) => ({
        dimension_id: item.dimension_id,
        dimension_name: item.dimension_name,
        weight: item.weight,
        score: item.score,
        weighted_score: item.weighted_score,
        achievement_rate: item.achievement_rate,
        contribution_share: item.contribution_share
      })),
      decisions: detail.decisions,
      audit_event_count: this.database.listAuditEvents(taskId).length
    } as unknown as JsonObject;
  }

  private requireTask(id: string): EvaluationTaskRecord {
    const task = this.database.getEvaluationTask(id);
    if (!task) throw new ServiceError("未找到候选人评估任务", 404);
    return task;
  }

  private requireMutableTask(id: string): EvaluationTaskRecord {
    const task = this.requireTask(id);
    if (task.status === "completed") {
      throw new ServiceError("评估任务已经完成人工结论，当前版本不可继续修改", 409);
    }
    return task;
  }

  private requireVersion(id: string): TemplateVersionRecord {
    const version = this.database.getVersion(id);
    if (!version) throw new ServiceError("评估任务引用的模板版本不存在", 500);
    return version;
  }
}

function calculateConstraints(gates: EvaluationGateResultRecord[]): DecisionConstraints {
  const failedCritical = gates.filter((gate) => gate.critical && gate.status === "fail").length;
  const unconfirmed = gates.filter((gate) => gate.status === "unconfirmed").length;
  const vetoTriggered = gates.some((gate) => gate.veto_triggered);
  const allAssessed = gates.length > 0 && gates.every((gate) => gate.status !== "pending");
  const scoringBlocked = failedCritical >= 2 || vetoTriggered;
  const allowedConclusions: FinalConclusion[] = scoringBlocked
    ? ["investment_suspended"]
    : unconfirmed > 0
      ? ["needs_more_information", "hold"]
      : ["recommend_investment", "hold", "do_not_invest"];
  return {
    all_gates_assessed: allAssessed,
    failed_critical_gate_count: failedCritical,
    unconfirmed_gate_count: unconfirmed,
    veto_triggered: vetoTriggered,
    scoring_blocked: scoringBlocked,
    scoring_mode: scoringBlocked ? "blocked" : unconfirmed > 0 ? "reference_only" : "official",
    recommendation_blocked: scoringBlocked || unconfirmed > 0,
    next_gate_id: gates.find((gate) => gate.status === "pending")?.gate_id ?? null,
    allowed_conclusions: allowedConclusions,
    ai_can_auto_reject: false,
    human_final_decision_required: true
  };
}

function buildSystemReferenceConclusion(
  task: EvaluationTaskRecord,
  gates: EvaluationGateResultRecord[],
  dimensions: EvaluationDimensionScoreRecord[],
  constraints: DecisionConstraints,
  template: EvaluationTemplate
): JsonObject {
  const scored = dimensions.filter((item) => item.score !== null);
  const ranked = scored.slice().sort((left, right) =>
    ((right.score ?? 0) / template.score_scale) - ((left.score ?? 0) / template.score_scale)
  );
  const strengths = ranked.slice(0, 2).map((item) => ({
    dimension_id: item.dimension_id,
    name: item.dimension_name,
    score: item.score,
    weight: item.weight
  }));
  const risks = ranked.slice().reverse().slice(0, 2).map((item) => ({
    dimension_id: item.dimension_id,
    name: item.dimension_name,
    score: item.score,
    weight: item.weight
  }));
  const reasons: string[] = [];
  let code = "scoring_incomplete";
  let label = "等待评分完成";
  let tone = "neutral";

  if (!constraints.all_gates_assessed || scored.length < dimensions.length) {
    reasons.push(`已完成${scored.length}/${dimensions.length}项评分，尚不足以形成完整的系统参考判断。`);
    const pendingGates = gates.filter((gate) => gate.status === "pending").length;
    if (pendingGates > 0) reasons.push(`仍有${pendingGates}项投资门槛待检查。`);
  } else if (constraints.scoring_blocked) {
    code = "risk_blocked";
    label = "建议暂停推进并转人工复核";
    tone = "bad";
    reasons.push(`存在${constraints.failed_critical_gate_count}项关键门槛失败或否决性问题，门槛结果优先于综合评分。`);
  } else if (constraints.unconfirmed_gate_count > 0) {
    code = "needs_evidence";
    label = (task.overall_score ?? 0) >= 75 ? "建议补充信息后再进入决策" : "建议保留并补充信息";
    tone = "warn";
    reasons.push(`仍有${constraints.unconfirmed_gate_count}项门槛未确认，当前评分只能作为参考。`);
    reasons.push(`综合得分为${task.overall_score ?? "未形成"}分，待补件核验后再判断是否进入投资讨论。`);
  } else if ((task.overall_score ?? 0) >= 80) {
    code = "discussion_ready";
    label = "可进入投资决策讨论";
    tone = "good";
    reasons.push(`全部投资门槛已确认，综合得分${task.overall_score}分，达到较强候选区间。`);
  } else if ((task.overall_score ?? 0) >= 65) {
    code = "cautious_hold";
    label = "建议谨慎保留";
    tone = "warn";
    reasons.push(`全部投资门槛已完成，综合得分${task.overall_score}分，具备部分优势但整体确定性仍有限。`);
  } else {
    code = "not_ready";
    label = "暂不建议推进";
    tone = "bad";
    reasons.push(`全部投资门槛已完成，但综合得分${task.overall_score ?? 0}分，能力成熟度尚未达到当前投资讨论区间。`);
  }

  if (strengths[0]) {
    reasons.push(`主要优势来自“${strengths.map((item) => `${item.name}${item.score}分`).join("、")}”。`);
  }
  if (risks[0]) {
    reasons.push(`需要重点核查“${risks.map((item) => `${item.name}${item.score}分`).join("、")}”。`);
  }
  return {
    code,
    label,
    tone,
    overall_score: task.overall_score,
    reasons,
    strengths,
    risks,
    generated_by: "transparent-rules-v1",
    is_investment_decision: false,
    human_final_decision_required: true,
    disclaimer: "该判断由确定性规则根据门槛与加权评分生成，仅供决策者参考，不能替代人工投资结论。"
  };
}

function buildDimensionAttribution(
  dimensions: EvaluationDimensionScoreRecord[],
  template: EvaluationTemplate
): JsonObject[] {
  const total = dimensions.reduce((sum, item) => sum + (item.weighted_score ?? 0), 0);
  return dimensions.map((item) => {
    const definition = template.dimensions.find((candidate) => candidate.id === item.dimension_id);
    const anchors = Array.isArray(definition?.anchors)
      ? definition.anchors.filter(isJsonObject)
      : [];
    const anchor = anchors.find((candidate) => candidate.score === item.score);
    const anchorDescription = typeof anchor?.description === "string" ? anchor.description : null;
    const anchorText = anchorDescription
      ? /[。！？.!?]$/.test(anchorDescription)
        ? anchorDescription
        : `${anchorDescription}。`
      : "";
    const achievementRate = item.score === null ? 0 : round2((item.score / template.score_scale) * 100);
    const contributionShare = total > 0 && item.weighted_score !== null
      ? round2((item.weighted_score / total) * 100)
      : 0;
    const explanation = item.score === null
      ? "该维度尚未完成评分，暂不计入综合得分。"
      : `该维度得分${item.score}/${template.score_scale}，按${item.weight}%权重贡献${item.weighted_score ?? 0}分。${anchorText}信息状态为${informationStatusText(item.information_status)}，置信度为${confidenceText(item.confidence)}。`;
    return {
      ...item,
      achievement_rate: achievementRate,
      contribution_share: contributionShare,
      anchor_description: anchorDescription,
      explanation
    } as unknown as JsonObject;
  });
}

function informationStatusText(value: string | null): string {
  return ({
    sufficient: "充分",
    partially_sufficient: "部分充分",
    unconfirmed: "未确认",
    conflicting: "存在冲突",
    not_applicable: "不适用"
  } as Record<string, string>)[value ?? ""] ?? "未填写";
}

function confidenceText(value: string | null): string {
  return ({ high: "高", medium: "中", low: "低" } as Record<string, string>)[value ?? ""] ?? "未填写";
}

function deriveTaskStatus(
  gates: EvaluationGateResultRecord[],
  dimensions: EvaluationDimensionScoreRecord[]
): EvaluationTaskStatus {
  const constraints = calculateConstraints(gates);
  if (!constraints.all_gates_assessed) return "gate_review";
  if (constraints.scoring_blocked) return "blocked_for_review";
  if (dimensions.some((dimension) => dimension.score === null)) return "scoring";
  return "decision_pending";
}

function buildProgress(
  gates: EvaluationGateResultRecord[],
  dimensions: EvaluationDimensionScoreRecord[],
  constraints: DecisionConstraints
): JsonObject {
  return {
    gates_completed: gates.filter((gate) => gate.status !== "pending").length,
    gates_total: gates.length,
    dimensions_completed: dimensions.filter((dimension) => dimension.score !== null).length,
    dimensions_total: dimensions.length,
    next_gate_id: constraints.next_gate_id
  };
}

function templateSummary(version: TemplateVersionRecord): JsonObject {
  return {
    template_version_id: version.id,
    template_id: version.template_id,
    template_key: version.content.template_id,
    version: version.version,
    name: version.content.name,
    scope: version.content.scope,
    score_scale: version.content.score_scale,
    decision_rules: version.content.decision_rules,
    gate_definitions: version.content.gates,
    dimension_definitions: version.content.dimensions,
    published_at: version.published_at
  };
}

function readTemplateGates(template: EvaluationTemplate): Array<{
  id: string;
  name: string;
  order: number;
  critical: boolean;
}> {
  return template.gates.map((gate, index) => ({
    id: requiredTemplateString(gate.id, `gates[${index}].id`),
    name: requiredTemplateString(gate.name, `gates[${index}].name`),
    order: requiredTemplateNumber(gate.order, `gates[${index}].order`),
    critical: gate.critical === true
  })).sort((left, right) => left.order - right.order);
}

function readTemplateDimensions(template: EvaluationTemplate): Array<{
  id: string;
  name: string;
  order: number;
  weight: number;
}> {
  return template.dimensions.map((dimension, index) => ({
    id: requiredTemplateString(dimension.id, `dimensions[${index}].id`),
    name: requiredTemplateString(dimension.name, `dimensions[${index}].name`),
    order: index + 1,
    weight: requiredTemplateNumber(dimension.weight, `dimensions[${index}].weight`)
  }));
}

function parseSupplement(
  value: JsonValue | undefined,
  existing: SupplementRequestRecord | undefined
): {
  material: string;
  owner: string;
  dueDate: string;
  verificationMethod: string;
  status: string;
  note: string | null;
} | null {
  if (value === undefined && existing) return null;
  const supplement = requireObject(value, "supplement_request");
  const dueDate = requiredString(supplement.due_date, "supplement_request.due_date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    throw new ServiceError("supplement_request.due_date必须使用YYYY-MM-DD格式", 400);
  }
  return {
    material: requiredString(supplement.material, "supplement_request.material"),
    owner: requiredString(supplement.owner, "supplement_request.owner"),
    dueDate,
    verificationMethod: requiredString(
      supplement.verification_method,
      "supplement_request.verification_method"
    ),
    status: "open",
    note: optionalString(supplement.note, "supplement_request.note")
  };
}

function requireObject(value: unknown, field = "请求体"): JsonObject {
  if (!isJsonObject(value)) throw new ServiceError(`${field}必须是JSON对象`, 400);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length < 2) {
    throw new ServiceError(`${field}至少需要2个字符`, 400);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length < 2) {
    throw new ServiceError(`${field}至少需要2个字符`, 400);
  }
  return value.trim();
}

function optionalBoolean(value: unknown, field: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") throw new ServiceError(`${field}必须是布尔值`, 400);
  return value;
}

function jsonArray(value: unknown, field: string, requireNonEmpty: boolean): JsonValue[] {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) {
    throw new ServiceError(`${field}必须是非空数组`, 400);
  }
  return value as JsonValue[];
}

function gateStatus(value: unknown): "pass" | "fail" | "unconfirmed" {
  if (value === "pass" || value === "fail" || value === "unconfirmed") return value;
  throw new ServiceError("status必须为pass、fail或unconfirmed", 400);
}

function finalConclusion(value: unknown): FinalConclusion {
  const allowed: FinalConclusion[] = [
    "recommend_investment",
    "needs_more_information",
    "hold",
    "do_not_invest",
    "investment_suspended"
  ];
  if (typeof value === "string" && allowed.includes(value as FinalConclusion)) {
    return value as FinalConclusion;
  }
  throw new ServiceError(`conclusion必须为：${allowed.join("、")}`, 400);
}

function requiredScore(value: unknown, scale: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > scale) {
    throw new ServiceError(`score必须是1到${scale}之间的数字`, 400);
  }
  return value;
}

function requiredTemplateString(value: JsonValue | undefined, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ServiceError(`已发布模板字段${path}无效`, 500);
  }
  return value;
}

function requiredTemplateNumber(value: JsonValue | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ServiceError(`已发布模板字段${path}无效`, 500);
  }
  return value;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function comparePublishedVersions(left: TemplateVersionRecord, right: TemplateVersionRecord): number {
  const leftParts = left.version.split(".").map(Number);
  const rightParts = right.version.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return left.published_at.localeCompare(right.published_at);
}
