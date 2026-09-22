import { randomUUID } from "node:crypto";
import type {
  EvaluationTemplate,
  JsonObject,
  TemplateGeneratorInput,
  TemplateRecord,
  ValidationReport
} from "../domain/types.js";
import { AppDatabase } from "../db/database.js";
import { cloneJson, isJsonObject } from "../lib/json.js";
import type { PolicyPackRegistry } from "../policy/policy-pack-registry.js";
import type { TemplateProvider } from "../providers/template-provider.js";
import { validateTemplateBusinessRules } from "../validation/business-validator.js";
import { SchemaValidator } from "../validation/schema-validator.js";

export class ServiceError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export class TemplateService {
  constructor(
    private readonly database: AppDatabase,
    private readonly provider: TemplateProvider,
    private readonly schemas: SchemaValidator,
    private readonly policyPacks: PolicyPackRegistry
  ) {}

  async generate(input: unknown): Promise<JsonObject> {
    const inputErrors = this.schemas.validateInput(input);
    if (inputErrors.length > 0) {
      throw new ServiceError("生成请求不符合输入规范", 400, inputErrors);
    }

    const typedInput = input as TemplateGeneratorInput;
    const template = await this.provider.generate(typedInput);
    const report = this.validateTemplate(template);
    const result = this.database.createGenerationWithDraft({
      generationId: randomUUID(),
      request: typedInput,
      template,
      validationReport: report
    });

    return {
      generation: result.generation as unknown as JsonObject,
      template: result.template as unknown as JsonObject
    };
  }

  getGeneration(id: string): JsonObject {
    const generation = this.database.getGeneration(id);
    if (!generation) throw new ServiceError("未找到模板生成任务", 404);
    return generation as unknown as JsonObject;
  }

  getTemplate(id: string): JsonObject {
    const template = this.database.getTemplate(id);
    if (!template) throw new ServiceError("未找到模板草案", 404);
    return template as unknown as JsonObject;
  }

  updateTemplate(id: string, body: unknown): JsonObject {
    const existing = this.database.getTemplate(id);
    if (!existing) throw new ServiceError("未找到模板草案", 404);
    if (!isJsonObject(body)) throw new ServiceError("请求体必须是JSON对象", 400);

    const editedBy = requiredString(body.edited_by, "edited_by");
    const editReason = requiredString(body.edit_reason, "edit_reason");
    if (!isJsonObject(body.template)) {
      throw new ServiceError("template必须是完整的模板JSON对象", 400);
    }

    const schemaErrors = this.schemas.validateTemplate(body.template);
    if (schemaErrors.length > 0) {
      throw new ServiceError("模板结构不符合JSON Schema，未保存", 400, schemaErrors);
    }

    const template = cloneJson(body.template) as EvaluationTemplate;
    if (template.template_id !== existing.template_key) {
      throw new ServiceError("人工编辑不得修改template_id", 400);
    }
    if (existing.status === "published" && !hasSubstantiveChanges(existing.content, template)) {
      throw new ServiceError("已发布模板没有实质修改，不会创建重复版本", 409);
    }

    template.status = "draft";
    const generation = template.generation;
    generation.approved_by = null;
    generation.approved_at = null;

    const report = this.validateTemplate(template);
    const record = this.database.updateTemplate({
      id,
      content: template,
      status: report.valid ? "draft" : "validation_failed",
      editedBy,
      editReason
    });
    this.database.updateGenerationValidationByTemplate(id, report);

    return {
      template: record as unknown as JsonObject,
      validation_report: report as unknown as JsonObject
    };
  }

  validateStoredTemplate(id: string): JsonObject {
    const template = this.database.getTemplate(id);
    if (!template) throw new ServiceError("未找到模板草案", 404);
    const report = this.validateTemplate(template.content);
    this.database.updateGenerationValidationByTemplate(id, report);
    return report as unknown as JsonObject;
  }

  publishTemplate(id: string, body: unknown): JsonObject {
    const existing = this.database.getTemplate(id);
    if (!existing) throw new ServiceError("未找到模板草案", 404);
    if (!isJsonObject(body)) throw new ServiceError("请求体必须是JSON对象", 400);
    if (existing.status === "published") {
      throw new ServiceError("当前草案已经发布；请先人工修改形成新草案后再发布新版本", 409);
    }

    const approvedBy = requiredString(body.approved_by, "approved_by");
    const approvalNote = requiredString(body.approval_note, "approval_note");
    const versions = this.database.listVersionsByTemplateKey(existing.template_key);
    const nextVersion = calculateNextVersion(existing, versions.map((version) => version.version));
    const publishedTemplate = cloneJson(existing.content);
    publishedTemplate.version = nextVersion;
    publishedTemplate.status = "published";
    publishedTemplate.generation.approved_by = approvedBy;
    publishedTemplate.generation.approved_at = new Date().toISOString();

    const report = this.validateTemplate(publishedTemplate);
    if (!report.valid) {
      throw new ServiceError("模板未通过校验，不能发布", 409, report);
    }

    const result = this.database.publishTemplate({
      templateId: id,
      content: publishedTemplate,
      version: nextVersion,
      approvedBy,
      approvalNote
    });

    return {
      template: result.template as unknown as JsonObject,
      published_version: result.version as unknown as JsonObject,
      validation_report: report as unknown as JsonObject
    };
  }

  listVersions(id: string): JsonObject {
    const template = this.database.getTemplate(id);
    if (!template) throw new ServiceError("未找到模板", 404);
    return {
      template_id: id,
      versions: this.database.listVersions(id) as unknown as JsonObject["versions"]
    };
  }

  private validateTemplate(template: EvaluationTemplate): ValidationReport {
    const schemaErrors = this.schemas.validateTemplate(template);
    const generation = isJsonObject(template.generation) ? template.generation : {};
    const policyPackId = typeof generation.policy_pack_id === "string"
      ? generation.policy_pack_id
      : template.template_id;
    const manifest = this.policyPacks.getManifest(policyPackId);
    const requiredGateOrder = manifest?.required_gate_order.map(String) ?? ["sector_rights_and_safety", "leader_integrity_and_verifiability", "commercialization_path", "conflict_of_interest"];
    const policy = requiredGateOrder ? { requiredGateOrder } : {};
    return validateTemplateBusinessRules(template, schemaErrors, policy);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length < 2) {
    throw new ServiceError(`${field}至少需要2个字符`, 400);
  }
  return value.trim();
}

function calculateNextVersion(template: TemplateRecord, existingVersions: string[]): string {
  if (existingVersions.length === 0) return template.content.version;
  const parsed = existingVersions
    .map((version) => version.split(".").map(Number))
    .filter((parts) => parts.length === 3 && parts.every(Number.isInteger))
    .sort((left, right) => {
      for (let index = 0; index < 3; index += 1) {
        const difference = (right[index] ?? 0) - (left[index] ?? 0);
        if (difference !== 0) return difference;
      }
      return 0;
    });
  const latest = parsed[0] ?? [1, 0, 0];
  return `${latest[0] ?? 1}.${latest[1] ?? 0}.${(latest[2] ?? 0) + 1}`;
}

function hasSubstantiveChanges(existing: EvaluationTemplate, candidate: EvaluationTemplate): boolean {
  return templateRevisionFingerprint(existing) !== templateRevisionFingerprint(candidate);
}

function templateRevisionFingerprint(template: EvaluationTemplate): string {
  const comparable = cloneJson(template);
  comparable.status = "managed-by-system";
  comparable.version = "managed-by-system";
  comparable.generation.approved_by = null;
  comparable.generation.approved_at = null;
  return JSON.stringify(comparable);
}
