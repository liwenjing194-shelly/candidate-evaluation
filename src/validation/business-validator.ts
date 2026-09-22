import type {
  EvaluationTemplate,
  JsonObject,
  ValidationIssue,
  ValidationReport
} from "../domain/types.js";

const DEFAULT_GATE_ORDER = [
  "ip_and_copyright",
  "leader_integrity_and_verifiability",
  "commercialization_path",
  "conflict_of_interest"
];

const REQUIRED_GATE_STATUSES = ["fail", "pass", "unconfirmed"];

export interface BusinessValidationPolicy {
  requiredGateOrder?: string[];
}

export function validateTemplateBusinessRules(
  template: EvaluationTemplate,
  schemaErrors: ValidationIssue[] = [],
  policy: BusinessValidationPolicy = {}
): ValidationReport {
  const businessErrors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const dimensions = Array.isArray(template.dimensions) ? template.dimensions : [];
  const gates = Array.isArray(template.gates) ? template.gates : [];
  const requiredGateOrder = policy.requiredGateOrder?.length
    ? policy.requiredGateOrder
    : DEFAULT_GATE_ORDER;

  const totalWeight = dimensions.reduce((sum, dimension) => {
    const weight = typeof dimension.weight === "number" ? dimension.weight : 0;
    return sum + weight;
  }, 0);
  if (Math.abs(totalWeight - 100) > 0.0001) {
    businessErrors.push(issue("/dimensions", `维度权重合计必须为100，当前为${totalWeight}`));
  }

  checkUniqueIds(dimensions, "/dimensions", businessErrors);
  for (const [index, dimension] of dimensions.entries()) {
    const anchors = Array.isArray(dimension.anchors) ? dimension.anchors : [];
    const scores = anchors
      .map((anchor) => isRecord(anchor) && typeof anchor.score === "number" ? anchor.score : null)
      .filter((score): score is number => score !== null)
      .sort((a, b) => a - b);
    if (JSON.stringify(scores) !== JSON.stringify([1, 2, 3, 4, 5])) {
      businessErrors.push(issue(`/dimensions/${index}/anchors`, "必须完整且唯一地定义1到5分锚点"));
    }
  }

  const orderedGates = [...gates].sort((left, right) => numberOf(left.order) - numberOf(right.order));
  const gateIds = orderedGates.map((gate) => String(gate.id ?? ""));
  if (JSON.stringify(gateIds) !== JSON.stringify(requiredGateOrder)) {
    businessErrors.push(issue("/gates", `门槛顺序必须为${requiredGateOrder.join(" -> ")}`));
  }
  checkUniqueIds(gates, "/gates", businessErrors);

  for (const [index, gate] of orderedGates.entries()) {
    if (gate.critical !== true) {
      businessErrors.push(issue(`/gates/${index}/critical`, "规则包声明的门槛均必须标记为关键门槛"));
    }
    const statuses = (Array.isArray(gate.criteria) ? gate.criteria : [])
      .map((criterion) => isRecord(criterion) ? String(criterion.status ?? "") : "")
      .sort();
    if (JSON.stringify(statuses) !== JSON.stringify(REQUIRED_GATE_STATUSES)) {
      businessErrors.push(issue(`/gates/${index}/criteria`, "门槛必须完整定义pass、fail、unconfirmed三态"));
    }
    const unconfirmedAction = isRecord(gate.unconfirmed_action) ? gate.unconfirmed_action : {};
    if (unconfirmedAction.generate_supplement_request !== true) {
      businessErrors.push(issue(`/gates/${index}/unconfirmed_action`, "未确认时必须生成补充材料任务"));
    }
  }

  const workflow = isRecord(template.workflow) ? template.workflow : {};
  const workflowSteps = Array.isArray(workflow.ordered_steps)
    ? workflow.ordered_steps.slice(0, requiredGateOrder.length)
    : [];
  if (JSON.stringify(workflowSteps) !== JSON.stringify(requiredGateOrder)) {
    businessErrors.push(issue("/workflow/ordered_steps", "工作流必须先按当前规则包规定的顺序检查门槛"));
  }
  if (workflow.ai_can_auto_reject !== false) {
    businessErrors.push(issue("/workflow/ai_can_auto_reject", "AI不得自动触发否决"));
  }
  if (workflow.human_final_decision_required !== true) {
    businessErrors.push(issue("/workflow/human_final_decision_required", "最终决策必须由人工确认"));
  }

  const rules = isRecord(template.decision_rules) ? template.decision_rules : {};
  checkTrue(rules, "two_or_more_failed_gates_block_final_decision", businessErrors);
  checkTrue(rules, "unconfirmed_gate_blocks_recommendation", businessErrors);
  checkTrue(rules, "unconfirmed_is_not_failure", businessErrors);
  checkTrue(rules, "gates_cannot_be_offset_by_score", businessErrors);
  checkTrue(rules, "ai_can_only_recommend_gate_result", businessErrors);
  checkTrue(rules, "manual_gate_change_requires_reason", businessErrors);

  const sensitiveFields = Array.isArray(template.sensitive_fields_excluded)
    ? template.sensitive_fields_excluded.map(String)
    : [];
  if (!sensitiveFields.includes("年龄")) {
    businessErrors.push(issue("/sensitive_fields_excluded", "年龄必须排除在评分输入之外"));
  }

  const generation = isRecord(template.generation) ? template.generation : {};
  if (generation.policy_pack_match === "fallback") {
    businessErrors.push(issue(
      "/generation/policy_pack_match",
      "当前行业和赛道未匹配到已审核规则包，探索草案不得发布"
    ));
  }
  if (template.status === "published" && !generation.approved_by) {
    businessErrors.push(issue("/generation/approved_by", "已发布模板必须记录人工审批人"));
  }

  if (template.status === "ai_generated_draft") {
    warnings.push(issue("/status", "当前为AI生成草案，必须完成人工确认后才能发布"));
  }

  return {
    valid: schemaErrors.length === 0 && businessErrors.length === 0,
    schema_errors: schemaErrors,
    business_errors: businessErrors,
    warnings,
    checked_at: new Date().toISOString()
  };
}

function checkUniqueIds(items: JsonObject[], path: string, errors: ValidationIssue[]): void {
  const ids = items.map((item) => String(item.id ?? ""));
  if (new Set(ids).size !== ids.length) {
    errors.push(issue(path, "ID必须唯一"));
  }
}

function checkTrue(record: JsonObject, field: string, errors: ValidationIssue[]): void {
  if (record[field] !== true) {
    errors.push(issue(`/decision_rules/${field}`, `${field}必须为true`));
  }
}

function issue(path: string, message: string): ValidationIssue {
  return { path, message };
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : Number.POSITIVE_INFINITY;
}
