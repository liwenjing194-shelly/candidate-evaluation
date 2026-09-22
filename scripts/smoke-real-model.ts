import path from "node:path";
import { MockTemplateProvider } from "../src/providers/mock-template-provider.js";
import { DashScopeTemplateProvider } from "../src/providers/dashscope-template-provider.js";
import { PolicyPackRegistry } from "../src/policy/policy-pack-registry.js";
import { SchemaValidator } from "../src/validation/schema-validator.js";

// No candidate data, database writes, key or raw provider-response logging.
const registry = new PolicyPackRegistry(path.resolve("data/policy-packs"));
const schemas = new SchemaValidator(path.resolve("schemas/template-generator-input.schema.json"), path.resolve("schemas/evaluation-template.schema.json"), path.resolve("schemas/golden-evaluation.schema.json"));
const provider = new DashScopeTemplateProvider(new MockTemplateProvider(registry), schemas, { apiKey: process.env.DASHSCOPE_API_KEY ?? "", model: process.env.TEMPLATE_MODEL ?? "qwen-plus" });
try {
  const result = await provider.generate({ schema_version: "1.0", request_id: "synthetic-model-smoke", industry: { name: "广告" }, track: { name: "广告投放自动化软件" }, investment_purpose: "investment_screening", project_stage: "已有团队准备规模化", candidate_role: "团队负责人", jurisdiction: "中国大陆", language: "zh-CN" });
  console.log(JSON.stringify({ success: true, model: result.generation.model, industry_definition: result.scope.industry_definition, track_definition: result.scope.track_definition, dimensions: result.dimensions.map(d => ({ name: d.name, weight: d.weight })), gates: result.gates.map(g => g.name), schema_errors: schemas.validateTemplate(result).length }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Model smoke failed");
  process.exitCode = 1;
}
