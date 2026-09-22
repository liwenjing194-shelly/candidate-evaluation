import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BenchmarkCollectionJobRecord, BenchmarkRawDocumentRecord, JsonObject, JsonValue } from "../domain/types.js";
import { AppDatabase } from "../db/database.js";
import { isJsonObject } from "../lib/json.js";
import { BenchmarkSampleService } from "./benchmark-sample-service.js";
import { ServiceError } from "./template-service.js";

const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const AUTOMATIC_METHODS = ["public_page", "public_search", "official_api", "public_filing", "bulk_download"];
const AUTOMATIC_SOURCE_TYPES = ["official_public", "official_public_api", "public_first_party"];

export class BenchmarkCollectionService {
  private plans: Map<string, JsonObject> = new Map();
  private readonly collectionTargetsPath: string;

  constructor(
    private readonly database: AppDatabase,
    private readonly benchmarkSamples: BenchmarkSampleService,
    private readonly storageDirectory: string,
    collectionTargetsPath: string
  ) {
    this.collectionTargetsPath = collectionTargetsPath;
    fs.mkdirSync(storageDirectory, { recursive: true });
    this.reload();
  }

  reload(): void {
    const registry = readJsonObject(this.collectionTargetsPath, "标杆样本自动采集计划");
    this.plans = new Map(
      objectArray(registry.plans)
        .map((plan) => [requiredString(plan.track_code, "plans.track_code"), plan] as const)
    );
  }

  listTargets(trackCode?: string): JsonObject {
    const code = optionalString(trackCode) ?? this.plans.keys().next().value;
    if (typeof code !== "string") throw new ServiceError("尚未配置任何自动采集计划", 404);
    const plan = this.requirePlan(code);
    const targets = objectArray(plan.targets).map((target) => {
      const urls = objectArray(target.urls);
      const automaticUrls = urls.filter((item) => typeof item.source_code === "string" && typeof item.url === "string");
      return {
        target_key: target.target_key ?? null,
        target_name: target.target_name ?? null,
        organization_name: target.organization_name ?? null,
        sample_key: target.sample_key ?? null,
        source_count: automaticUrls.length,
        automatic: true
      };
    });
    return {
      plan_version: plan.plan_version ?? "1.0.0",
      track_code: plan.track_code ?? code,
      track_name: plan.track_name ?? code,
      automatic: true,
      target_count: targets.length,
      source_job_count: targets.reduce((sum, target) => sum + Number(target.source_count ?? 0), 0),
      targets,
      governance: {
        ...(isJsonObject(plan.governance) ? plan.governance : {}),
        user_selects_target_or_source: false,
        collection_requires_registered_source_and_domain_allowlist: true,
        automatic_collection_does_not_mean_automatic_attribution: true
      },
      notice: "选择赛道后，系统按已登记的目标企业和合规公开来源批量采集；采集结果只进入原始文档和待复核证据队列。"
    } as unknown as JsonObject;
  }

  async autoCollect(body: unknown): Promise<JsonObject> {
    const input = requireObject(body);
    const trackCode = requiredString(input.track_code, "track_code");
    const requestedBy = requiredString(input.requested_by ?? "系统自动采集", "requested_by");
    const plan = this.requirePlan(trackCode);
    const runId = randomUUID();
    const targets = objectArray(plan.targets);
    const entries = targets.flatMap((target) => objectArray(target.urls).map((sourceTarget) => ({ target, sourceTarget })));
    const results: JsonObject[] = [];
    for (const entry of entries) {
      const sourceCode = optionalString(entry.sourceTarget.source_code);
      const targetUrl = optionalString(entry.sourceTarget.url);
      const targetName = optionalString(entry.target.target_name);
      if (!sourceCode || !targetUrl || !targetName) {
        results.push({
          collection_succeeded: false,
          automatic: true,
          target_key: entry.target.target_key ?? null,
          error: "采集计划存在缺少来源代码、目标名称或网址的配置",
          retryable: false
        });
        continue;
      }
      const sampleKey = optionalString(entry.target.sample_key);
      const sampleDetail = sampleKey ? this.benchmarkSamples.getSampleByKey(sampleKey) : null;
      const sample = sampleDetail && isJsonObject(sampleDetail.sample) ? sampleDetail.sample : null;
      try {
        const result = await this.createAndRun({
          track_code: trackCode,
          source_code: sourceCode,
          target_name: targetName,
          organization_name: optionalString(entry.target.organization_name),
          target_url: targetUrl,
          sample_id: sample ? optionalString(sample.id) : null,
          requested_by: requestedBy
        });
        results.push({
          ...result,
          automatic: true,
          run_id: runId,
          target_key: entry.target.target_key ?? null,
          sample_binding: sample ? "bound" : sampleKey ? "not_found" : "not_configured"
        });
      } catch (error) {
        results.push({
          collection_succeeded: false,
          automatic: true,
          run_id: runId,
          target_key: entry.target.target_key ?? null,
          source_code: sourceCode,
          target_url: targetUrl,
          error: error instanceof Error ? error.message : "自动采集任务创建失败",
          retryable: false,
          notice: "该条计划未创建采集任务；其他计划条目仍会继续执行。"
        });
      }
    }
    const completed = results.filter((item) => item.collection_succeeded === true).length;
    return {
      run_id: runId,
      track_code: trackCode,
      automatic: true,
      target_count: targets.length,
      job_count: entries.length,
      results,
      summary: {
        total: results.length,
        completed,
        failed: results.length - completed
      },
      notice: "本次自动采集已完成。原始文档和事实证据仍需进入智能复核队列，系统不会自动归因或改变投资结论。"
    } as unknown as JsonObject;
  }

  listJobs(trackCode?: string): JsonObject {
    const jobs = this.database.listBenchmarkCollectionJobs(trackCode);
    return {
      jobs,
      summary: {
        total: jobs.length,
        queued: jobs.filter((job) => job.status === "queued").length,
        running: jobs.filter((job) => job.status === "running").length,
        completed: jobs.filter((job) => job.status === "completed").length,
        failed: jobs.filter((job) => job.status === "failed").length
      },
      policy: {
        only_registered_sources: true,
        only_allowlisted_domains: true,
        redirects_are_not_followed: true,
        maximum_document_bytes: MAX_DOCUMENT_BYTES,
        automatic_fact_is_pending_review: true
      }
    } as unknown as JsonObject;
  }

  matchLocalMaterials(body: unknown): JsonObject {
    const input = requireObject(body);
    const trackCode = requiredString(input.track_code, "track_code");
    const matchedBy = requiredString(input.matched_by ?? "本地评审员", "matched_by");
    const samples = this.database.listBenchmarkSamples({ trackCode });
    const samplesByOrganization = new Map(
      samples.map((sample) => [normalizeOrganizationName(sample.organization_name), sample] as const)
    );
    const jobs = this.database.listBenchmarkCollectionJobs(trackCode);
    const completed = jobs.filter((job) => job.status === "completed" && job.raw_document_id);
    const matched: JsonObject[] = [];
    const unmatched: JsonObject[] = [];
    let alreadyLinked = 0;

    for (const job of completed) {
      if (job.sample_id) {
        alreadyLinked += 1;
        continue;
      }
      const organizationKey = normalizeOrganizationName(job.organization_name ?? "");
      const sample = organizationKey ? samplesByOrganization.get(organizationKey) : undefined;
      if (!sample || !job.raw_document_id) {
        unmatched.push({
          job_id: job.id,
          target_name: job.target_name,
          organization_name: job.organization_name,
          reason: job.organization_name === "行业监管与公开数据源"
            ? "赛道公共材料，不应归入单个候选样本"
            : "未找到同名企业样本"
        });
        continue;
      }

      const rawDocument = this.database.getBenchmarkRawDocument(job.raw_document_id);
      if (!rawDocument) {
        unmatched.push({
          job_id: job.id,
          target_name: job.target_name,
          organization_name: job.organization_name,
          reason: "原始文档记录不存在"
        });
        continue;
      }
      const source = this.benchmarkSamples.getSource(trackCode, job.source_code);
      const method = this.assertSourceCanBeCollected(source, job.source_code);
      const evidence = this.benchmarkSamples.addEvidence(sample.id, {
        field_key: `source_document.${job.id}`,
        title: `本地材料：${rawDocument.title}`,
        value: {
          raw_document_id: rawDocument.id,
          title: rawDocument.title,
          media_type: rawDocument.media_type,
          byte_count: rawDocument.byte_count,
          sha256: rawDocument.sha256,
          text_excerpt: rawDocument.text_excerpt,
          extraction_status: rawDocument.text_excerpt ? "document_excerpt_only" : "manual_extraction_required"
        },
        source_code: job.source_code,
        source_name: String(source.name ?? job.source_code),
        source_url: rawDocument.source_url,
        source_locator: "本地留存原始文件，待人工定位事实",
        publisher_type: String(source.source_type ?? "official_public"),
        observed_at: rawDocument.fetched_at,
        collection_method: method,
        access_basis: "已登记合规来源的本地留存材料",
        quality_score: boundedQuality(source.quality_baseline),
        confidence: "low",
        review_status: "pending",
        collected_by: matchedBy
      });
      this.database.bindBenchmarkCollectionJobSample(job.id, sample.id);
      matched.push({
        job_id: job.id,
        sample_id: sample.id,
        organization_name: sample.organization_name,
        raw_document_id: rawDocument.id,
        evidence_id: isJsonObject(evidence.evidence) ? evidence.evidence.id ?? null : null
      });
    }

    return {
      track_code: trackCode,
      matched,
      unmatched,
      summary: {
        local_document_count: completed.length,
        newly_matched: matched.length,
        already_linked: alreadyLinked,
        track_level_materials: unmatched.filter((item) => item.reason === "赛道公共材料，不应归入单个候选样本").length,
        unmatched_company_materials: unmatched.filter((item) => item.reason !== "赛道公共材料，不应归入单个候选样本").length
      },
      notice: "企业材料已按企业名称匹配为待复核证据；监管等公共材料保留在赛道层，不归因到个人。"
    } as unknown as JsonObject;
  }

  getJob(id: string): JsonObject {
    const job = this.database.requireBenchmarkCollectionJob(id);
    const rawDocument = job.raw_document_id
      ? this.database.getBenchmarkRawDocument(job.raw_document_id)
      : null;
    return {
      job,
      raw_document: rawDocument,
      notice: "原始文档仅代表采集成功；结构化事实、负责人归因和模板规则仍需人工复核。"
    } as unknown as JsonObject;
  }

  async createAndRun(body: unknown): Promise<JsonObject> {
    const input = requireObject(body);
    const trackCode = requiredString(input.track_code, "track_code");
    const sourceCode = requiredString(input.source_code, "source_code");
    const targetName = requiredString(input.target_name, "target_name");
    const organizationName = optionalString(input.organization_name);
    const targetUrl = requiredString(input.target_url, "target_url");
    const requestedBy = requiredString(input.requested_by ?? "尽调负责人", "requested_by");
    const sampleId = optionalString(input.sample_id);
    const source = this.benchmarkSamples.getSource(trackCode, sourceCode);
    this.assertSourceCanBeCollected(source, sourceCode);
    this.assertUrlAllowed(targetUrl, source);
    if (sampleId) {
      const detail = this.benchmarkSamples.getSample(sampleId);
      const sample = isJsonObject(detail.sample) ? detail.sample : {};
      if (String(sample.track_code ?? "") !== trackCode) {
        throw new ServiceError("目标样本与采集任务赛道不一致", 400);
      }
    }
    const job = this.database.createBenchmarkCollectionJob({
      trackCode,
      sourceCode,
      targetName,
      organizationName,
      targetUrl,
      sampleId,
      requestedBy
    });
    return this.execute(job.id);
  }

  async retry(id: string): Promise<JsonObject> {
    const job = this.database.requireBenchmarkCollectionJob(id);
    if (job.status !== "failed") throw new ServiceError("只有失败的采集任务可以重试", 409);
    return this.execute(id);
  }

  private async execute(id: string): Promise<JsonObject> {
    const job = this.database.requireBenchmarkCollectionJob(id);
    const source = this.benchmarkSamples.getSource(job.track_code, job.source_code);
    const method = this.assertSourceCanBeCollected(source, job.source_code);
    this.assertUrlAllowed(job.target_url, source);
    const attemptCount = job.attempt_count + 1;
    this.database.updateBenchmarkCollectionJob({
      id,
      status: "running",
      attemptCount,
      httpStatus: null,
      contentType: null,
      errorMessage: null,
      rawDocumentId: null,
      completedAt: null
    });

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(job.target_url, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            accept: "text/html,application/pdf,application/json;q=0.9,*/*;q=0.1",
            "user-agent": "CandidateEvaluationSystem/0.1 authorized-research-collector"
          }
        });
      } finally {
        clearTimeout(timeout);
      }
      if (response.status >= 300 && response.status < 400) {
        throw new CollectionFailure("来源返回了跳转；请使用跳转后的最终官方 URL", response.status);
      }
      if (!response.ok) throw new CollectionFailure(`来源返回HTTP ${response.status}`, response.status);
      const declaredLength = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_DOCUMENT_BYTES) {
        throw new CollectionFailure(`原始文档超过${MAX_DOCUMENT_BYTES / 1024 / 1024}MB限制`, response.status);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_DOCUMENT_BYTES) throw new CollectionFailure(`原始文档超过${MAX_DOCUMENT_BYTES / 1024 / 1024}MB限制`, response.status);
      const contentType = response.headers.get("content-type")?.split(";")[0]?.trim()
        || contentTypeFromUrl(job.target_url);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const extraction = extractDocument(buffer, contentType, job.target_url);
      const extension = extensionFor(contentType, job.target_url);
      const storagePath = path.join(this.storageDirectory, `${job.id}${extension}`);
      fs.writeFileSync(storagePath, buffer, { flag: "wx" });
      const rawDocument = this.database.createBenchmarkRawDocument({
        jobId: job.id,
        trackCode: job.track_code,
        sourceCode: job.source_code,
        title: extraction.title,
        sourceUrl: job.target_url,
        mediaType: contentType,
        byteCount: buffer.byteLength,
        sha256,
        storagePath,
        textExcerpt: extraction.textExcerpt
      });
      const completedAt = new Date().toISOString();
      const completedJob = this.database.updateBenchmarkCollectionJob({
        id: job.id,
        status: "completed",
        attemptCount,
        httpStatus: response.status,
        contentType,
        errorMessage: null,
        rawDocumentId: rawDocument.id,
        completedAt
      });
      const importedEvidence = job.sample_id
        ? this.benchmarkSamples.addEvidence(job.sample_id, {
          field_key: `source_document.${job.id}`,
          title: `自动采集原始文档：${extraction.title}`,
          value: {
            raw_document_id: rawDocument.id,
            title: extraction.title,
            media_type: contentType,
            sha256,
            text_excerpt: extraction.textExcerpt,
            extraction_status: extraction.textExcerpt ? "document_excerpt_only" : "manual_extraction_required"
          },
          source_code: job.source_code,
          source_name: String(source.name ?? job.source_code),
          source_url: job.target_url,
          source_locator: extraction.locator,
          publisher_type: String(source.source_type ?? "official_public"),
          observed_at: completedAt,
          collection_method: method,
          access_basis: "来源目录允许的公开访问方式",
          quality_score: boundedQuality(source.quality_baseline),
          confidence: "low",
          review_status: "pending",
          collected_by: job.requested_by
        })
        : null;
      return {
        collection_succeeded: true,
        job: completedJob,
        raw_document: rawDocument,
        imported_evidence: importedEvidence,
        notice: job.sample_id
          ? "原始文档已放入目标样本的待复核证据队列，尚未自动抽取或确认负责人特质。"
          : "原始文档已留存；如需进入样本复核队列，请将任务绑定到目标样本后重新采集。"
      } as unknown as JsonObject;
    } catch (error) {
      const failure = error instanceof CollectionFailure
        ? error
        : error instanceof Error && error.name === "AbortError"
          ? new CollectionFailure("采集超时，未完成下载", null)
          : new CollectionFailure(describeCollectionError(error), null);
      const failedJob = this.database.updateBenchmarkCollectionJob({
        id: job.id,
        status: "failed",
        attemptCount,
        httpStatus: failure.httpStatus,
        contentType: null,
        errorMessage: failure.message,
        rawDocumentId: null,
        completedAt: new Date().toISOString()
      });
      return {
        collection_succeeded: false,
        job: failedJob,
        error: failure.message,
        retryable: true,
        notice: "采集失败不会改变样本、评分或投资结论；确认来源和网络后可以重试。"
      } as unknown as JsonObject;
    }
  }

  private assertSourceCanBeCollected(source: JsonObject, sourceCode: string): string {
    const sourceType = String(source.source_type ?? "");
    if (!AUTOMATIC_SOURCE_TYPES.includes(sourceType)) {
      throw new ServiceError(`来源${sourceCode}不是自动公开采集类型，请使用授权或人工导入`, 400);
    }
    const allowedMethods = stringArray(source.allowed_methods);
    const method = AUTOMATIC_METHODS.find((candidate) => allowedMethods.includes(candidate));
    if (!method || String(source.automation_mode ?? "").includes("manual_only")) {
      throw new ServiceError(`来源${sourceCode}未声明可自动执行的公开采集方式`, 400);
    }
    return method;
  }

  private assertUrlAllowed(targetUrl: string, source: JsonObject): void {
    let target: URL;
    try {
      target = new URL(targetUrl);
    } catch {
      throw new ServiceError("target_url必须是有效的HTTP或HTTPS地址", 400);
    }
    if (!/^https?:$/i.test(target.protocol)) throw new ServiceError("采集器只允许HTTP或HTTPS地址", 400);
    const allowedDomains = stringArray(source.allowed_domains);
    const sourceHomepage = parseHttpUrl(source.url);
    const accepted = allowedDomains.length > 0
      ? allowedDomains.some((domain) => hostMatches(target.hostname, domain))
      : sourceHomepage ? hostMatches(target.hostname, sourceHomepage.hostname) : false;
    if (!accepted) {
      throw new ServiceError("目标地址不在该数据源的域名白名单内，请先在来源目录登记域名", 400, {
        target_host: target.hostname,
        source_code: source.code ?? null
      });
    }
  }

  private requirePlan(trackCode: string): JsonObject {
    const plan = this.plans.get(trackCode);
    if (!plan) throw new ServiceError("当前赛道尚未配置自动采集计划", 404, { track_code: trackCode });
    return plan;
  }
}

class CollectionFailure extends Error {
  constructor(message: string, readonly httpStatus: number | null) {
    super(message);
    this.name = "CollectionFailure";
  }
}

function describeCollectionError(error: unknown): string {
  if (!(error instanceof Error)) return "采集失败";
  const cause = error.cause;
  const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "";
  if (code === "EACCES" || code === "EPERM") return "运行服务没有外网访问权限，请使用允许HTTPS出站访问的进程启动服务";
  if (code === "ENOTFOUND") return "无法解析来源域名，请检查网络或DNS设置";
  if (code === "ECONNREFUSED") return "来源服务器拒绝连接";
  if (code === "ECONNRESET") return "来源服务器中断了连接，可稍后重试";
  if (code === "ETIMEDOUT") return "连接来源服务器超时";
  return error.message || "采集失败";
}

function extractDocument(buffer: Buffer, mediaType: string, sourceUrl: string): { title: string; textExcerpt: string | null; locator: string } {
  if (/pdf/i.test(mediaType) || /\.pdf(?:$|\?)/i.test(sourceUrl)) {
    return { title: path.basename(new URL(sourceUrl).pathname) || "官方PDF文档", textExcerpt: null, locator: "原始PDF文件，需人工定位页码并抽取事实" };
  }
  const raw = buffer.toString("utf8");
  const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?.replace(/\s+/g, " ").trim()
    || path.basename(new URL(sourceUrl).pathname)
    || "官方公开文档";
  const textExcerpt = raw
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000) || null;
  return { title, textExcerpt, locator: textExcerpt ? "网页正文前4000字符（待人工核验）" : "网页未提取到正文" };
}

function parseHttpUrl(value: JsonValue | undefined): URL | null {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return null;
  try { return new URL(value); } catch { return null; }
}

function hostMatches(host: string, domain: string): boolean {
  const normalized = domain.replace(/^https?:\/\//i, "").split("/")[0]?.toLowerCase().replace(/^www\./, "") || "";
  const candidate = host.toLowerCase().replace(/^www\./, "");
  return candidate === normalized || candidate.endsWith(`.${normalized}`);
}

function contentTypeFromUrl(value: string): string {
  return /\.pdf(?:$|\?)/i.test(value) ? "application/pdf" : "text/html";
}

function extensionFor(mediaType: string, url: string): string {
  if (/pdf/i.test(mediaType) || /\.pdf(?:$|\?)/i.test(url)) return ".pdf";
  if (/json/i.test(mediaType)) return ".json";
  if (/html|text/i.test(mediaType)) return ".html";
  return ".bin";
}

function boundedQuality(value: JsonValue | undefined): number {
  const score = typeof value === "number" && Number.isFinite(value) ? value : 0.5;
  return Math.max(0, Math.min(1, score));
}

function normalizeOrganizationName(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s·,，.。()（）\-_]/g, "")
    .replace(/股份有限公司|有限责任公司|有限公司|incorporated|corporation|corp|inc$/g, "")
    .trim();
}

function requireObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new ServiceError("请求体必须是JSON对象", 400);
  return value;
}

function readJsonObject(filePath: string, name: string): JsonObject {
  if (!fs.existsSync(filePath)) throw new Error(`${name}不存在: ${filePath}`);
  const value = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isJsonObject(value)) throw new Error(`${name}必须是JSON对象`);
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length < 2) throw new ServiceError(`${field}至少需要2个字符`, 400);
  return value.trim();
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function objectArray(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}
