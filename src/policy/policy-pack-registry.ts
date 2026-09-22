import fs from "node:fs";
import path from "node:path";
import type {
  EvaluationTemplate,
  PolicyPackManifest,
  PolicyPackTaxonomyTerm,
  ResolvedPolicyPack,
  TemplateGeneratorInput
} from "../domain/types.js";
import { isJsonObject, readJsonFile } from "../lib/json.js";
import { buildIndustryTemplate } from "./industry-rule-builder.js";

interface LoadedPolicyPack {
  manifest: PolicyPackManifest;
  template: EvaluationTemplate;
}

export class PolicyPackRegistry {
  private packs: LoadedPolicyPack[] = [];
  private readonly policyPackDirectory: string;

  constructor(policyPackDirectory: string) {
    this.policyPackDirectory = policyPackDirectory;
    this.reload();
  }

  reload(): void {
    const policyPackDirectory = this.policyPackDirectory;
    if (!fs.existsSync(policyPackDirectory)) {
      throw new Error(`规则包目录不存在：${policyPackDirectory}`);
    }

    const manifestPaths = fs.readdirSync(policyPackDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".policy-pack.json"))
      .map((entry) => path.join(policyPackDirectory, entry.name))
      .sort();

    const packs = manifestPaths.map((manifestPath) => loadPolicyPack(manifestPath));
    if (packs.length === 0) {
      throw new Error(`规则包目录中没有*.policy-pack.json文件：${policyPackDirectory}`);
    }
    this.packs = packs;
  }

  resolve(input: TemplateGeneratorInput): ResolvedPolicyPack {
    const exact = this.packs.find((pack) => matches(pack.manifest, input));
    if (exact) return { ...exact, match: "exact" };

    const fallback = this.packs.find((pack) => pack.manifest.default_for_mock) ?? this.packs[0];
    if (!fallback) throw new Error("没有可用的规则包");
    const template = buildIndustryTemplate(fallback.template, input.industry.name, input.track.name);
    const manifest = structuredClone(fallback.manifest);
    manifest.policy_pack_id = template.template_id;
    manifest.name = template.name;
    manifest.status = "draft";
    manifest.taxonomy = { industry: { code: String(input.industry.normalized_code ?? input.industry.name), name: input.industry.name, aliases: [] }, track: { code: String(input.track.normalized_code ?? input.track.name), name: input.track.name, aliases: [] } };
    manifest.required_gate_order = template.gates.map(g => String(g.id));
    template.generation.policy_pack_status = "draft";
    return { manifest, template, match: "exact" };
  }

  list(): PolicyPackManifest[] {
    return this.packs.map((pack) => structuredClone(pack.manifest));
  }

  getManifest(policyPackId: string): PolicyPackManifest | null {
    const pack = this.packs.find((candidate) => candidate.manifest.policy_pack_id === policyPackId);
    return pack ? structuredClone(pack.manifest) : null;
  }
}

function loadPolicyPack(manifestPath: string): LoadedPolicyPack {
  const rawManifest = readJsonFile(manifestPath);
  assertManifest(rawManifest, manifestPath);
  const templatePath = path.resolve(path.dirname(manifestPath), rawManifest.template_file);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`规则包模板文件不存在：${templatePath}`);
  }
  let template = readJsonFile<EvaluationTemplate>(templatePath);
  if (template.generation.prompt_version === "industry-track-wizard-v1") {
    template = buildIndustryTemplate(template, rawManifest.taxonomy.industry.name, rawManifest.taxonomy.track.name, rawManifest.policy_pack_id);
    rawManifest.required_gate_order = template.gates.map(g => String(g.id));
  }
  if (template.template_id !== rawManifest.policy_pack_id) {
    throw new Error(`规则包${rawManifest.policy_pack_id}与模板template_id不一致`);
  }
  const gateOrder = [...template.gates]
    .sort((left, right) => Number(left.order) - Number(right.order))
    .map((gate) => String(gate.id));
  if (JSON.stringify(gateOrder) !== JSON.stringify(rawManifest.required_gate_order)) {
    throw new Error(`规则包${rawManifest.policy_pack_id}的门槛顺序与模板不一致`);
  }
  return { manifest: rawManifest, template };
}

function assertManifest(value: unknown, source: string): asserts value is PolicyPackManifest {
  if (!isJsonObject(value)) throw new Error(`规则包清单必须是JSON对象：${source}`);
  const requiredStrings = ["schema_version", "policy_pack_id", "version", "name", "status", "template_file"];
  for (const field of requiredStrings) {
    if (typeof value[field] !== "string" || String(value[field]).trim().length === 0) {
      throw new Error(`规则包清单缺少${field}：${source}`);
    }
  }
  if (!isJsonObject(value.taxonomy) || !isTaxonomyTerm(value.taxonomy.industry) || !isTaxonomyTerm(value.taxonomy.track)) {
    throw new Error(`规则包清单taxonomy不完整：${source}`);
  }
  if (!isJsonObject(value.definitions)
    || typeof value.definitions.industry !== "string"
    || typeof value.definitions.track !== "string") {
    throw new Error(`规则包清单缺少行业或赛道定义：${source}`);
  }
  if (!Array.isArray(value.required_gate_order) || value.required_gate_order.length === 0) {
    throw new Error(`规则包清单缺少required_gate_order：${source}`);
  }
  if (!isJsonObject(value.applicability) || !isJsonObject(value.governance_rules) || !isJsonObject(value.review)) {
    throw new Error(`规则包清单的适用范围、治理规则或审核信息不完整：${source}`);
  }
}

function isTaxonomyTerm(value: unknown): value is PolicyPackTaxonomyTerm {
  return isJsonObject(value)
    && typeof value.code === "string"
    && typeof value.name === "string"
    && Array.isArray(value.aliases);
}

function matches(manifest: PolicyPackManifest, input: TemplateGeneratorInput): boolean {
  return matchesTerm(manifest.taxonomy.industry, input.industry)
    && matchesTerm(manifest.taxonomy.track, input.track);
}

function matchesTerm(rule: PolicyPackTaxonomyTerm, input: TemplateGeneratorInput["industry"]): boolean {
  const candidates = [input.normalized_code, input.name]
    .filter((value): value is string => typeof value === "string")
    .map(normalizeTerm);
  const accepted = [rule.code, rule.name, ...rule.aliases.map(String)].map(normalizeTerm);
  return candidates.some((candidate) => accepted.includes(candidate));
}

function normalizeTerm(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_-]+/g, "");
}
