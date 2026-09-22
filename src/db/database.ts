import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  BenchmarkEvidenceRecord,
  BenchmarkEvidenceReviewRecord,
  BenchmarkSampleRecord,
  BenchmarkTraitRecord,
  BenchmarkCollectionJobRecord,
  BenchmarkRawDocumentRecord,
  EvaluationAuditRecord,
  EvaluationDataImportRecord,
  EvaluationDecisionRecord,
  EvaluationDimensionScoreRecord,
  EvaluationEvidenceItemRecord,
  EvaluationGateResultRecord,
  EvaluationPreassessmentRunRecord,
  EvaluationTaskRecord,
  EvaluationTaskStatus,
  EvaluationTemplate,
  GenerationRecord,
  JsonObject,
  JsonValue,
  SupplementRequestRecord,
  TemplateRecord,
  TemplateVersionRecord,
  TrackOnboardingDraftRecord,
  TrackOnboardingDraftStatus,
  ValidationReport
} from "../domain/types.js";

type Row = Record<string, unknown>;

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  createGenerationWithDraft(params: {
    generationId: string;
    request: JsonObject;
    template: EvaluationTemplate;
    validationReport: ValidationReport;
  }): { generation: GenerationRecord; template: TemplateRecord } {
    const now = new Date().toISOString();
    const templateId = randomUUID();
    const status = params.validationReport.valid ? "completed" : "validation_failed";
    const draftStatus = params.validationReport.valid ? "draft" : "validation_failed";

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        INSERT INTO templates (
          id, template_key, status, content_json, created_at, updated_at,
          last_edited_by, last_edit_reason
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        templateId,
        params.template.template_id,
        draftStatus,
        JSON.stringify(params.template),
        now,
        now
      );

      this.db.prepare(`
        INSERT INTO template_generations (
          id, status, request_json, draft_template_id, validation_report_json,
          error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        params.generationId,
        status,
        JSON.stringify(params.request),
        templateId,
        JSON.stringify(params.validationReport),
        now,
        now
      );
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    return {
      generation: this.requireGeneration(params.generationId),
      template: this.requireTemplate(templateId)
    };
  }

  getGeneration(id: string): GenerationRecord | null {
    const row = this.db.prepare("SELECT * FROM template_generations WHERE id = ?").get(id) as Row | undefined;
    return row ? mapGeneration(row) : null;
  }

  requireGeneration(id: string): GenerationRecord {
    const record = this.getGeneration(id);
    if (!record) throw new Error(`Generation not found: ${id}`);
    return record;
  }

  getTemplate(id: string): TemplateRecord | null {
    const row = this.db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as Row | undefined;
    return row ? mapTemplate(row) : null;
  }

  listRuleTemplates(): TemplateRecord[] {
    return (this.db.prepare("SELECT * FROM templates ORDER BY updated_at DESC, rowid DESC").all() as Row[]).map(mapTemplate);
  }

  importPortableBackup(hash: string, templates: EvaluationTemplate[], reports: JsonObject[]): boolean {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      if (this.db.prepare("SELECT id FROM portable_backup_imports WHERE id = ?").get(hash)) {
        this.db.exec("COMMIT;"); return false;
      }
      const now = new Date().toISOString();
      for (const template of templates) {
        this.db.prepare(`INSERT INTO templates (id, template_key, status, content_json, created_at, updated_at, last_edited_by, last_edit_reason)
          VALUES (?, ?, 'draft', ?, ?, ?, '备份恢复', '从备份恢复为待检查草案，不自动发布')`)
          .run(randomUUID(), template.template_id, JSON.stringify(template), now, now);
      }
      for (const report of reports) {
        this.db.prepare("INSERT INTO report_archives (id, backup_id, content_json, created_at) VALUES (?, ?, ?, ?)")
          .run(randomUUID(), hash, JSON.stringify(report), now);
      }
      this.db.prepare("INSERT INTO portable_backup_imports (id, created_at) VALUES (?, ?)").run(hash, now);
      this.db.exec("COMMIT;"); return true;
    } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
  }

  listReportArchives(): JsonObject[] {
    return (this.db.prepare("SELECT id, created_at FROM report_archives ORDER BY created_at DESC").all() as Row[]) as JsonObject[];
  }

  getReportArchive(id: string): JsonObject | null {
    const row = this.db.prepare("SELECT content_json FROM report_archives WHERE id = ?").get(id) as Row | undefined;
    return row ? JSON.parse(String(row.content_json)) as JsonObject : null;
  }

  exportReportArchives(): JsonObject[] {
    return (this.db.prepare("SELECT content_json FROM report_archives ORDER BY created_at, id").all() as Row[]).map(row => JSON.parse(String(row.content_json)) as JsonObject);
  }

  requireTemplate(id: string): TemplateRecord {
    const record = this.getTemplate(id);
    if (!record) throw new Error(`Template not found: ${id}`);
    return record;
  }

  updateTemplate(params: {
    id: string;
    content: EvaluationTemplate;
    status: string;
    editedBy: string;
    editReason: string;
  }): TemplateRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE templates
      SET status = ?, content_json = ?, updated_at = ?, last_edited_by = ?, last_edit_reason = ?
      WHERE id = ?
    `).run(
      params.status,
      JSON.stringify(params.content),
      now,
      params.editedBy,
      params.editReason,
      params.id
    );
    return this.requireTemplate(params.id);
  }

  updateGenerationValidationByTemplate(templateId: string, report: ValidationReport): void {
    const now = new Date().toISOString();
    const status = report.valid ? "completed" : "validation_failed";
    this.db.prepare(`
      UPDATE template_generations
      SET status = ?, validation_report_json = ?, updated_at = ?
      WHERE draft_template_id = ?
    `).run(status, JSON.stringify(report), now, templateId);
  }

  publishTemplate(params: {
    templateId: string;
    content: EvaluationTemplate;
    version: string;
    approvedBy: string;
    approvalNote: string;
  }): { template: TemplateRecord; version: TemplateVersionRecord } {
    const now = new Date().toISOString();
    const versionId = randomUUID();

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        INSERT INTO template_versions (
          id, template_id, version, content_json, approved_by, approval_note, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        params.templateId,
        params.version,
        JSON.stringify(params.content),
        params.approvedBy,
        params.approvalNote,
        now
      );

      this.db.prepare(`
        UPDATE templates
        SET status = 'published', content_json = ?, updated_at = ?,
            last_edited_by = ?, last_edit_reason = ?
        WHERE id = ?
      `).run(
        JSON.stringify(params.content),
        now,
        params.approvedBy,
        `发布${params.version}: ${params.approvalNote}`,
        params.templateId
      );
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }

    return {
      template: this.requireTemplate(params.templateId),
      version: this.requireVersion(versionId)
    };
  }

  listVersions(templateId: string): TemplateVersionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM template_versions
      WHERE template_id = ?
      ORDER BY published_at DESC, version DESC
    `).all(templateId) as Row[];
    return rows.map(mapVersion);
  }

  listVersionsByTemplateKey(templateKey: string): TemplateVersionRecord[] {
    const rows = this.db.prepare(`
      SELECT tv.*
      FROM template_versions tv
      JOIN templates t ON t.id = tv.template_id
      WHERE t.template_key = ?
      ORDER BY tv.published_at DESC, tv.version DESC
    `).all(templateKey) as Row[];
    return rows.map(mapVersion);
  }

  requireVersion(id: string): TemplateVersionRecord {
    const version = this.getVersion(id);
    if (!version) throw new Error(`Template version not found: ${id}`);
    return version;
  }

  getVersion(id: string): TemplateVersionRecord | null {
    const row = this.db.prepare("SELECT * FROM template_versions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapVersion(row) : null;
  }

  listPublishedVersions(): TemplateVersionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM template_versions
      ORDER BY published_at DESC, version DESC
    `).all() as Row[];
    return rows.map(mapVersion);
  }

  createEvaluationTask(params: {
    templateVersion: TemplateVersionRecord;
    candidateName: string;
    candidateReference: string | null;
    candidateSnapshot: JsonObject;
    createdBy: string;
    assignedTo: string;
    gates: Array<{ id: string; name: string; order: number; critical: boolean }>;
    dimensions: Array<{ id: string; name: string; order: number; weight: number }>;
  }): EvaluationTaskRecord {
    const now = new Date().toISOString();
    const taskId = randomUUID();

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        INSERT INTO evaluation_tasks (
          id, template_version_id, template_id, template_key, template_version,
          status, candidate_name, candidate_reference, candidate_snapshot_json,
          created_by, assigned_to, overall_score, final_conclusion,
          final_decided_by, final_decision_reason, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, 'gate_review', ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)
      `).run(
        taskId,
        params.templateVersion.id,
        params.templateVersion.template_id,
        params.templateVersion.content.template_id,
        params.templateVersion.version,
        params.candidateName,
        params.candidateReference,
        JSON.stringify(params.candidateSnapshot),
        params.createdBy,
        params.assignedTo,
        now,
        now
      );

      const gateStatement = this.db.prepare(`
        INSERT INTO evaluation_gate_results (
          id, task_id, gate_id, gate_name, gate_order, critical, status,
          veto_triggered, evidence_json, note, assessed_by, assessed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, '[]', NULL, NULL, NULL, ?, ?)
      `);
      for (const gate of params.gates) {
        gateStatement.run(randomUUID(), taskId, gate.id, gate.name, gate.order, gate.critical ? 1 : 0, now, now);
      }

      const dimensionStatement = this.db.prepare(`
        INSERT INTO evaluation_dimension_scores (
          id, task_id, dimension_id, dimension_name, dimension_order, weight,
          score, weighted_score, information_status, confidence, evidence_json,
          note, scored_by, scored_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, '[]', NULL, NULL, NULL, ?, ?)
      `);
      for (const dimension of params.dimensions) {
        dimensionStatement.run(
          randomUUID(),
          taskId,
          dimension.id,
          dimension.name,
          dimension.order,
          dimension.weight,
          now,
          now
        );
      }

      this.insertAudit({
        taskId,
        eventType: "task_created",
        actor: params.createdBy,
        reason: "基于已发布模板版本创建评估任务",
        beforeSnapshot: null,
        afterSnapshot: {
          template_version_id: params.templateVersion.id,
          template_key: params.templateVersion.content.template_id,
          template_version: params.templateVersion.version,
          candidate_name: params.candidateName,
          assigned_to: params.assignedTo
        },
        createdAt: now
      });
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return this.requireEvaluationTask(taskId);
  }

  getEvaluationTask(id: string): EvaluationTaskRecord | null {
    const row = this.db.prepare("SELECT * FROM evaluation_tasks WHERE id = ?").get(id) as Row | undefined;
    return row ? mapEvaluationTask(row) : null;
  }

  requireEvaluationTask(id: string): EvaluationTaskRecord {
    const task = this.getEvaluationTask(id);
    if (!task) throw new Error(`Evaluation task not found: ${id}`);
    return task;
  }

  listEvaluationTasks(): EvaluationTaskRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM evaluation_tasks ORDER BY created_at DESC
    `).all() as Row[];
    return rows.map(mapEvaluationTask);
  }

  listGateResults(taskId: string): EvaluationGateResultRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM evaluation_gate_results
      WHERE task_id = ? ORDER BY gate_order ASC
    `).all(taskId) as Row[];
    return rows.map(mapGateResult);
  }

  getGateResult(taskId: string, gateId: string): EvaluationGateResultRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM evaluation_gate_results WHERE task_id = ? AND gate_id = ?
    `).get(taskId, gateId) as Row | undefined;
    return row ? mapGateResult(row) : null;
  }

  recordGateAssessment(params: {
    taskId: string;
    gateId: string;
    status: "pass" | "fail" | "unconfirmed";
    vetoTriggered: boolean;
    evidence: JsonValue[];
    note: string | null;
    assessedBy: string;
    modificationReason: string | null;
    taskStatus: EvaluationTaskStatus;
    supplement: null | {
      material: string;
      owner: string;
      dueDate: string;
      verificationMethod: string;
      status: string;
      note: string | null;
    };
  }): EvaluationGateResultRecord {
    const before = this.getGateResult(params.taskId, params.gateId);
    if (!before) throw new Error(`Gate result not found: ${params.gateId}`);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        UPDATE evaluation_gate_results
        SET status = ?, veto_triggered = ?, evidence_json = ?, note = ?,
            assessed_by = ?, assessed_at = ?, updated_at = ?
        WHERE task_id = ? AND gate_id = ?
      `).run(
        params.status,
        params.vetoTriggered ? 1 : 0,
        JSON.stringify(params.evidence),
        params.note,
        params.assessedBy,
        now,
        now,
        params.taskId,
        params.gateId
      );

      if (params.supplement) {
        const existing = this.db.prepare(`
          SELECT id FROM evaluation_supplement_requests WHERE task_id = ? AND gate_id = ?
        `).get(params.taskId, params.gateId) as Row | undefined;
        if (existing) {
          this.db.prepare(`
            UPDATE evaluation_supplement_requests
            SET material = ?, owner = ?, due_date = ?, verification_method = ?,
                status = ?, note = ?, updated_at = ?
            WHERE id = ?
          `).run(
            params.supplement.material,
            params.supplement.owner,
            params.supplement.dueDate,
            params.supplement.verificationMethod,
            params.supplement.status,
            params.supplement.note,
            now,
            String(existing.id)
          );
        } else {
          this.db.prepare(`
            INSERT INTO evaluation_supplement_requests (
              id, task_id, gate_id, material, owner, due_date,
              verification_method, status, note, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            randomUUID(),
            params.taskId,
            params.gateId,
            params.supplement.material,
            params.supplement.owner,
            params.supplement.dueDate,
            params.supplement.verificationMethod,
            params.supplement.status,
            params.supplement.note,
            now,
            now
          );
        }
      } else if (params.status !== "unconfirmed") {
        this.db.prepare(`
          UPDATE evaluation_supplement_requests
          SET status = 'cancelled', updated_at = ?
          WHERE task_id = ? AND gate_id = ? AND status IN ('open', 'submitted')
        `).run(now, params.taskId, params.gateId);
      }

      this.db.prepare(`
        UPDATE evaluation_tasks SET status = ?, updated_at = ? WHERE id = ?
      `).run(params.taskStatus, now, params.taskId);

      const after = {
        ...before,
        status: params.status,
        veto_triggered: params.vetoTriggered,
        evidence: params.evidence,
        note: params.note,
        assessed_by: params.assessedBy,
        assessed_at: now,
        updated_at: now
      };
      this.insertAudit({
        taskId: params.taskId,
        eventType: before.status === "pending" ? "gate_assessed" : "gate_reassessed",
        actor: params.assessedBy,
        reason: params.modificationReason,
        beforeSnapshot: before,
        afterSnapshot: after,
        createdAt: now
      });
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return this.getGateResult(params.taskId, params.gateId)!;
  }

  listDimensionScores(taskId: string): EvaluationDimensionScoreRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM evaluation_dimension_scores
      WHERE task_id = ? ORDER BY dimension_order ASC
    `).all(taskId) as Row[];
    return rows.map(mapDimensionScore);
  }

  getDimensionScore(taskId: string, dimensionId: string): EvaluationDimensionScoreRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM evaluation_dimension_scores WHERE task_id = ? AND dimension_id = ?
    `).get(taskId, dimensionId) as Row | undefined;
    return row ? mapDimensionScore(row) : null;
  }

  recordDimensionScore(params: {
    taskId: string;
    dimensionId: string;
    score: number;
    weightedScore: number;
    informationStatus: string;
    confidence: string;
    evidence: JsonValue[];
    note: string | null;
    scoredBy: string;
    modificationReason: string | null;
    taskStatus: EvaluationTaskStatus;
    overallScore: number | null;
  }): EvaluationDimensionScoreRecord {
    const before = this.getDimensionScore(params.taskId, params.dimensionId);
    if (!before) throw new Error(`Dimension score not found: ${params.dimensionId}`);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        UPDATE evaluation_dimension_scores
        SET score = ?, weighted_score = ?, information_status = ?, confidence = ?,
            evidence_json = ?, note = ?, scored_by = ?, scored_at = ?, updated_at = ?
        WHERE task_id = ? AND dimension_id = ?
      `).run(
        params.score,
        params.weightedScore,
        params.informationStatus,
        params.confidence,
        JSON.stringify(params.evidence),
        params.note,
        params.scoredBy,
        now,
        now,
        params.taskId,
        params.dimensionId
      );
      this.db.prepare(`
        UPDATE evaluation_tasks
        SET status = ?, overall_score = ?, updated_at = ? WHERE id = ?
      `).run(params.taskStatus, params.overallScore, now, params.taskId);
      const after = {
        ...before,
        score: params.score,
        weighted_score: params.weightedScore,
        information_status: params.informationStatus,
        confidence: params.confidence,
        evidence: params.evidence,
        note: params.note,
        scored_by: params.scoredBy,
        scored_at: now,
        updated_at: now
      };
      this.insertAudit({
        taskId: params.taskId,
        eventType: before.score === null ? "dimension_scored" : "dimension_rescored",
        actor: params.scoredBy,
        reason: params.modificationReason,
        beforeSnapshot: before,
        afterSnapshot: after,
        createdAt: now
      });
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return this.getDimensionScore(params.taskId, params.dimensionId)!;
  }

  listSupplementRequests(taskId: string): SupplementRequestRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM evaluation_supplement_requests
      WHERE task_id = ? ORDER BY created_at ASC
    `).all(taskId) as Row[];
    return rows.map(mapSupplementRequest);
  }

  getSupplementRequest(taskId: string, id: string): SupplementRequestRecord | null {
    const row = this.db.prepare(`
      SELECT * FROM evaluation_supplement_requests WHERE task_id = ? AND id = ?
    `).get(taskId, id) as Row | undefined;
    return row ? mapSupplementRequest(row) : null;
  }

  updateSupplementRequest(params: {
    taskId: string;
    id: string;
    status: string;
    note: string | null;
    updatedBy: string;
    reason: string;
  }): SupplementRequestRecord {
    const before = this.getSupplementRequest(params.taskId, params.id);
    if (!before) throw new Error(`Supplement request not found: ${params.id}`);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        UPDATE evaluation_supplement_requests SET status = ?, note = ?, updated_at = ?
        WHERE task_id = ? AND id = ?
      `).run(params.status, params.note, now, params.taskId, params.id);
      this.insertAudit({
        taskId: params.taskId,
        eventType: "supplement_updated",
        actor: params.updatedBy,
        reason: params.reason,
        beforeSnapshot: before,
        afterSnapshot: { ...before, status: params.status, note: params.note, updated_at: now },
        createdAt: now
      });
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return this.getSupplementRequest(params.taskId, params.id)!;
  }

  recordHumanDecision(params: {
    taskId: string;
    conclusion: string;
    reason: string;
    decidedBy: string;
    constraintsSnapshot: JsonObject;
  }): EvaluationDecisionRecord {
    const before = this.requireEvaluationTask(params.taskId);
    const now = new Date().toISOString();
    const decisionId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        INSERT INTO evaluation_decisions (
          id, task_id, conclusion, reason, decided_by, constraints_snapshot_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        decisionId,
        params.taskId,
        params.conclusion,
        params.reason,
        params.decidedBy,
        JSON.stringify(params.constraintsSnapshot),
        now
      );
      this.db.prepare(`
        UPDATE evaluation_tasks
        SET status = 'completed', final_conclusion = ?, final_decided_by = ?,
            final_decision_reason = ?, updated_at = ?, completed_at = ?
        WHERE id = ?
      `).run(params.conclusion, params.decidedBy, params.reason, now, now, params.taskId);
      this.insertAudit({
        taskId: params.taskId,
        eventType: "human_decision_recorded",
        actor: params.decidedBy,
        reason: params.reason,
        beforeSnapshot: before,
        afterSnapshot: {
          status: "completed",
          final_conclusion: params.conclusion,
          final_decided_by: params.decidedBy
        },
        createdAt: now
      });
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return this.requireDecision(decisionId);
  }

  listDecisions(taskId: string): EvaluationDecisionRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM evaluation_decisions WHERE task_id = ? ORDER BY created_at ASC
    `).all(taskId) as Row[];
    return rows.map(mapDecision);
  }

  requireDecision(id: string): EvaluationDecisionRecord {
    const row = this.db.prepare("SELECT * FROM evaluation_decisions WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Decision not found: ${id}`);
    return mapDecision(row);
  }

  listAuditEvents(taskId: string): EvaluationAuditRecord[] {
    const rows = this.db.prepare(`
      SELECT * FROM evaluation_audit_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(taskId) as Row[];
    return rows.map(mapAuditEvent);
  }

  createDataImport(params: {
    taskId: string;
    sourceType: "local_file" | "official_public";
    sourceName: string;
    fileName: string | null;
    mediaType: string | null;
    sourceUrl: string | null;
    officialSourceCode: string | null;
    metadata: JsonObject;
    sha256: string | null;
    importedBy: string;
    evidence: Array<{
      evidenceKey: string;
      label: string;
      value: JsonValue;
      normalizedText: string;
      sourceLocator: string | null;
      observedAt: string | null;
      qualityScore: number;
    }>;
  }): EvaluationDataImportRecord {
    const now = new Date().toISOString();
    const importId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        INSERT INTO evaluation_data_imports (
          id, task_id, source_type, source_name, file_name, media_type, source_url,
          official_source_code, status, record_count, metadata_json, sha256,
          imported_by, imported_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)
      `).run(
        importId,
        params.taskId,
        params.sourceType,
        params.sourceName,
        params.fileName,
        params.mediaType,
        params.sourceUrl,
        params.officialSourceCode,
        params.evidence.length,
        JSON.stringify(params.metadata),
        params.sha256,
        params.importedBy,
        now
      );
      const insertEvidence = this.db.prepare(`
        INSERT INTO evaluation_evidence_items (
          id, task_id, import_id, evidence_key, label, value_json, normalized_text,
          source_locator, observed_at, quality_score, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of params.evidence) {
        insertEvidence.run(
          randomUUID(), params.taskId, importId, item.evidenceKey, item.label,
          JSON.stringify(item.value), item.normalizedText, item.sourceLocator,
          item.observedAt, item.qualityScore, now
        );
      }
      this.insertAudit({
        taskId: params.taskId,
        eventType: "evaluation_data_imported",
        actor: params.importedBy,
        reason: `导入${params.sourceName}`,
        beforeSnapshot: null,
        afterSnapshot: {
          import_id: importId,
          source_type: params.sourceType,
          source_name: params.sourceName,
          record_count: params.evidence.length,
          sha256: params.sha256
        },
        createdAt: now
      });
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return this.requireDataImport(importId);
  }

  requireDataImport(id: string): EvaluationDataImportRecord {
    const row = this.db.prepare("SELECT * FROM evaluation_data_imports WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Data import not found: ${id}`);
    return mapDataImport(row);
  }

  listDataImports(taskId: string): EvaluationDataImportRecord[] {
    return (this.db.prepare(`
      SELECT * FROM evaluation_data_imports WHERE task_id = ? ORDER BY imported_at DESC
    `).all(taskId) as Row[]).map(mapDataImport);
  }

  listEvidenceItems(taskId: string): EvaluationEvidenceItemRecord[] {
    return (this.db.prepare(`
      SELECT * FROM evaluation_evidence_items WHERE task_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(taskId) as Row[]).map(mapEvidenceItem);
  }

  createPreassessmentRun(params: {
    taskId: string;
    engineVersion: string;
    result: JsonObject;
    createdBy: string;
  }): EvaluationPreassessmentRunRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare(`
        INSERT INTO evaluation_preassessment_runs (
          id, task_id, status, engine_version, result_json, created_by, created_at
        ) VALUES (?, ?, 'completed', ?, ?, ?, ?)
      `).run(id, params.taskId, params.engineVersion, JSON.stringify(params.result), params.createdBy, now);
      this.insertAudit({
        taskId: params.taskId,
        eventType: "preassessment_generated",
        actor: params.createdBy,
        reason: "基于已导入证据生成自动预评估建议",
        beforeSnapshot: null,
        afterSnapshot: { run_id: id, engine_version: params.engineVersion },
        createdAt: now
      });
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return this.requirePreassessmentRun(id);
  }

  requirePreassessmentRun(id: string): EvaluationPreassessmentRunRecord {
    const row = this.db.prepare("SELECT * FROM evaluation_preassessment_runs WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Preassessment run not found: ${id}`);
    return mapPreassessmentRun(row);
  }

  listPreassessmentRuns(taskId: string): EvaluationPreassessmentRunRecord[] {
    return (this.db.prepare(`
      SELECT * FROM evaluation_preassessment_runs WHERE task_id = ? ORDER BY created_at DESC
    `).all(taskId) as Row[]).map(mapPreassessmentRun);
  }

  createTrackOnboardingDraft(params: {
    contextKey: string;
    industry: JsonObject;
    track: JsonObject;
    status: TrackOnboardingDraftStatus;
    draft: JsonObject;
  }): TrackOnboardingDraftRecord {
    const existing = this.getTrackOnboardingDraftByKey(params.contextKey);
    if (existing) return existing;
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO track_onboarding_drafts (
        id, context_key, industry_json, track_json, status, draft_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.contextKey,
      JSON.stringify(params.industry),
      JSON.stringify(params.track),
      params.status,
      JSON.stringify(params.draft),
      now,
      now
    );
    return this.requireTrackOnboardingDraft(id);
  }

  getTrackOnboardingDraft(id: string): TrackOnboardingDraftRecord | null {
    const row = this.db.prepare("SELECT * FROM track_onboarding_drafts WHERE id = ?").get(id) as Row | undefined;
    return row ? mapTrackOnboardingDraft(row) : null;
  }

  getTrackOnboardingDraftByKey(contextKey: string): TrackOnboardingDraftRecord | null {
    const row = this.db.prepare("SELECT * FROM track_onboarding_drafts WHERE context_key = ?").get(contextKey) as Row | undefined;
    return row ? mapTrackOnboardingDraft(row) : null;
  }

  requireTrackOnboardingDraft(id: string): TrackOnboardingDraftRecord {
    const record = this.getTrackOnboardingDraft(id);
    if (!record) throw new Error(`Track onboarding draft not found: ${id}`);
    return record;
  }

  updateTrackOnboardingDraft(params: {
    id: string;
    status: TrackOnboardingDraftStatus;
    draft: JsonObject;
  }): TrackOnboardingDraftRecord {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE track_onboarding_drafts
      SET status = ?, draft_json = ?, updated_at = ?
      WHERE id = ?
    `).run(params.status, JSON.stringify(params.draft), now, params.id);
    if (Number(result.changes) === 0) throw new Error(`Track onboarding draft not found: ${params.id}`);
    return this.requireTrackOnboardingDraft(params.id);
  }

  createBenchmarkCollectionJob(params: {
    trackCode: string;
    sourceCode: string;
    targetName: string;
    organizationName: string | null;
    targetUrl: string;
    sampleId: string | null;
    requestedBy: string;
  }): BenchmarkCollectionJobRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO benchmark_collection_jobs (
        id, track_code, source_code, target_name, organization_name, target_url,
        sample_id, status, attempt_count, http_status, content_type, error_message,
        raw_document_id, requested_by, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL, ?, ?, ?, NULL)
    `).run(
      id, params.trackCode, params.sourceCode, params.targetName, params.organizationName,
      params.targetUrl, params.sampleId, params.requestedBy, now, now
    );
    return this.requireBenchmarkCollectionJob(id);
  }

  requireBenchmarkCollectionJob(id: string): BenchmarkCollectionJobRecord {
    const row = this.db.prepare("SELECT * FROM benchmark_collection_jobs WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Benchmark collection job not found: ${id}`);
    return mapBenchmarkCollectionJob(row);
  }

  listBenchmarkCollectionJobs(trackCode?: string): BenchmarkCollectionJobRecord[] {
    const rows = trackCode
      ? this.db.prepare("SELECT * FROM benchmark_collection_jobs WHERE track_code = ? ORDER BY created_at DESC").all(trackCode)
      : this.db.prepare("SELECT * FROM benchmark_collection_jobs ORDER BY created_at DESC").all();
    return (rows as Row[]).map(mapBenchmarkCollectionJob);
  }

  updateBenchmarkCollectionJob(params: {
    id: string;
    status: BenchmarkCollectionJobRecord["status"];
    attemptCount: number;
    httpStatus: number | null;
    contentType: string | null;
    errorMessage: string | null;
    rawDocumentId: string | null;
    completedAt: string | null;
  }): BenchmarkCollectionJobRecord {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE benchmark_collection_jobs
      SET status = ?, attempt_count = ?, http_status = ?, content_type = ?, error_message = ?,
          raw_document_id = ?, updated_at = ?, completed_at = ?
      WHERE id = ?
    `).run(
      params.status, params.attemptCount, params.httpStatus, params.contentType, params.errorMessage,
      params.rawDocumentId, now, params.completedAt, params.id
    );
    return this.requireBenchmarkCollectionJob(params.id);
  }

  bindBenchmarkCollectionJobSample(id: string, sampleId: string): BenchmarkCollectionJobRecord {
    this.requireBenchmarkSample(sampleId);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE benchmark_collection_jobs
      SET sample_id = ?, updated_at = ?
      WHERE id = ?
    `).run(sampleId, now, id);
    return this.requireBenchmarkCollectionJob(id);
  }

  createBenchmarkRawDocument(params: {
    jobId: string;
    trackCode: string;
    sourceCode: string;
    title: string;
    sourceUrl: string;
    mediaType: string;
    byteCount: number;
    sha256: string;
    storagePath: string;
    textExcerpt: string | null;
  }): BenchmarkRawDocumentRecord {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO benchmark_raw_documents (
        id, job_id, track_code, source_code, title, source_url, media_type,
        byte_count, sha256, storage_path, text_excerpt, fetched_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.jobId, params.trackCode, params.sourceCode, params.title, params.sourceUrl,
      params.mediaType, params.byteCount, params.sha256, params.storagePath, params.textExcerpt, now, now
    );
    return this.requireBenchmarkRawDocument(id);
  }

  requireBenchmarkRawDocument(id: string): BenchmarkRawDocumentRecord {
    const row = this.db.prepare("SELECT * FROM benchmark_raw_documents WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Benchmark raw document not found: ${id}`);
    return mapBenchmarkRawDocument(row);
  }

  getBenchmarkRawDocument(id: string): BenchmarkRawDocumentRecord | null {
    const row = this.db.prepare("SELECT * FROM benchmark_raw_documents WHERE id = ?").get(id) as Row | undefined;
    return row ? mapBenchmarkRawDocument(row) : null;
  }

  createBenchmarkSample(params: {
    sampleKey: string;
    sampleType: BenchmarkSampleRecord["sample_type"];
    personName: string;
    personRole: string;
    organizationName: string;
    industryCode: string;
    trackCode: string;
    jurisdiction: string;
    organizationStage: string;
    observationDate: string;
    status: BenchmarkSampleRecord["status"];
    summary: string | null;
    metadata: JsonObject;
  }): BenchmarkSampleRecord {
    const existing = this.getBenchmarkSampleByKey(params.sampleKey);
    if (existing) return existing;
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO benchmark_samples (
        id, sample_key, sample_type, person_name, person_role, organization_name,
        industry_code, track_code, jurisdiction, organization_stage,
        observation_date, status, summary, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.sampleKey, params.sampleType, params.personName, params.personRole,
      params.organizationName, params.industryCode, params.trackCode, params.jurisdiction,
      params.organizationStage, params.observationDate, params.status, params.summary,
      JSON.stringify(params.metadata), now, now
    );
    return this.requireBenchmarkSample(id);
  }

  getBenchmarkSample(id: string): BenchmarkSampleRecord | null {
    const row = this.db.prepare("SELECT * FROM benchmark_samples WHERE id = ?").get(id) as Row | undefined;
    return row ? mapBenchmarkSample(row) : null;
  }

  getBenchmarkSampleByKey(sampleKey: string): BenchmarkSampleRecord | null {
    const row = this.db.prepare("SELECT * FROM benchmark_samples WHERE sample_key = ?").get(sampleKey) as Row | undefined;
    return row ? mapBenchmarkSample(row) : null;
  }

  requireBenchmarkSample(id: string): BenchmarkSampleRecord {
    const sample = this.getBenchmarkSample(id);
    if (!sample) throw new Error(`Benchmark sample not found: ${id}`);
    return sample;
  }

  listBenchmarkSamples(filters: { trackCode?: string; sampleType?: string } = {}): BenchmarkSampleRecord[] {
    if (filters.trackCode && filters.sampleType) {
      return (this.db.prepare(`
        SELECT * FROM benchmark_samples WHERE track_code = ? AND sample_type = ?
        ORDER BY observation_date DESC, organization_name ASC
      `).all(filters.trackCode, filters.sampleType) as Row[]).map(mapBenchmarkSample);
    }
    if (filters.trackCode) {
      return (this.db.prepare(`
        SELECT * FROM benchmark_samples WHERE track_code = ?
        ORDER BY observation_date DESC, organization_name ASC
      `).all(filters.trackCode) as Row[]).map(mapBenchmarkSample);
    }
    return (this.db.prepare(`
      SELECT * FROM benchmark_samples ORDER BY observation_date DESC, organization_name ASC
    `).all() as Row[]).map(mapBenchmarkSample);
  }

  createBenchmarkEvidence(params: {
    sampleId: string;
    fieldKey: string;
    title: string;
    value: JsonValue;
    sourceCode: string;
    sourceName: string;
    sourceUrl: string;
    sourceLocator: string | null;
    publisherType: string;
    publicationDate: string | null;
    observedAt: string;
    collectionMethod: string;
    accessBasis: string;
    qualityScore: number;
    confidence: BenchmarkEvidenceRecord["confidence"];
    reviewStatus: BenchmarkEvidenceRecord["review_status"];
    collectedBy: string;
  }): BenchmarkEvidenceRecord {
    this.requireBenchmarkSample(params.sampleId);
    const existing = this.db.prepare(`
      SELECT * FROM benchmark_evidence
      WHERE sample_id = ? AND field_key = ? AND source_url = ?
        AND COALESCE(source_locator, '') = COALESCE(?, '')
    `).get(params.sampleId, params.fieldKey, params.sourceUrl, params.sourceLocator) as Row | undefined;
    if (existing) return mapBenchmarkEvidence(existing);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO benchmark_evidence (
        id, sample_id, field_key, title, value_json, source_code, source_name,
        source_url, source_locator, publisher_type, publication_date, observed_at,
        collection_method, access_basis, quality_score, confidence, review_status,
        collected_by, collected_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, params.sampleId, params.fieldKey, params.title, JSON.stringify(params.value),
      params.sourceCode, params.sourceName, params.sourceUrl, params.sourceLocator,
      params.publisherType, params.publicationDate, params.observedAt,
      params.collectionMethod, params.accessBasis, params.qualityScore, params.confidence,
      params.reviewStatus, params.collectedBy, now
    );
    return this.requireBenchmarkEvidence(id);
  }

  requireBenchmarkEvidence(id: string): BenchmarkEvidenceRecord {
    const row = this.db.prepare("SELECT * FROM benchmark_evidence WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Benchmark evidence not found: ${id}`);
    return mapBenchmarkEvidence(row);
  }

  listBenchmarkEvidence(sampleId: string): BenchmarkEvidenceRecord[] {
    return (this.db.prepare(`
      SELECT * FROM benchmark_evidence WHERE sample_id = ?
      ORDER BY observed_at DESC, collected_at DESC
    `).all(sampleId) as Row[]).map(mapBenchmarkEvidence);
  }

  reviewBenchmarkEvidence(params: {
    sampleId: string;
    evidenceId: string;
    decision: BenchmarkEvidenceReviewRecord["decision"];
    reviewer: string;
    reason: string;
  }): { evidence: BenchmarkEvidenceRecord; review: BenchmarkEvidenceReviewRecord } {
    this.requireBenchmarkSample(params.sampleId);
    const before = this.requireBenchmarkEvidence(params.evidenceId);
    if (before.sample_id !== params.sampleId) throw new Error("Benchmark evidence does not belong to sample");
    const reviewId = randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      this.db.prepare("UPDATE benchmark_evidence SET review_status = ? WHERE id = ?")
        .run(params.decision, params.evidenceId);
      this.db.prepare(`
        INSERT INTO benchmark_evidence_reviews (
          id, evidence_id, sample_id, decision, reviewer, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        reviewId, params.evidenceId, params.sampleId, params.decision,
        params.reviewer, params.reason, now
      );
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return {
      evidence: this.requireBenchmarkEvidence(params.evidenceId),
      review: this.requireBenchmarkEvidenceReview(reviewId)
    };
  }

  reviewBenchmarkEvidenceBatch(params: {
    evidenceIds: string[];
    decision: BenchmarkEvidenceReviewRecord["decision"];
    reviewer: string;
    reason: string;
  }): { evidence: BenchmarkEvidenceRecord[]; reviews: BenchmarkEvidenceReviewRecord[] } {
    const evidenceIds = [...new Set(params.evidenceIds)];
    const before = evidenceIds.map((id) => this.requireBenchmarkEvidence(id));
    const reviewIds = evidenceIds.map(() => randomUUID());
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const update = this.db.prepare("UPDATE benchmark_evidence SET review_status = ? WHERE id = ?");
      const insert = this.db.prepare(`
        INSERT INTO benchmark_evidence_reviews (
          id, evidence_id, sample_id, decision, reviewer, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      before.forEach((item, index) => {
        const reviewId = reviewIds[index]!;
        update.run(params.decision, item.id);
        insert.run(reviewId, item.id, item.sample_id, params.decision, params.reviewer, params.reason, now);
      });
      this.db.exec("COMMIT;");
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
    return {
      evidence: evidenceIds.map((id) => this.requireBenchmarkEvidence(id)),
      reviews: reviewIds.map((id) => this.requireBenchmarkEvidenceReview(id))
    };
  }

  requireBenchmarkEvidenceReview(id: string): BenchmarkEvidenceReviewRecord {
    const row = this.db.prepare("SELECT * FROM benchmark_evidence_reviews WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Benchmark evidence review not found: ${id}`);
    return mapBenchmarkEvidenceReview(row);
  }

  listBenchmarkEvidenceReviews(sampleId: string): BenchmarkEvidenceReviewRecord[] {
    return (this.db.prepare(`
      SELECT * FROM benchmark_evidence_reviews WHERE sample_id = ?
      ORDER BY created_at DESC, rowid DESC
    `).all(sampleId) as Row[]).map(mapBenchmarkEvidenceReview);
  }

  createBenchmarkTrait(params: {
    sampleId: string;
    traitKey: string;
    traitName: string;
    hypothesis: string;
    direction: BenchmarkTraitRecord["direction"];
    confidence: BenchmarkTraitRecord["confidence"];
    evidenceIds: JsonValue[];
  }): BenchmarkTraitRecord {
    this.requireBenchmarkSample(params.sampleId);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO benchmark_traits (
        id, sample_id, trait_key, trait_name, hypothesis, direction, confidence,
        evidence_ids_json, review_status, reviewed_by, review_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, NULL, ?, ?)
    `).run(
      id, params.sampleId, params.traitKey, params.traitName, params.hypothesis,
      params.direction, params.confidence, JSON.stringify(params.evidenceIds), now, now
    );
    return this.requireBenchmarkTrait(id);
  }

  requireBenchmarkTrait(id: string): BenchmarkTraitRecord {
    const row = this.db.prepare("SELECT * FROM benchmark_traits WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new Error(`Benchmark trait not found: ${id}`);
    return mapBenchmarkTrait(row);
  }

  listBenchmarkTraits(sampleId: string): BenchmarkTraitRecord[] {
    return (this.db.prepare(`
      SELECT * FROM benchmark_traits WHERE sample_id = ? ORDER BY created_at ASC
    `).all(sampleId) as Row[]).map(mapBenchmarkTrait);
  }

  private insertAudit(params: {
    taskId: string;
    eventType: string;
    actor: string;
    reason: string | null;
    beforeSnapshot: JsonValue | EvaluationTaskRecord | EvaluationGateResultRecord | EvaluationDimensionScoreRecord | SupplementRequestRecord;
    afterSnapshot: JsonValue | EvaluationTaskRecord | EvaluationGateResultRecord | EvaluationDimensionScoreRecord | SupplementRequestRecord;
    createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO evaluation_audit_events (
        id, task_id, event_type, actor, reason, before_snapshot_json, after_snapshot_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      params.taskId,
      params.eventType,
      params.actor,
      params.reason,
      JSON.stringify(params.beforeSnapshot),
      JSON.stringify(params.afterSnapshot),
      params.createdAt
    );
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS portable_backup_imports (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_archives (id TEXT PRIMARY KEY, backup_id TEXT NOT NULL, content_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        template_key TEXT NOT NULL,
        status TEXT NOT NULL,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_edited_by TEXT,
        last_edit_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS template_generations (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL,
        draft_template_id TEXT REFERENCES templates(id),
        validation_report_json TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS template_versions (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES templates(id),
        version TEXT NOT NULL,
        content_json TEXT NOT NULL,
        approved_by TEXT NOT NULL,
        approval_note TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE(template_id, version)
      );

      CREATE TABLE IF NOT EXISTS evaluation_tasks (
        id TEXT PRIMARY KEY,
        template_version_id TEXT NOT NULL REFERENCES template_versions(id),
        template_id TEXT NOT NULL REFERENCES templates(id),
        template_key TEXT NOT NULL,
        template_version TEXT NOT NULL,
        status TEXT NOT NULL,
        candidate_name TEXT NOT NULL,
        candidate_reference TEXT,
        candidate_snapshot_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        assigned_to TEXT NOT NULL,
        overall_score REAL,
        final_conclusion TEXT,
        final_decided_by TEXT,
        final_decision_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS evaluation_gate_results (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES evaluation_tasks(id) ON DELETE CASCADE,
        gate_id TEXT NOT NULL,
        gate_name TEXT NOT NULL,
        gate_order INTEGER NOT NULL,
        critical INTEGER NOT NULL,
        status TEXT NOT NULL,
        veto_triggered INTEGER NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL,
        note TEXT,
        assessed_by TEXT,
        assessed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, gate_id),
        UNIQUE(task_id, gate_order)
      );

      CREATE TABLE IF NOT EXISTS evaluation_dimension_scores (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES evaluation_tasks(id) ON DELETE CASCADE,
        dimension_id TEXT NOT NULL,
        dimension_name TEXT NOT NULL,
        dimension_order INTEGER NOT NULL,
        weight REAL NOT NULL,
        score REAL,
        weighted_score REAL,
        information_status TEXT,
        confidence TEXT,
        evidence_json TEXT NOT NULL,
        note TEXT,
        scored_by TEXT,
        scored_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, dimension_id),
        UNIQUE(task_id, dimension_order)
      );

      CREATE TABLE IF NOT EXISTS evaluation_supplement_requests (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES evaluation_tasks(id) ON DELETE CASCADE,
        gate_id TEXT NOT NULL,
        material TEXT NOT NULL,
        owner TEXT NOT NULL,
        due_date TEXT NOT NULL,
        verification_method TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(task_id, gate_id)
      );

      CREATE TABLE IF NOT EXISTS evaluation_decisions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES evaluation_tasks(id) ON DELETE CASCADE,
        conclusion TEXT NOT NULL,
        reason TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        constraints_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluation_audit_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES evaluation_tasks(id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT,
        before_snapshot_json TEXT NOT NULL,
        after_snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluation_data_imports (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES evaluation_tasks(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_name TEXT NOT NULL,
        file_name TEXT,
        media_type TEXT,
        source_url TEXT,
        official_source_code TEXT,
        status TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        sha256 TEXT,
        imported_by TEXT NOT NULL,
        imported_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluation_evidence_items (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES evaluation_tasks(id) ON DELETE CASCADE,
        import_id TEXT NOT NULL REFERENCES evaluation_data_imports(id) ON DELETE CASCADE,
        evidence_key TEXT NOT NULL,
        label TEXT NOT NULL,
        value_json TEXT NOT NULL,
        normalized_text TEXT NOT NULL,
        source_locator TEXT,
        observed_at TEXT,
        quality_score REAL NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evaluation_preassessment_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES evaluation_tasks(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        engine_version TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS benchmark_samples (
        id TEXT PRIMARY KEY,
        sample_key TEXT NOT NULL UNIQUE,
        sample_type TEXT NOT NULL,
        person_name TEXT NOT NULL,
        person_role TEXT NOT NULL,
        organization_name TEXT NOT NULL,
        industry_code TEXT NOT NULL,
        track_code TEXT NOT NULL,
        jurisdiction TEXT NOT NULL,
        organization_stage TEXT NOT NULL,
        observation_date TEXT NOT NULL,
        status TEXT NOT NULL,
        summary TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS benchmark_evidence (
        id TEXT PRIMARY KEY,
        sample_id TEXT NOT NULL REFERENCES benchmark_samples(id) ON DELETE CASCADE,
        field_key TEXT NOT NULL,
        title TEXT NOT NULL,
        value_json TEXT NOT NULL,
        source_code TEXT NOT NULL,
        source_name TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_locator TEXT,
        publisher_type TEXT NOT NULL,
        publication_date TEXT,
        observed_at TEXT NOT NULL,
        collection_method TEXT NOT NULL,
        access_basis TEXT NOT NULL,
        quality_score REAL NOT NULL,
        confidence TEXT NOT NULL,
        review_status TEXT NOT NULL,
        collected_by TEXT NOT NULL,
        collected_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS benchmark_traits (
        id TEXT PRIMARY KEY,
        sample_id TEXT NOT NULL REFERENCES benchmark_samples(id) ON DELETE CASCADE,
        trait_key TEXT NOT NULL,
        trait_name TEXT NOT NULL,
        hypothesis TEXT NOT NULL,
        direction TEXT NOT NULL,
        confidence TEXT NOT NULL,
        evidence_ids_json TEXT NOT NULL,
        review_status TEXT NOT NULL,
        reviewed_by TEXT,
        review_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS benchmark_evidence_reviews (
        id TEXT PRIMARY KEY,
        evidence_id TEXT NOT NULL REFERENCES benchmark_evidence(id) ON DELETE CASCADE,
        sample_id TEXT NOT NULL REFERENCES benchmark_samples(id) ON DELETE CASCADE,
        decision TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS benchmark_collection_jobs (
        id TEXT PRIMARY KEY,
        track_code TEXT NOT NULL,
        source_code TEXT NOT NULL,
        target_name TEXT NOT NULL,
        organization_name TEXT,
        target_url TEXT NOT NULL,
        sample_id TEXT REFERENCES benchmark_samples(id) ON DELETE SET NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        http_status INTEGER,
        content_type TEXT,
        error_message TEXT,
        raw_document_id TEXT,
        requested_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS benchmark_raw_documents (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL UNIQUE REFERENCES benchmark_collection_jobs(id) ON DELETE CASCADE,
        track_code TEXT NOT NULL,
        source_code TEXT NOT NULL,
        title TEXT NOT NULL,
        source_url TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_count INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        text_excerpt TEXT,
        fetched_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS track_onboarding_drafts (
        id TEXT PRIMARY KEY,
        context_key TEXT NOT NULL UNIQUE,
        industry_json TEXT NOT NULL,
        track_json TEXT NOT NULL,
        status TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_generation_template
        ON template_generations(draft_template_id);
      CREATE INDEX IF NOT EXISTS idx_version_template
        ON template_versions(template_id);
      CREATE INDEX IF NOT EXISTS idx_evaluation_task_status
        ON evaluation_tasks(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_evaluation_gate_task
        ON evaluation_gate_results(task_id, gate_order);
      CREATE INDEX IF NOT EXISTS idx_evaluation_dimension_task
        ON evaluation_dimension_scores(task_id, dimension_order);
      CREATE INDEX IF NOT EXISTS idx_evaluation_supplement_task
        ON evaluation_supplement_requests(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_evaluation_audit_task
        ON evaluation_audit_events(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_evaluation_import_task
        ON evaluation_data_imports(task_id, imported_at);
      CREATE INDEX IF NOT EXISTS idx_evaluation_evidence_task
        ON evaluation_evidence_items(task_id, evidence_key);
      CREATE INDEX IF NOT EXISTS idx_evaluation_preassessment_task
        ON evaluation_preassessment_runs(task_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_benchmark_sample_track
        ON benchmark_samples(track_code, sample_type, observation_date);
      CREATE INDEX IF NOT EXISTS idx_benchmark_evidence_sample
        ON benchmark_evidence(sample_id, field_key, observed_at);
      CREATE INDEX IF NOT EXISTS idx_benchmark_trait_sample
        ON benchmark_traits(sample_id, review_status);
      CREATE INDEX IF NOT EXISTS idx_benchmark_evidence_review_sample
        ON benchmark_evidence_reviews(sample_id, evidence_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_benchmark_collection_track
        ON benchmark_collection_jobs(track_code, created_at);
      CREATE INDEX IF NOT EXISTS idx_benchmark_collection_status
        ON benchmark_collection_jobs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_benchmark_raw_document_track
        ON benchmark_raw_documents(track_code, fetched_at);
      CREATE INDEX IF NOT EXISTS idx_track_onboarding_status
        ON track_onboarding_drafts(status, updated_at);
    `);
  }
}

function mapGeneration(row: Row): GenerationRecord {
  return {
    id: String(row.id),
    status: String(row.status),
    request: parseObject(row.request_json),
    draft_template_id: nullableString(row.draft_template_id),
    validation_report: row.validation_report_json
      ? JSON.parse(String(row.validation_report_json)) as ValidationReport
      : null,
    error_message: nullableString(row.error_message),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function mapTemplate(row: Row): TemplateRecord {
  return {
    id: String(row.id),
    template_key: String(row.template_key),
    status: String(row.status),
    content: JSON.parse(String(row.content_json)) as EvaluationTemplate,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    last_edited_by: nullableString(row.last_edited_by),
    last_edit_reason: nullableString(row.last_edit_reason)
  };
}

function mapVersion(row: Row): TemplateVersionRecord {
  return {
    id: String(row.id),
    template_id: String(row.template_id),
    version: String(row.version),
    content: JSON.parse(String(row.content_json)) as EvaluationTemplate,
    approved_by: String(row.approved_by),
    approval_note: String(row.approval_note),
    published_at: String(row.published_at)
  };
}

function mapEvaluationTask(row: Row): EvaluationTaskRecord {
  return {
    id: String(row.id),
    template_version_id: String(row.template_version_id),
    template_id: String(row.template_id),
    template_key: String(row.template_key),
    template_version: String(row.template_version),
    status: String(row.status) as EvaluationTaskStatus,
    candidate_name: String(row.candidate_name),
    candidate_reference: nullableString(row.candidate_reference),
    candidate_snapshot: parseObject(row.candidate_snapshot_json),
    created_by: String(row.created_by),
    assigned_to: String(row.assigned_to),
    overall_score: nullableNumber(row.overall_score),
    final_conclusion: nullableString(row.final_conclusion),
    final_decided_by: nullableString(row.final_decided_by),
    final_decision_reason: nullableString(row.final_decision_reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: nullableString(row.completed_at)
  };
}

function mapGateResult(row: Row): EvaluationGateResultRecord {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    gate_id: String(row.gate_id),
    gate_name: String(row.gate_name),
    gate_order: Number(row.gate_order),
    critical: Boolean(row.critical),
    status: String(row.status) as EvaluationGateResultRecord["status"],
    veto_triggered: Boolean(row.veto_triggered),
    evidence: parseArray(row.evidence_json),
    note: nullableString(row.note),
    assessed_by: nullableString(row.assessed_by),
    assessed_at: nullableString(row.assessed_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function mapDimensionScore(row: Row): EvaluationDimensionScoreRecord {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    dimension_id: String(row.dimension_id),
    dimension_name: String(row.dimension_name),
    dimension_order: Number(row.dimension_order),
    weight: Number(row.weight),
    score: nullableNumber(row.score),
    weighted_score: nullableNumber(row.weighted_score),
    information_status: nullableString(row.information_status),
    confidence: nullableString(row.confidence),
    evidence: parseArray(row.evidence_json),
    note: nullableString(row.note),
    scored_by: nullableString(row.scored_by),
    scored_at: nullableString(row.scored_at),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function mapSupplementRequest(row: Row): SupplementRequestRecord {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    gate_id: String(row.gate_id),
    material: String(row.material),
    owner: String(row.owner),
    due_date: String(row.due_date),
    verification_method: String(row.verification_method),
    status: String(row.status),
    note: nullableString(row.note),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function mapDecision(row: Row): EvaluationDecisionRecord {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    conclusion: String(row.conclusion),
    reason: String(row.reason),
    decided_by: String(row.decided_by),
    constraints_snapshot: parseObject(row.constraints_snapshot_json),
    created_at: String(row.created_at)
  };
}

function mapAuditEvent(row: Row): EvaluationAuditRecord {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    event_type: String(row.event_type),
    actor: String(row.actor),
    reason: nullableString(row.reason),
    before_snapshot: parseJsonValue(row.before_snapshot_json),
    after_snapshot: parseJsonValue(row.after_snapshot_json),
    created_at: String(row.created_at)
  };
}

function mapDataImport(row: Row): EvaluationDataImportRecord {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    source_type: String(row.source_type) as EvaluationDataImportRecord["source_type"],
    source_name: String(row.source_name),
    file_name: nullableString(row.file_name),
    media_type: nullableString(row.media_type),
    source_url: nullableString(row.source_url),
    official_source_code: nullableString(row.official_source_code),
    status: String(row.status) as EvaluationDataImportRecord["status"],
    record_count: Number(row.record_count),
    metadata: parseObject(row.metadata_json),
    sha256: nullableString(row.sha256),
    imported_by: String(row.imported_by),
    imported_at: String(row.imported_at)
  };
}

function mapEvidenceItem(row: Row): EvaluationEvidenceItemRecord {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    import_id: String(row.import_id),
    evidence_key: String(row.evidence_key),
    label: String(row.label),
    value: parseJsonValue(row.value_json),
    normalized_text: String(row.normalized_text),
    source_locator: nullableString(row.source_locator),
    observed_at: nullableString(row.observed_at),
    quality_score: Number(row.quality_score),
    created_at: String(row.created_at)
  };
}

function mapPreassessmentRun(row: Row): EvaluationPreassessmentRunRecord {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    status: String(row.status) as EvaluationPreassessmentRunRecord["status"],
    engine_version: String(row.engine_version),
    result: parseObject(row.result_json),
    created_by: String(row.created_by),
    created_at: String(row.created_at)
  };
}

function mapTrackOnboardingDraft(row: Row): TrackOnboardingDraftRecord {
  return {
    id: String(row.id),
    context_key: String(row.context_key),
    industry: parseObject(row.industry_json),
    track: parseObject(row.track_json),
    status: String(row.status) as TrackOnboardingDraftStatus,
    draft: parseObject(row.draft_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function mapBenchmarkCollectionJob(row: Row): BenchmarkCollectionJobRecord {
  return {
    id: String(row.id),
    track_code: String(row.track_code),
    source_code: String(row.source_code),
    target_name: String(row.target_name),
    organization_name: nullableString(row.organization_name),
    target_url: String(row.target_url),
    sample_id: nullableString(row.sample_id),
    status: String(row.status) as BenchmarkCollectionJobRecord["status"],
    attempt_count: Number(row.attempt_count),
    http_status: nullableNumber(row.http_status),
    content_type: nullableString(row.content_type),
    error_message: nullableString(row.error_message),
    raw_document_id: nullableString(row.raw_document_id),
    requested_by: String(row.requested_by),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: nullableString(row.completed_at)
  };
}

function mapBenchmarkRawDocument(row: Row): BenchmarkRawDocumentRecord {
  return {
    id: String(row.id),
    job_id: String(row.job_id),
    track_code: String(row.track_code),
    source_code: String(row.source_code),
    title: String(row.title),
    source_url: String(row.source_url),
    media_type: String(row.media_type),
    byte_count: Number(row.byte_count),
    sha256: String(row.sha256),
    storage_path: String(row.storage_path),
    text_excerpt: nullableString(row.text_excerpt),
    fetched_at: String(row.fetched_at),
    created_at: String(row.created_at)
  };
}

function mapBenchmarkSample(row: Row): BenchmarkSampleRecord {
  return {
    id: String(row.id),
    sample_key: String(row.sample_key),
    sample_type: String(row.sample_type) as BenchmarkSampleRecord["sample_type"],
    person_name: String(row.person_name),
    person_role: String(row.person_role),
    organization_name: String(row.organization_name),
    industry_code: String(row.industry_code),
    track_code: String(row.track_code),
    jurisdiction: String(row.jurisdiction),
    organization_stage: String(row.organization_stage),
    observation_date: String(row.observation_date),
    status: String(row.status) as BenchmarkSampleRecord["status"],
    summary: nullableString(row.summary),
    metadata: parseObject(row.metadata_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function mapBenchmarkEvidence(row: Row): BenchmarkEvidenceRecord {
  return {
    id: String(row.id),
    sample_id: String(row.sample_id),
    field_key: String(row.field_key),
    title: String(row.title),
    value: parseJsonValue(row.value_json),
    source_code: String(row.source_code),
    source_name: String(row.source_name),
    source_url: String(row.source_url),
    source_locator: nullableString(row.source_locator),
    publisher_type: String(row.publisher_type),
    publication_date: nullableString(row.publication_date),
    observed_at: String(row.observed_at),
    collection_method: String(row.collection_method),
    access_basis: String(row.access_basis),
    quality_score: Number(row.quality_score),
    confidence: String(row.confidence) as BenchmarkEvidenceRecord["confidence"],
    review_status: String(row.review_status) as BenchmarkEvidenceRecord["review_status"],
    collected_by: String(row.collected_by),
    collected_at: String(row.collected_at)
  };
}

function mapBenchmarkEvidenceReview(row: Row): BenchmarkEvidenceReviewRecord {
  return {
    id: String(row.id),
    evidence_id: String(row.evidence_id),
    sample_id: String(row.sample_id),
    decision: String(row.decision) as BenchmarkEvidenceReviewRecord["decision"],
    reviewer: String(row.reviewer),
    reason: String(row.reason),
    created_at: String(row.created_at)
  };
}

function mapBenchmarkTrait(row: Row): BenchmarkTraitRecord {
  return {
    id: String(row.id),
    sample_id: String(row.sample_id),
    trait_key: String(row.trait_key),
    trait_name: String(row.trait_name),
    hypothesis: String(row.hypothesis),
    direction: String(row.direction) as BenchmarkTraitRecord["direction"],
    confidence: String(row.confidence) as BenchmarkTraitRecord["confidence"],
    evidence_ids: parseArray(row.evidence_ids_json),
    review_status: String(row.review_status) as BenchmarkTraitRecord["review_status"],
    reviewed_by: nullableString(row.reviewed_by),
    review_reason: nullableString(row.review_reason),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function parseObject(value: unknown): JsonObject {
  return JSON.parse(String(value)) as JsonObject;
}

function parseArray(value: unknown): JsonValue[] {
  return JSON.parse(String(value)) as JsonValue[];
}

function parseJsonValue(value: unknown): JsonValue {
  return JSON.parse(String(value)) as JsonValue;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
