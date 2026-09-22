import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const errors = [];
let checkCount = 0;

function loadJson(relativePath) {
  const absolutePath = path.join(root, relativePath);
  try {
    return JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: JSON读取失败 - ${error.message}`);
    return null;
  }
}

function check(condition, message) {
  checkCount += 1;
  if (!condition) errors.push(message);
}

function sameArray(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function unique(values) {
  return new Set(values).size === values.length;
}

const schemaFiles = [
  "schemas/template-generator-input.schema.json",
  "schemas/evaluation-template.schema.json",
  "schemas/golden-evaluation.schema.json",
  "schemas/policy-pack.schema.json"
];

for (const schemaFile of schemaFiles) {
  const schema = loadJson(schemaFile);
  if (schema) {
    check(schema.$schema === "https://json-schema.org/draft/2020-12/schema", `${schemaFile}: 必须使用JSON Schema 2020-12`);
    check(Boolean(schema.$id), `${schemaFile}: 缺少$id`);
  }
}

const generatorInput = loadJson("data/templates/ai-short-drama-generator-input.v1.json");
const policyPackPath = "data/policy-packs/ai-short-drama-team-lead-investment.v1.policy-pack.json";
const policyPack = loadJson(policyPackPath);
const template = policyPack?.template_file
  ? loadJson(path.join(path.dirname(policyPackPath), policyPack.template_file))
  : null;
const golden = loadJson("data/golden/ai-short-drama-expected-evaluations.v1.json");
const seed = loadJson("候选人评估系统_模拟候选人_seed.json");
const agenticPolicyPackPath = "data/policy-packs/agentic-commerce-team-lead-investment.v1.policy-pack.json";
const agenticPolicyPack = loadJson(agenticPolicyPackPath);
const agenticTemplate = agenticPolicyPack?.template_file
  ? loadJson(path.join(path.dirname(agenticPolicyPackPath), agenticPolicyPack.template_file))
  : null;
const agenticGolden = loadJson("data/golden/agentic-commerce-expected-evaluations.v1.json");
const agenticSeed = loadJson("Agentic_Commerce_模拟候选人_seed.json");
const benchmarkRegistry = loadJson("data/benchmark-library/registry.v1.json");
const collectionTargets = loadJson("data/benchmark-library/collection-targets.v1.json");

if (benchmarkRegistry) {
  check(Array.isArray(benchmarkRegistry.libraries) && benchmarkRegistry.libraries.length >= 2, "样本库注册表: 至少需要两条行业赛道配置");
  check(Boolean(benchmarkRegistry.default_track_code), "样本库注册表: 缺少默认赛道");
  const registeredTracks = new Set();
  for (const library of benchmarkRegistry.libraries ?? []) {
    check(typeof library.track_code === "string" && library.track_code.length > 0, "样本库注册表: 缺少track_code");
    check(!registeredTracks.has(library.track_code), `样本库注册表: track_code重复 ${library.track_code}`);
    registeredTracks.add(library.track_code);
    for (const key of ["source_catalog_path", "seed_path", "methodology_path"]) {
      const file = path.join("data/benchmark-library", library[key] ?? "");
      const loaded = loadJson(file);
      check(Boolean(loaded), `样本库注册表: ${library.track_code}缺少${key}文件`);
    }
  }
  check(registeredTracks.has(benchmarkRegistry.default_track_code), "样本库注册表: 默认赛道未登记");
}

if (collectionTargets && benchmarkRegistry) {
  const registeredTracks = new Set((benchmarkRegistry.libraries ?? []).map((library) => library.track_code));
  const planTracks = new Set();
  for (const plan of collectionTargets.plans ?? []) {
    check(typeof plan.track_code === "string" && plan.track_code.length > 0, "自动采集计划: 缺少track_code");
    check(!planTracks.has(plan.track_code), `自动采集计划: track_code重复 ${plan.track_code}`);
    planTracks.add(plan.track_code);
    check(registeredTracks.has(plan.track_code), `自动采集计划: 赛道未在样本库注册 ${plan.track_code}`);
    check(Array.isArray(plan.targets) && plan.targets.length > 0, `自动采集计划: ${plan.track_code}没有目标企业`);
    for (const target of plan.targets ?? []) {
      check(typeof target.target_key === "string" && target.target_key.length > 0, `自动采集计划${plan.track_code}: 目标缺少target_key`);
      check(Array.isArray(target.urls) && target.urls.length > 0, `自动采集计划${plan.track_code}/${target.target_key}: 没有来源网址`);
      for (const sourceTarget of target.urls ?? []) {
        check(typeof sourceTarget.source_code === "string" && sourceTarget.source_code.length > 0, `自动采集计划${plan.track_code}/${target.target_key}: 来源缺少source_code`);
        check(/^https?:\/\//i.test(sourceTarget.url ?? ""), `自动采集计划${plan.track_code}/${target.target_key}: 网址必须为HTTP或HTTPS`);
      }
    }
  }
  check(planTracks.size === registeredTracks.size, "自动采集计划: 每个已注册赛道都必须有计划，避免页面选择后静默无采集");
}

if (generatorInput) {
  check(generatorInput.schema_version === "1.0", "生成器输入: schema_version必须为1.0");
  check(Boolean(generatorInput.industry?.name), "生成器输入: 缺少行业");
  check(Boolean(generatorInput.track?.name), "生成器输入: 缺少赛道");
  check(generatorInput.investment_purpose === "investment_screening", "生成器输入: 投资目的必须为investment_screening");
  check(generatorInput.generation_constraints?.require_human_approval === true, "生成器输入: 必须要求人工审批");
}

const requiredGateIds = policyPack?.required_gate_order ?? [];
const requiredGateStatuses = ["pass", "fail", "unconfirmed"];

if (policyPack) {
  check(policyPack.schema_version === "1.0", "规则包: schema_version必须为1.0");
  check(policyPack.status === "approved", "规则包: AI短剧基线必须处于approved状态");
  check(policyPack.default_for_mock === true, "规则包: AI短剧基线必须标记为Mock默认包");
  check(policyPack.taxonomy?.industry?.code === "culture_media", "规则包: 行业标准代码不正确");
  check(policyPack.taxonomy?.track?.code === "ai_short_drama", "规则包: 赛道标准代码不正确");
  check(Array.isArray(policyPack.required_gate_order) && policyPack.required_gate_order.length === 4, "规则包: 必须声明四项门槛顺序");
  check(Boolean(policyPack.review?.approved_by), "规则包: 缺少人工审核人");
  check(Boolean(policyPack.review?.approved_at), "规则包: 缺少人工审核时间");
  check(Boolean(policyPack.definitions?.industry) && Boolean(policyPack.definitions?.track), "规则包: 缺少行业或赛道定义");
}

if (agenticPolicyPack && agenticTemplate) {
  const agenticGateIds = [...(agenticTemplate.gates ?? [])]
    .sort((left, right) => left.order - right.order)
    .map((gate) => gate.id);
  const agenticWeight = (agenticTemplate.dimensions ?? [])
    .reduce((sum, dimension) => sum + Number(dimension.weight ?? 0), 0);
  const agenticWorkflowPrefix = (agenticTemplate.workflow?.ordered_steps ?? [])
    .slice(0, agenticPolicyPack.required_gate_order.length);

  check(agenticPolicyPack.status === "approved", "Agentic Commerce规则包: 必须处于approved状态");
  check(agenticPolicyPack.taxonomy?.track?.code === "agentic_commerce", "Agentic Commerce规则包: 赛道标准代码不正确");
  check(agenticTemplate.template_id === agenticPolicyPack.policy_pack_id, "Agentic Commerce规则包: template_id不一致");
  check((agenticTemplate.dimensions ?? []).length === 7, "Agentic Commerce规则包: 应包含7个评分维度");
  check(Math.abs(agenticWeight - 100) < 0.0001, `Agentic Commerce规则包: 权重合计必须为100，当前为${agenticWeight}`);
  check(sameArray(agenticGateIds, agenticPolicyPack.required_gate_order), "Agentic Commerce规则包: 门槛顺序与清单不一致");
  check(sameArray(agenticWorkflowPrefix, agenticPolicyPack.required_gate_order), "Agentic Commerce规则包: 工作流没有优先执行专属门槛");
  check((agenticTemplate.sources ?? []).length >= 5, "Agentic Commerce规则包: 行业依据来源不足");
  check(Boolean(agenticPolicyPack.definitions?.industry) && Boolean(agenticPolicyPack.definitions?.track), "Agentic Commerce规则包: 缺少行业或赛道定义");
}

if (template) {
  check(template.schema_version === "1.0", "模板: schema_version必须为1.0");
  check(template.status !== "published", "模板: 未经人工审批的初始模板不得直接发布");
  check(template.generation?.requires_human_approval === true, "模板: 必须要求人工审批");
  check(template.workflow?.ai_can_auto_reject === false, "模板: AI不得自动否决");
  check(template.workflow?.human_final_decision_required === true, "模板: 最终决策必须由人工确认");

  const dimensions = template.dimensions ?? [];
  const dimensionIds = dimensions.map((dimension) => dimension.id);
  const totalWeight = dimensions.reduce((sum, dimension) => sum + Number(dimension.weight ?? 0), 0);
  check(dimensions.length >= 4 && dimensions.length <= 10, "模板: 评分维度数量必须为4到10个");
  check(unique(dimensionIds), "模板: 评分维度ID必须唯一");
  check(Math.abs(totalWeight - 100) < 0.0001, `模板: 权重合计必须为100，当前为${totalWeight}`);

  for (const dimension of dimensions) {
    check(Array.isArray(dimension.sub_indicators) && dimension.sub_indicators.length >= 2 && dimension.sub_indicators.length <= 4, `维度${dimension.id}: 子指标必须为2到4个`);
    const anchorScores = (dimension.anchors ?? []).map((anchor) => anchor.score).sort((a, b) => a - b);
    check(sameArray(anchorScores, [1, 2, 3, 4, 5]), `维度${dimension.id}: 必须完整定义1到5分锚点`);
    check((dimension.required_evidence ?? []).length > 0, `维度${dimension.id}: 缺少证据要求`);
    check((dimension.verification_methods ?? []).length > 0, `维度${dimension.id}: 缺少核验方式`);
  }

  const orderedGates = [...(template.gates ?? [])].sort((a, b) => a.order - b.order);
  const gateIds = orderedGates.map((gate) => gate.id);
  check(sameArray(gateIds, requiredGateIds), `模板: 门槛顺序必须为${requiredGateIds.join(" -> ")}`);
  check(unique((template.gates ?? []).map((gate) => gate.id)), "模板: 门槛ID必须唯一");

  for (const gate of orderedGates) {
    const statuses = (gate.criteria ?? []).map((criterion) => criterion.status).sort();
    check(sameArray(statuses, [...requiredGateStatuses].sort()), `门槛${gate.id}: 必须包含pass、fail、unconfirmed三态`);
    check(gate.critical === true, `门槛${gate.id}: 四项门槛均必须为关键门槛`);
    check(gate.unconfirmed_action?.generate_supplement_request === true, `门槛${gate.id}: 未确认时必须生成补件任务`);
  }

  const workflowPrefix = (template.workflow?.ordered_steps ?? []).slice(0, 4);
  check(sameArray(workflowPrefix, requiredGateIds), "模板: 工作流必须先按规定顺序检查四项门槛");
  check(template.decision_rules?.two_or_more_failed_gates_block_final_decision === true, "模板: 两项及以上门槛失败必须阻断最终决策");
  check(template.decision_rules?.unconfirmed_gate_blocks_recommendation === true, "模板: 任一门槛未确认必须阻止推荐投资");
  check(template.decision_rules?.unconfirmed_is_not_failure === true, "模板: 未确认不得自动等于不符合");
  check(template.decision_rules?.gates_cannot_be_offset_by_score === true, "模板: 门槛不得被综合评分抵消");
  check(template.decision_rules?.manual_gate_change_requires_reason === true, "模板: 人工修改门槛必须填写理由");
  check((template.sensitive_fields_excluded ?? []).includes("年龄"), "模板: 年龄必须排除在评分输入之外");
}

if (seed) {
  check(seed.synthetic === true, "模拟数据集: 顶层必须标记synthetic=true");
  check((seed.candidates ?? []).every((candidate) => candidate.synthetic === true), "模拟数据集: 每名候选人必须标记synthetic=true");
  check((seed.candidates ?? []).every((candidate) => Array.isArray(candidate.works) && candidate.works.length > 0), "模拟数据集: 每名候选人至少要有一个作品");
}

if (agenticSeed) {
  check(agenticSeed.schema_version === "1.0", "Agentic Commerce模拟数据集: schema_version必须为1.0");
  check(agenticSeed.dataset_version === "1.0.0", "Agentic Commerce模拟数据集: dataset_version必须为1.0.0");
  check(agenticSeed.template_id === "agentic_commerce_team_lead_investment", "Agentic Commerce模拟数据集: template_id不正确");
  check(agenticSeed.template_version === "1.0.0", "Agentic Commerce模拟数据集: template_version不正确");
  check(agenticSeed.scenario?.industry_code === "business_services", "Agentic Commerce模拟数据集: industry_code不正确");
  check(agenticSeed.scenario?.track_code === "agentic_commerce", "Agentic Commerce模拟数据集: track_code不正确");
  check(agenticSeed.synthetic === true, "Agentic Commerce模拟数据集: 顶层必须标记synthetic=true");
  check((agenticSeed.candidates ?? []).every((candidate) => candidate.synthetic === true), "Agentic Commerce模拟数据集: 每名候选人必须标记synthetic=true");
}

validateGoldenBaseline("AI短剧", golden, template, seed, requiredGateIds);
validateGoldenBaseline(
  "Agentic Commerce",
  agenticGolden,
  agenticTemplate,
  agenticSeed,
  agenticPolicyPack?.required_gate_order ?? []
);

function validateGoldenBaseline(label, expected, baselineTemplate, sourceSeed, expectedGateIds) {
  if (!expected || !baselineTemplate || !sourceSeed) return;
  check(expected.template_id === baselineTemplate.template_id, `${label}黄金集: template_id必须与模板一致`);
  check(expected.template_version === baselineTemplate.version, `${label}黄金集: template_version必须与模板一致`);
  check(expected.source_dataset && expected.source_dataset.length > 0, `${label}黄金集: 必须记录source_dataset`);

  const seedCandidateIds = new Set((sourceSeed.candidates ?? []).map((candidate) => candidate.id));
  const dimensionIds = (baselineTemplate.dimensions ?? []).map((dimension) => dimension.id);

  for (const candidate of expected.candidates ?? []) {
    check(seedCandidateIds.has(candidate.candidate_id), `${label}黄金集${candidate.candidate_id}: 在seed数据中不存在`);
    const gates = candidate.expected_gates ?? [];
    const gateIds = gates.map((gate) => gate.gate_id);
    check(sameArray(gateIds, expectedGateIds), `${label}黄金集${candidate.candidate_id}: 门槛顺序或数量不正确`);

    const failedCount = gates.filter((gate) => gate.expected_status === "fail").length;
    const unconfirmedCount = gates.filter((gate) => gate.expected_status === "unconfirmed").length;
    const vetoCount = gates.filter((gate) => gate.veto_triggered).length;
    check(candidate.failed_gate_count === failedCount, `${label}黄金集${candidate.candidate_id}: failed_gate_count与门槛明细不一致`);
    check(candidate.unconfirmed_gate_count === unconfirmedCount, `${label}黄金集${candidate.candidate_id}: unconfirmed_gate_count与门槛明细不一致`);

    if (unconfirmedCount > 0) {
      check(candidate.prohibited_conclusions.includes("recommend_investment"), `${label}黄金集${candidate.candidate_id}: 门槛未确认时必须禁止推荐投资`);
      const supplementedGateIds = new Set((candidate.supplement_requests ?? []).map((request) => request.gate_id));
      for (const gate of gates.filter((item) => item.expected_status === "unconfirmed")) {
        check(supplementedGateIds.has(gate.gate_id), `${label}黄金集${candidate.candidate_id}: 未确认门槛${gate.gate_id}缺少补件任务`);
      }
    }

    if (failedCount >= 2 || vetoCount > 0) {
      check(candidate.scoring?.allowed === false, `${label}黄金集${candidate.candidate_id}: 两项失败或否决性问题出现后不得进入正式评分`);
      check(candidate.prohibited_conclusions.includes("recommend_investment"), `${label}黄金集${candidate.candidate_id}: 阻断状态必须禁止推荐投资`);
    }

    if (candidate.scoring?.allowed) {
      check(Boolean(candidate.scoring.overall_score_range), `${label}黄金集${candidate.candidate_id}: 允许评分时必须定义综合分区间`);
      const rangeIds = (candidate.scoring.dimension_score_ranges ?? []).map((range) => range.dimension_id);
      check(rangeIds.length === dimensionIds.length && dimensionIds.every((id) => rangeIds.includes(id)), `${label}黄金集${candidate.candidate_id}: 必须为每个评分维度定义预期区间`);
      for (const range of candidate.scoring.dimension_score_ranges ?? []) {
        check(range.min <= range.max, `${label}黄金集${candidate.candidate_id}/${range.dimension_id}: 最小分不得大于最大分`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`校验失败：${errors.length}个问题（执行${checkCount}项检查）`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`校验通过：共执行${checkCount}项结构与业务规则检查。`);
console.log("模板权重、评分锚点、门槛顺序、决策限制和A/B/C黄金预期均一致。");
