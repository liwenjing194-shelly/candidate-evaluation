import { createHash } from "node:crypto";
import type { AppDatabase } from "../db/database.js";
import type { EvaluationTemplate, JsonObject } from "../domain/types.js";
import { isJsonObject } from "../lib/json.js";
import type { SchemaValidator } from "../validation/schema-validator.js";
import { validateTemplateBusinessRules } from "../validation/business-validator.js";
import type { EvaluationTaskService } from "./evaluation-task-service.js";
import { ServiceError } from "./template-service.js";

const FORMAT = "candidate-portable-backup-v1";
const LIMIT = 9 * 1024 * 1024;
export class PortableBackupService {
  constructor(private readonly database: AppDatabase, private readonly schemas: SchemaValidator, private readonly tasks: EvaluationTaskService) {}

  export(): JsonObject {
    // Include drafts and immutable published snapshots; never credentials or raw local files.
    const candidates = [...this.database.listRuleTemplates().map(r => ({ content: r.content, at: r.updated_at })), ...this.database.listPublishedVersions().map(r => ({ content: r.content, at: r.published_at }))]
      .sort((a, b) => a.at.localeCompare(b.at));
    const templates: EvaluationTemplate[] = [];
    const unrestorable_rules: EvaluationTemplate[] = [];
    for (const { content } of candidates) {
      const errors = this.schemas.validateTemplate(content);
      const valid = errors.length === 0 && validateTemplateBusinessRules(content, [], { requiredGateOrder: content.gates.map(g => String(g.id)) }).valid;
      (valid ? templates : unrestorable_rules).push(content);
    }
    const reports = [...this.database.listEvaluationTasks().map(task => this.tasks.getReport(task.id)), ...this.database.exportReportArchives()];
    const result = { format: FORMAT, exported_at: new Date().toISOString(), templates, reports, unrestorable_rules,
      warnings: unrestorable_rules.length ? [`${unrestorable_rules.length}份历史规则未通过校验，仅保存在unrestorable_rules附录，不能自动恢复。`] : [],
      scope: "包含规则内容与评估报告。规则恢复为待审草案；报告仅供只读存档，不恢复运行中的任务、原始附件、样本库或审计数据库。" };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > LIMIT) throw new ServiceError("备份超过9MB，请先按任务另存报告并联系管理员分批导出；此次未生成不完整备份。", 413);
    return result as unknown as JsonObject;
  }

  restore(body: unknown): JsonObject {
    if (!isJsonObject(body) || body.confirm_restore !== true || !isJsonObject(body.backup)) throw new ServiceError("请选择备份并确认仅新增草案和只读报告，不覆盖现有数据。", 400);
    const bundle = body.backup;
    if (bundle.format !== FORMAT || !Array.isArray(bundle.templates) || !Array.isArray(bundle.reports)) throw new ServiceError("备份格式不正确。", 400);
    if (bundle.templates.length > 1000 || bundle.reports.length > 1000 || Buffer.byteLength(JSON.stringify(bundle), "utf8") > LIMIT) throw new ServiceError("备份超出恢复大小或条数限制。", 413);
    const templates = bundle.templates.map((raw, index) => {
      const errors = this.schemas.validateTemplate(raw);
      if (errors.length) throw new ServiceError(`第${index + 1}份规则结构无效，未写入任何数据。`, 400);
      const template = structuredClone(raw) as unknown as EvaluationTemplate;
      template.status = "draft";
      template.generation.requires_human_approval = true;
      template.generation.approved_by = null;
      template.generation.approved_at = null;
      const report = validateTemplateBusinessRules(template, [], { requiredGateOrder: template.gates.map(g => String(g.id)) });
      if (!report.valid) throw new ServiceError(`第${index + 1}份规则业务校验未通过，未写入任何数据。`, 400);
      return template;
    });
    const reports = bundle.reports.map((report, index) => {
      if (!isJsonObject(report) || typeof report.report_version !== "string" || !isJsonObject(report.task)) throw new ServiceError(`第${index + 1}份报告结构无效，未写入任何数据。`, 400);
      return report;
    });
    const hash = createHash("sha256").update(JSON.stringify({ templates: bundle.templates, reports: bundle.reports })).digest("hex");
    const inserted = this.database.importPortableBackup(hash, templates, reports);
    return { inserted, templates: inserted ? templates.length : 0, report_archives: inserted ? reports.length : 0,
      notice: inserted ? "已新增待检查草案与只读报告存档。未覆盖现有数据，也未自动发布规则或恢复评估任务。" : "该备份已恢复过，未重复导入。" };
  }
}
