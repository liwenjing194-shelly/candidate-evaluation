import type { EvaluationTemplate, JsonObject, TemplateGeneratorInput } from "../domain/types.js";
import { cloneJson } from "../lib/json.js";
import type { PolicyPackRegistry } from "../policy/policy-pack-registry.js";
import type { TemplateProvider } from "./template-provider.js";

export class MockTemplateProvider implements TemplateProvider {
  constructor(private readonly policyPacks: PolicyPackRegistry) {}

  async generate(input: TemplateGeneratorInput): Promise<EvaluationTemplate> {
    const resolved = this.policyPacks.resolve(input);
    const template = cloneJson(resolved.template);
    const industry = input.industry.name;
    const track = input.track.name;
    const industryCode = stringValue(input.industry.normalized_code) ?? slugify(industry);
    const trackCode = stringValue(input.track.normalized_code) ?? slugify(track);
    const isExactMatch = resolved.match === "exact";

    template.template_id = isExactMatch
      ? resolved.manifest.policy_pack_id
      : `${industryCode}_${trackCode}_team_lead_investment`;
    template.version = "1.0.0";
    template.name = `${track}团队负责人投资评估模板`;
    template.status = "ai_generated_draft";
    template.description = template.generation.prompt_version === "industry-rules-v2" ? String(template.description) : isExactMatch
      ? `Mock Provider基于已审核的${resolved.manifest.name}生成模板草案，必须经人工确认后发布。`
      : `Mock Provider未找到${industry}/${track}专属规则包，临时使用${resolved.manifest.name}验证流程，行业专属内容必须由人工重写和确认。`;

    template.scope = {
      ...template.scope,
      industry,
      track,
      investment_purpose: input.investment_purpose,
      project_stage: input.project_stage,
      candidate_role: input.candidate_role,
      jurisdiction: input.jurisdiction
    };

    const generation = template.generation as JsonObject;
    generation.method = "base_template_plus_ai_adaptation";
    generation.generated_at = new Date().toISOString();
    generation.model = "mock-template-provider";
    generation.prompt_version = generation.prompt_version === "industry-rules-v2" ? "industry-rules-v2" : "mock-policy-pack-v1";
    generation.policy_pack_id = resolved.manifest.policy_pack_id;
    generation.policy_pack_version = resolved.manifest.version;
    generation.policy_pack_status = resolved.manifest.status;
    generation.policy_pack_match = resolved.match;
    generation.requires_human_approval = true;
    generation.approved_by = null;
    generation.approved_at = null;

    if (!isExactMatch) {
      const notes = Array.isArray(template.scope.applicability_notes)
        ? template.scope.applicability_notes
        : [];
      template.scope.applicability_notes = [
        ...notes,
        `当前未找到${industry}/${track}已审核规则包，评分维度、投资门槛和监管来源不能直接用于真实投资决策`
      ];
    }

    return template;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function slugify(value: string): string {
  const ascii = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return ascii || `term_${Buffer.from(value).toString("hex").slice(0, 16)}`;
}
