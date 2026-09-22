import fs from "node:fs";
import type { JsonObject, JsonValue } from "../domain/types.js";

export function readJsonFile<T extends JsonValue = JsonObject>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
