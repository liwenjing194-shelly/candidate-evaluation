import fs from "node:fs";
import path from "node:path";

export interface AppConfig {
  projectRoot: string;
  dataRoot: string;
  databasePath: string;
  inputSchemaPath: string;
  templateSchemaPath: string;
  goldenSchemaPath: string;
  policyPackDirectory: string;
  benchmarkLibraryRegistryPath: string;
  benchmarkLibraryDirectory: string;
  benchmarkCollectorDirectory: string;
  benchmarkCollectionTargetsPath: string;
  trackDiscoveryCatalogPath: string;
  /** @deprecated 保留配置字段，兼容旧版本地配置；样本库现在由注册表路由。 */
  benchmarkSourceCatalogPath: string;
  /** @deprecated 保留配置字段，兼容旧版本地配置；样本库现在由注册表路由。 */
  benchmarkSeedPath: string;
  /** @deprecated 保留配置字段，兼容旧版本地配置；样本库现在由注册表路由。 */
  benchmarkMethodologyPath: string;
  publicIndexPath: string;
}

export function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const projectRoot = overrides.projectRoot ?? process.cwd();
  const dataRoot = overrides.dataRoot ?? (process.env.PERSISTENT_DATA_DIR ? path.resolve(process.env.PERSISTENT_DATA_DIR) : path.join(projectRoot, "data"));
  if (process.env.PERSISTENT_DATA_DIR && !overrides.projectRoot) {
    fs.mkdirSync(dataRoot, { recursive: true });
    for (const directory of ["policy-packs", "templates", "benchmark-library", "discovery"]) {
      const target = path.join(dataRoot, directory);
      // Initialize only once; never overwrite rules created on the persistent disk.
      if (!fs.existsSync(target)) fs.cpSync(path.join(projectRoot, "data", directory), target, { recursive: true });
    }
  }
  const databasePath = overrides.databasePath
    ?? process.env.DATABASE_PATH
    ?? path.join(dataRoot, "runtime", "candidate-evaluation.sqlite");

  if (databasePath !== ":memory:") {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  return {
    projectRoot,
    dataRoot,
    databasePath,
    inputSchemaPath: overrides.inputSchemaPath ?? path.join(projectRoot, "schemas", "template-generator-input.schema.json"),
    templateSchemaPath: overrides.templateSchemaPath ?? path.join(projectRoot, "schemas", "evaluation-template.schema.json"),
    goldenSchemaPath: overrides.goldenSchemaPath ?? path.join(projectRoot, "schemas", "golden-evaluation.schema.json"),
    policyPackDirectory: overrides.policyPackDirectory ?? path.join(dataRoot, "policy-packs"),
    benchmarkLibraryRegistryPath: overrides.benchmarkLibraryRegistryPath
      ?? path.join(dataRoot, "benchmark-library", "registry.v1.json"),
    benchmarkLibraryDirectory: overrides.benchmarkLibraryDirectory
      ?? path.join(dataRoot, "benchmark-library"),
    benchmarkCollectorDirectory: overrides.benchmarkCollectorDirectory
      ?? path.join(dataRoot, "runtime", "benchmark-collector"),
    benchmarkCollectionTargetsPath: overrides.benchmarkCollectionTargetsPath
      ?? path.join(dataRoot, "benchmark-library", "collection-targets.v1.json"),
    trackDiscoveryCatalogPath: overrides.trackDiscoveryCatalogPath
      ?? path.join(dataRoot, "discovery", "track-discovery-catalog.v1.json"),
    benchmarkSourceCatalogPath: overrides.benchmarkSourceCatalogPath
      ?? path.join(projectRoot, "data", "benchmark-library", "ai-short-drama-sources.v1.json"),
    benchmarkSeedPath: overrides.benchmarkSeedPath
      ?? path.join(projectRoot, "data", "benchmark-library", "ai-short-drama-samples.seed.v1.json"),
    benchmarkMethodologyPath: overrides.benchmarkMethodologyPath
      ?? path.join(projectRoot, "data", "benchmark-library", "ai-short-drama-benchmark-methodology.v1.json"),
    publicIndexPath: overrides.publicIndexPath ?? path.join(projectRoot, "public", "index.html")
  };
}
