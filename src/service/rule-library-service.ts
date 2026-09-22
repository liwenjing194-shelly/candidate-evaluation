import type { AppDatabase } from "../db/database.js";
import type { PolicyPackRegistry } from "../policy/policy-pack-registry.js";

export function listRuleLibrary(database: AppDatabase, registry: PolicyPackRegistry) {
  const groups = new Map<string, { id: string; name: string; industry: string; track: string; latest_draft: unknown; latest_published: unknown; history_count: number }>();
  for (const record of database.listRuleTemplates()) {
    const scope = record.content.scope;
    let entry = groups.get(record.template_key);
    if (!entry) {
      entry = { id: record.template_key, name: record.content.name, industry: String(scope.industry), track: String(scope.track), latest_draft: null, latest_published: null, history_count: 0 };
      groups.set(record.template_key, entry);
    }
    entry.history_count++;
    if (record.status !== "published" && record.status !== "retired" && !entry.latest_draft) entry.latest_draft = {
      id: record.id, status: record.status, updated_at: record.updated_at, model: record.content.generation.model
    };
  }
  for (const version of database.listPublishedVersions()) {
    const entry = groups.get(version.content.template_id);
    if (entry && !entry.latest_published) entry.latest_published = { id: version.id, template_id: version.template_id, version: version.version, published_at: version.published_at };
  }
  for (const pack of registry.list()) {
    if (!groups.has(pack.policy_pack_id)) groups.set(pack.policy_pack_id, { id: pack.policy_pack_id, name: pack.name, industry: pack.taxonomy.industry.name, track: pack.taxonomy.track.name, latest_draft: null, latest_published: null, history_count: 0 });
  }
  return { rules: [...groups.values()], notice: "每个规则系列显示最新草案与最新已发布版本。草案不替代已发布规则，只有已发布版本可创建评估任务。" };
}
