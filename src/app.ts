import fs from "node:fs";
import type { JsonObject } from "./domain/types.js";
import { DashScopeTemplateProvider } from "./providers/dashscope-template-provider.js";
import { listRuleLibrary } from "./service/rule-library-service.js";
import { registerAccessControl } from "./access-control.js";
import { PortableBackupService } from "./service/portable-backup-service.js";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import type { AppConfig } from "./config.js";
import { createConfig } from "./config.js";
import { AppDatabase } from "./db/database.js";
import { PolicyPackRegistry } from "./policy/policy-pack-registry.js";
import { MockTemplateProvider } from "./providers/mock-template-provider.js";
import { EvaluationTaskService } from "./service/evaluation-task-service.js";
import { DataIntelligenceService } from "./service/data-intelligence-service.js";
import { BenchmarkSampleService } from "./service/benchmark-sample-service.js";
import { BenchmarkCollectionService } from "./service/benchmark-collection-service.js";
import { IndustryTrackSetupService } from "./service/industry-track-setup-service.js";
import { TrackOnboardingService } from "./service/track-onboarding-service.js";
import { TrackDiscoveryService } from "./service/track-discovery-service.js";
import { ServiceError, TemplateService } from "./service/template-service.js";
import { SchemaValidator } from "./validation/schema-validator.js";
import { isJsonObject } from "./lib/json.js";

export interface BuildAppOptions {
  provider?: "mock" | "dashscope";
  accessPassword?: string;
  config?: Partial<AppConfig>;
  logger?: boolean;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = createConfig(options.config);
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 12 * 1024 * 1024
  });
  registerAccessControl(app, options.accessPassword ?? process.env.APP_ACCESS_PASSWORD, process.env.RENDER === "true");
  const database = new AppDatabase(config.databasePath);
  const schemas = new SchemaValidator(
    config.inputSchemaPath,
    config.templateSchemaPath,
    config.goldenSchemaPath
  );
  const policyPacks = new PolicyPackRegistry(config.policyPackDirectory);
  const freeDemo = process.env.FREE_DEMO_MODE === "true";
  const mode = freeDemo ? "mock" : options.provider ?? process.env.TEMPLATE_PROVIDER ?? "mock";
  if (mode !== "mock" && mode !== "dashscope") throw new Error("TEMPLATE_PROVIDER只允许mock或dashscope");
  const mockProvider = new MockTemplateProvider(policyPacks);
  const provider = mode === "dashscope" ? new DashScopeTemplateProvider(mockProvider, schemas, { apiKey: process.env.DASHSCOPE_API_KEY ?? "", model: process.env.TEMPLATE_MODEL ?? "qwen-plus" }) : mockProvider;
  const service = new TemplateService(database, provider, schemas, policyPacks);
  const evaluationTasks = new EvaluationTaskService(database);
  const backups = new PortableBackupService(database, schemas, evaluationTasks);
  const dataIntelligence = new DataIntelligenceService(database);
  const benchmarkSamples = new BenchmarkSampleService(
    database,
    config.benchmarkLibraryRegistryPath,
    config.benchmarkLibraryDirectory
  );
  const benchmarkCollector = new BenchmarkCollectionService(
    database,
    benchmarkSamples,
    config.benchmarkCollectorDirectory,
    config.benchmarkCollectionTargetsPath
  );
  const industryTrackSetup = new IndustryTrackSetupService(
    config,
    schemas,
    policyPacks,
    benchmarkSamples,
    benchmarkCollector
  );
  const trackOnboarding = new TrackOnboardingService(database, policyPacks);
  const trackDiscovery = new TrackDiscoveryService(database, benchmarkSamples, config.trackDiscoveryCatalogPath);

  void app.register(multipart, {
    limits: { files: 1, fileSize: 10 * 1024 * 1024 }
  });

  app.addHook("onClose", async () => {
    database.close();
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceError) {
      void reply.status(error.statusCode).send({
        error: error.message,
        details: error.details ?? null
      });
      return;
    }
    const httpError = error as { statusCode?: unknown; message?: unknown };
    if (typeof httpError.statusCode === "number" && httpError.statusCode >= 400 && httpError.statusCode < 500) {
      void reply.status(httpError.statusCode).send({ error: typeof httpError.message === "string" ? httpError.message : "请求错误" });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: "服务器内部错误" });
  });

  app.get("/api/health", async () => ({ status: "ok", provider: mode, database: "sqlite" }));
  app.get("/api/deployment-info", async () => ({ free_demo: freeDemo, provider: mode, storage: freeDemo ? "ephemeral" : "local", backup_scope: "规则恢复为草案；评估报告只读存档，不恢复评估任务、原始附件或样本库" }));
  app.get("/api/portable-backup", async (_request, reply) => reply
    .header("Content-Disposition", 'attachment; filename="candidate-rules-and-reports.json"')
    .header("Cache-Control", "no-store").send(backups.export()));
  app.post("/api/portable-backup/restore", { bodyLimit: 10 * 1024 * 1024 }, async request => backups.restore(request.body));
  app.get("/api/report-archives", async () => ({ archives: database.listReportArchives() }));
  app.get<{ Params: { id: string } }>("/api/report-archives/:id", async request => {
    const archive = database.getReportArchive(request.params.id);
    if (!archive) throw new ServiceError("未找到报告存档", 404);
    return archive;
  });
  app.get("/api/rule-library", async () => listRuleLibrary(database, policyPacks));
  app.get<{ Params: { id: string } }>("/api/rule-library/versions/:id", async request => {
    const record = database.getVersion(request.params.id);
    if (!record) throw new ServiceError("未找到已发布规则版本", 404);
    return record;
  });

  app.get("/api/policy-packs", async () => ({
    policy_packs: policyPacks.list()
      .filter((manifest) => manifest.status === "approved")
      .map((manifest) => ({
        id: manifest.policy_pack_id,
        name: manifest.name,
        version: manifest.version,
        status: manifest.status,
        industry: manifest.taxonomy.industry,
        track: manifest.taxonomy.track,
        definitions: manifest.definitions,
        applicability: manifest.applicability
      }))
  }));

  app.get("/api/industry-track-configurations/bases", async () => industryTrackSetup.listBases());

  app.post(
    "/api/industry-track-configurations",
    async (request, reply) => {
      const created = industryTrackSetup.create(request.body);
      const body = isJsonObject(request.body) ? request.body : {};
      const track = isJsonObject(created.track) ? created.track : {};
      const industry = isJsonObject(created.industry) ? created.industry : {};
      let offlineImport: JsonObject | null = null;
      if (body.auto_import_offline_candidates !== false) {
        try {
          offlineImport = trackDiscovery.importOfflineCandidates({ track_code: track.code, industry_name: industry.name, track_name: track.name, imported_by: "系统自动初始化" });
        } catch (error) {
          app.log.warn(error);
          offlineImport = { status: "unavailable", notice: "样本暂未补充，规则已建立，可继续生成模板并人工发布。" };
        }
      }
      return reply.status(201).send({ ...created, offline_import: offlineImport });
    }
  );

  app.post(
    "/api/track-onboarding/drafts",
    async (request, reply) => reply.status(201).send(trackOnboarding.createOrGet(request.body))
  );

  app.get<{ Params: { id: string } }>(
    "/api/track-onboarding/drafts/:id",
    async (request) => trackOnboarding.get(request.params.id)
  );

  app.post<{ Params: { id: string } }>(
    "/api/track-onboarding/drafts/:id/discover",
    async (request) => trackDiscovery.discover(request.params.id)
  );

  app.post(
    "/api/benchmark-library/offline-seeds/import",
    async (request, reply) => reply.status(201).send(trackDiscovery.importOfflineCandidates(request.body))
  );

  app.post("/api/template-generations", async (request, reply) => {
    const result = await service.generate(request.body);
    return reply.status(201).send(result);
  });

  app.get<{ Params: { id: string } }>("/api/template-generations/:id", async (request) => {
    return service.getGeneration(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/templates/:id", async (request) => {
    return service.getTemplate(request.params.id);
  });

  app.patch<{ Params: { id: string } }>("/api/templates/:id", async (request) => {
    return service.updateTemplate(request.params.id, request.body);
  });

  app.post<{ Params: { id: string } }>("/api/templates/:id/validate", async (request) => {
    return service.validateStoredTemplate(request.params.id);
  });

  app.post<{ Params: { id: string } }>("/api/templates/:id/publish", async (request) => {
    return service.publishTemplate(request.params.id, request.body);
  });

  app.get<{ Params: { id: string } }>("/api/templates/:id/versions", async (request) => {
    return service.listVersions(request.params.id);
  });

  app.get("/api/published-template-versions", async () => {
    return evaluationTasks.listPublishedTemplateVersions();
  });

  app.get("/api/official-data-sources", async () => dataIntelligence.listOfficialSources());

  app.get("/api/benchmark-library/libraries", async () => benchmarkSamples.listLibraries());

  app.get<{ Querystring: { track_code?: string } }>(
    "/api/benchmark-library/collector/jobs",
    async (request) => benchmarkCollector.listJobs(request.query.track_code)
  );

  app.get<{ Querystring: { track_code?: string } }>(
    "/api/benchmark-library/collector/targets",
    async (request) => benchmarkCollector.listTargets(request.query.track_code)
  );

  app.post(
    "/api/benchmark-library/collector/auto-runs",
    async (request, reply) => reply.status(201).send(await benchmarkCollector.autoCollect(request.body))
  );

  app.post(
    "/api/benchmark-library/materials/match-local",
    async (request) => benchmarkCollector.matchLocalMaterials(request.body)
  );

  app.get<{ Params: { id: string } }>(
    "/api/benchmark-library/collector/jobs/:id",
    async (request) => benchmarkCollector.getJob(request.params.id)
  );

  app.post(
    "/api/benchmark-library/collector/jobs",
    async (request, reply) => reply.status(201).send(await benchmarkCollector.createAndRun(request.body))
  );

  app.post<{ Params: { id: string } }>(
    "/api/benchmark-library/collector/jobs/:id/retry",
    async (request) => benchmarkCollector.retry(request.params.id)
  );

  app.get<{ Querystring: { track_code?: string } }>(
    "/api/benchmark-library/sources",
    async (request) => benchmarkSamples.listSources(request.query.track_code ?? "ai_short_drama")
  );

  app.get<{ Querystring: { track_code?: string } }>(
    "/api/benchmark-library/methodology",
    async (request) => benchmarkSamples.getMethodology(request.query.track_code ?? "ai_short_drama")
  );

  app.get<{ Querystring: { track_code?: string } }>(
    "/api/benchmark-library/cohort-analysis",
    async (request) => benchmarkSamples.getCohortAnalysis(request.query.track_code ?? "ai_short_drama")
  );

  app.get<{
    Querystring: { track_code?: string; sample_type?: string };
  }>("/api/benchmark-library/samples", async (request) => benchmarkSamples.listSamples({
    ...(request.query.track_code ? { trackCode: request.query.track_code } : {}),
    ...(request.query.sample_type ? { sampleType: request.query.sample_type } : {})
  }));

  app.get<{ Querystring: { track_code?: string } }>(
    "/api/benchmark-library/review-queue",
    async (request) => benchmarkSamples.listReviewQueue(request.query.track_code ?? "ai_short_drama")
  );

  app.post(
    "/api/benchmark-library/review-queue/batch-review",
    async (request) => benchmarkSamples.reviewQueueBatch(request.body)
  );

  app.get<{ Params: { id: string } }>("/api/benchmark-library/samples/:id", async (request) => (
    benchmarkSamples.getSample(request.params.id)
  ));

  app.post("/api/benchmark-library/samples", async (request, reply) => (
    reply.status(201).send(benchmarkSamples.createSample(request.body))
  ));

  app.post<{ Params: { id: string } }>(
    "/api/benchmark-library/samples/:id/evidence",
    async (request, reply) => reply.status(201).send(
      benchmarkSamples.addEvidence(request.params.id, request.body)
    )
  );

  app.post<{ Params: { id: string; evidenceId: string } }>(
    "/api/benchmark-library/samples/:id/evidence/:evidenceId/review",
    async (request) => benchmarkSamples.reviewEvidence(
      request.params.id,
      request.params.evidenceId,
      request.body
    )
  );

  app.post("/api/evaluation-tasks", async (request, reply) => {
    return reply.status(201).send(evaluationTasks.createTask(request.body));
  });

  app.get("/api/evaluation-tasks", async () => {
    return evaluationTasks.listTasks();
  });

  app.get<{ Params: { id: string } }>("/api/evaluation-tasks/:id", async (request) => {
    return evaluationTasks.getTask(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/evaluation-tasks/:id/data", async (request) => {
    return dataIntelligence.getTaskData(request.params.id);
  });

  app.post<{
    Params: { id: string };
    Querystring: {
      imported_by?: string;
      official_source_code?: string;
      source_url?: string;
    };
  }>("/api/evaluation-tasks/:id/data-imports/files", async (request, reply) => {
    const file = await request.file();
    if (!file) throw new ServiceError("请选择要导入的文件", 400);
    const result = await dataIntelligence.importFile(request.params.id, {
      fileName: file.filename,
      mediaType: file.mimetype,
      buffer: await file.toBuffer(),
      importedBy: request.query.imported_by ?? "尽调负责人",
      officialSourceCode: request.query.official_source_code ?? null,
      sourceUrl: request.query.source_url ?? null
    });
    return reply.status(201).send(result);
  });

  app.post<{ Params: { id: string } }>(
    "/api/evaluation-tasks/:id/data-imports/official",
    async (request, reply) => reply.status(201).send(
      dataIntelligence.importOfficialRecords(request.params.id, request.body)
    )
  );

  app.post<{ Params: { id: string } }>(
    "/api/evaluation-tasks/:id/preassessments",
    async (request, reply) => reply.status(201).send(
      dataIntelligence.runPreassessment(request.params.id, request.body)
    )
  );

  app.post<{ Params: { id: string; runId: string } }>(
    "/api/evaluation-tasks/:id/preassessments/:runId/apply",
    async (request) => ({
      application: dataIntelligence.applyPreassessment(
        request.params.id,
        request.params.runId,
        request.body
      ),
      task_detail: evaluationTasks.getTask(request.params.id)
    })
  );

  app.put<{ Params: { id: string; gateId: string } }>(
    "/api/evaluation-tasks/:id/gates/:gateId",
    async (request) => evaluationTasks.assessGate(request.params.id, request.params.gateId, request.body)
  );

  app.put<{ Params: { id: string; dimensionId: string } }>(
    "/api/evaluation-tasks/:id/dimensions/:dimensionId",
    async (request) => evaluationTasks.scoreDimension(request.params.id, request.params.dimensionId, request.body)
  );

  app.patch<{ Params: { id: string; supplementId: string } }>(
    "/api/evaluation-tasks/:id/supplements/:supplementId",
    async (request) => evaluationTasks.updateSupplement(
      request.params.id,
      request.params.supplementId,
      request.body
    )
  );

  app.post<{ Params: { id: string } }>("/api/evaluation-tasks/:id/decision", async (request) => {
    return evaluationTasks.recordDecision(request.params.id, request.body);
  });

  app.get<{ Params: { id: string } }>("/api/evaluation-tasks/:id/audit", async (request) => {
    return evaluationTasks.getAuditHistory(request.params.id);
  });

  app.get<{ Params: { id: string } }>("/api/evaluation-tasks/:id/report", async (request) => {
    return evaluationTasks.getReport(request.params.id);
  });

  app.get("/", async (_request, reply) => {
    if (!fs.existsSync(config.publicIndexPath)) {
      return reply.status(404).send({ error: "操作页面尚未生成" });
    }
    return reply.type("text/html; charset=utf-8").send(fs.readFileSync(config.publicIndexPath, "utf8"));
  });

  return app;
}
