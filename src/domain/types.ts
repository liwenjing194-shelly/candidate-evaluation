export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export interface TemplateGeneratorInput extends JsonObject {
  schema_version: string;
  request_id: string;
  industry: JsonObject & { name: string; normalized_code?: string };
  track: JsonObject & { name: string; normalized_code?: string };
  investment_purpose: string;
  project_stage: string;
  candidate_role: string;
  jurisdiction: string;
  language: string;
}

export interface EvaluationTemplate extends JsonObject {
  schema_version: string;
  template_id: string;
  version: string;
  name: string;
  status: string;
  scope: JsonObject;
  generation: JsonObject;
  score_scale: number;
  dimensions: JsonObject[];
  gates: JsonObject[];
  decision_rules: JsonObject;
  workflow: JsonObject;
  sensitive_fields_excluded: JsonValue[];
  sources: JsonObject[];
}

export interface ValidationIssue {
  path: string;
  message: string;
  keyword?: string;
}

export interface ValidationReport {
  valid: boolean;
  schema_errors: ValidationIssue[];
  business_errors: ValidationIssue[];
  warnings: ValidationIssue[];
  checked_at: string;
}

export interface GenerationRecord {
  id: string;
  status: string;
  request: JsonObject;
  draft_template_id: string | null;
  validation_report: ValidationReport | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateRecord {
  id: string;
  template_key: string;
  status: string;
  content: EvaluationTemplate;
  created_at: string;
  updated_at: string;
  last_edited_by: string | null;
  last_edit_reason: string | null;
}

export interface TemplateVersionRecord {
  id: string;
  template_id: string;
  version: string;
  content: EvaluationTemplate;
  approved_by: string;
  approval_note: string;
  published_at: string;
}

export type EvaluationTaskStatus =
  | "gate_review"
  | "scoring"
  | "decision_pending"
  | "blocked_for_review"
  | "completed";

export type GateAssessmentStatus = "pending" | "pass" | "fail" | "unconfirmed";

export interface EvaluationTaskRecord {
  id: string;
  template_version_id: string;
  template_id: string;
  template_key: string;
  template_version: string;
  status: EvaluationTaskStatus;
  candidate_name: string;
  candidate_reference: string | null;
  candidate_snapshot: JsonObject;
  created_by: string;
  assigned_to: string;
  overall_score: number | null;
  final_conclusion: string | null;
  final_decided_by: string | null;
  final_decision_reason: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface EvaluationGateResultRecord {
  id: string;
  task_id: string;
  gate_id: string;
  gate_name: string;
  gate_order: number;
  critical: boolean;
  status: GateAssessmentStatus;
  veto_triggered: boolean;
  evidence: JsonValue[];
  note: string | null;
  assessed_by: string | null;
  assessed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvaluationDimensionScoreRecord {
  id: string;
  task_id: string;
  dimension_id: string;
  dimension_name: string;
  dimension_order: number;
  weight: number;
  score: number | null;
  weighted_score: number | null;
  information_status: string | null;
  confidence: string | null;
  evidence: JsonValue[];
  note: string | null;
  scored_by: string | null;
  scored_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupplementRequestRecord {
  id: string;
  task_id: string;
  gate_id: string;
  material: string;
  owner: string;
  due_date: string;
  verification_method: string;
  status: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvaluationDecisionRecord {
  id: string;
  task_id: string;
  conclusion: string;
  reason: string;
  decided_by: string;
  constraints_snapshot: JsonObject;
  created_at: string;
}

export interface EvaluationAuditRecord {
  id: string;
  task_id: string;
  event_type: string;
  actor: string;
  reason: string | null;
  before_snapshot: JsonValue;
  after_snapshot: JsonValue;
  created_at: string;
}

export type EvaluationDataSourceType = "local_file" | "official_public";

export interface EvaluationDataImportRecord {
  id: string;
  task_id: string;
  source_type: EvaluationDataSourceType;
  source_name: string;
  file_name: string | null;
  media_type: string | null;
  source_url: string | null;
  official_source_code: string | null;
  status: "completed" | "failed";
  record_count: number;
  metadata: JsonObject;
  sha256: string | null;
  imported_by: string;
  imported_at: string;
}

export interface EvaluationEvidenceItemRecord {
  id: string;
  task_id: string;
  import_id: string;
  evidence_key: string;
  label: string;
  value: JsonValue;
  normalized_text: string;
  source_locator: string | null;
  observed_at: string | null;
  quality_score: number;
  created_at: string;
}

export interface EvaluationPreassessmentRunRecord {
  id: string;
  task_id: string;
  status: "completed";
  engine_version: string;
  result: JsonObject;
  created_by: string;
  created_at: string;
}

export type BenchmarkSampleType = "benchmark" | "control" | "risk" | "internal_candidate";

export interface BenchmarkSampleRecord {
  id: string;
  sample_key: string;
  sample_type: BenchmarkSampleType;
  person_name: string;
  person_role: string;
  organization_name: string;
  industry_code: string;
  track_code: string;
  jurisdiction: string;
  organization_stage: string;
  observation_date: string;
  status: "collecting" | "ready_for_review" | "approved" | "retired";
  summary: string | null;
  metadata: JsonObject;
  created_at: string;
  updated_at: string;
}

export interface BenchmarkEvidenceRecord {
  id: string;
  sample_id: string;
  field_key: string;
  title: string;
  value: JsonValue;
  source_code: string;
  source_name: string;
  source_url: string;
  source_locator: string | null;
  publisher_type: string;
  publication_date: string | null;
  observed_at: string;
  collection_method: string;
  access_basis: string;
  quality_score: number;
  confidence: "low" | "medium" | "high";
  review_status: "pending" | "verified" | "rejected";
  collected_by: string;
  collected_at: string;
}

export type BenchmarkCollectionJobStatus = "queued" | "running" | "completed" | "failed";

export interface BenchmarkCollectionJobRecord {
  id: string;
  track_code: string;
  source_code: string;
  target_name: string;
  organization_name: string | null;
  target_url: string;
  sample_id: string | null;
  status: BenchmarkCollectionJobStatus;
  attempt_count: number;
  http_status: number | null;
  content_type: string | null;
  error_message: string | null;
  raw_document_id: string | null;
  requested_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface BenchmarkRawDocumentRecord {
  id: string;
  job_id: string;
  track_code: string;
  source_code: string;
  title: string;
  source_url: string;
  media_type: string;
  byte_count: number;
  sha256: string;
  storage_path: string;
  text_excerpt: string | null;
  fetched_at: string;
  created_at: string;
}

export interface BenchmarkEvidenceReviewRecord {
  id: string;
  evidence_id: string;
  sample_id: string;
  decision: "verified" | "rejected";
  reviewer: string;
  reason: string;
  created_at: string;
}

export interface BenchmarkTraitRecord {
  id: string;
  sample_id: string;
  trait_key: string;
  trait_name: string;
  hypothesis: string;
  direction: "positive" | "negative" | "mixed";
  confidence: "low" | "medium" | "high";
  evidence_ids: JsonValue[];
  review_status: "draft" | "approved" | "rejected";
  reviewed_by: string | null;
  review_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface PolicyPackTaxonomyTerm extends JsonObject {
  code: string;
  name: string;
  aliases: JsonValue[];
}

export interface PolicyPackManifest extends JsonObject {
  schema_version: string;
  policy_pack_id: string;
  version: string;
  name: string;
  status: "draft" | "approved" | "retired";
  default_for_mock: boolean;
  taxonomy: JsonObject & {
    industry: PolicyPackTaxonomyTerm;
    track: PolicyPackTaxonomyTerm;
  };
  definitions: JsonObject & {
    industry: string;
    track: string;
  };
  applicability: JsonObject;
  template_file: string;
  required_gate_order: JsonValue[];
  governance_rules: JsonObject;
  review: JsonObject;
}

export interface ResolvedPolicyPack {
  manifest: PolicyPackManifest;
  template: EvaluationTemplate;
  match: "exact" | "fallback";
}

export type TrackOnboardingDraftStatus = "ready_for_review" | "discovery_ready" | "confirmed";

export interface TrackOnboardingDraftRecord {
  id: string;
  context_key: string;
  industry: JsonObject;
  track: JsonObject;
  status: TrackOnboardingDraftStatus;
  draft: JsonObject;
  created_at: string;
  updated_at: string;
}
