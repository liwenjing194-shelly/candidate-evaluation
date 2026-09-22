import path from "node:path";
import ExcelJS from "exceljs";
import type { JsonValue } from "../domain/types.js";
import { ServiceError } from "./template-service.js";

export interface ParsedEvidenceItem {
  evidenceKey: string;
  label: string;
  value: JsonValue;
  normalizedText: string;
  sourceLocator: string | null;
  observedAt: string | null;
  qualityScore: number;
}

export interface ParsedEvidenceFile {
  evidence: ParsedEvidenceItem[];
  metadata: { [key: string]: JsonValue };
}

const MAX_EVIDENCE_ITEMS = 5_000;

export async function parseEvidenceFile(fileName: string, buffer: Buffer): Promise<ParsedEvidenceFile> {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".xlsx") return parseWorkbook(buffer);
  if (extension === ".csv") return parseCsv(buffer);
  if (extension === ".json") return parseJson(buffer);
  if ([".md", ".markdown", ".txt"].includes(extension)) return parseText(buffer, extension);
  throw new ServiceError("仅支持XLSX、CSV、JSON、Markdown和TXT文件", 400);
}

async function parseWorkbook(buffer: Buffer): Promise<ParsedEvidenceFile> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw new ServiceError("表格文件无法解析，请检查文件是否损坏", 400);
  }
  const evidence: ParsedEvidenceItem[] = [];
  workbook.eachSheet((sheet) => {
    const headers: string[] = [];
    sheet.getRow(1).eachCell({ includeEmpty: true }, (cell, column) => {
      headers[column] = cellText(cell.value) || `column_${column}`;
    });
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const record: Record<string, unknown> = {};
      headers.forEach((header, column) => {
        if (!header || column === 0) return;
        record[header] = cellText(row.getCell(column).value);
      });
      evidence.push(...parseTableRow(record, `${sheet.name}!${rowNumber}`));
    });
  });
  return finalize(evidence, { format: "xlsx", sheet_count: workbook.worksheets.length });
}

function parseCsv(buffer: Buffer): ParsedEvidenceFile {
  const rows = parseCsvRows(buffer.toString("utf8"));
  const headers = rows.shift() ?? [];
  const evidence = rows.flatMap((values, index) => {
    const record: Record<string, unknown> = {};
    headers.forEach((header, column) => { record[header || `column_${column + 1}`] = values[column] ?? ""; });
    return parseTableRow(record, `CSV第${index + 2}行`);
  });
  return finalize(evidence, { format: "csv", row_count: rows.length });
}

function parseTableRow(row: Record<string, unknown>, locator: string): ParsedEvidenceItem[] {
  const normalizedKeys = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key.trim().toLowerCase(), value])
  );
  const explicitKey = stringValue(normalizedKeys.evidence_key ?? normalizedKeys["证据字段"]);
  if (explicitKey) {
    const label = stringValue(normalizedKeys.label ?? normalizedKeys["证据名称"]) || explicitKey;
    const value = toJsonValue(normalizedKeys.value ?? normalizedKeys["值"] ?? "");
    return [makeEvidence({
      key: explicitKey,
      label,
      value,
      locator: stringValue(normalizedKeys.source_locator ?? normalizedKeys["来源位置"]) || locator,
      observedAt: stringValue(normalizedKeys.observed_at ?? normalizedKeys["观察时间"]) || null,
      qualityScore: numberValue(normalizedKeys.quality_score ?? normalizedKeys["质量分"]) ?? 0.8
    })];
  }
  return Object.entries(row)
    .filter(([, value]) => value !== "" && value !== null && value !== undefined)
    .map(([label, value]) => makeEvidence({
      key: slugKey(label),
      label,
      value: toJsonValue(value),
      locator,
      observedAt: null,
      qualityScore: 0.7
    }));
}

function parseJson(buffer: Buffer): ParsedEvidenceFile {
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new ServiceError("JSON文件格式无效", 400);
  }
  const evidence: ParsedEvidenceItem[] = [];
  flattenJson(value, "document", "$", evidence);
  return finalize(evidence, { format: "json" });
}

function flattenJson(value: unknown, key: string, locator: string, output: ParsedEvidenceItem[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenJson(item, `${key}.${index}`, `${locator}[${index}]`, output));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>)
      .forEach(([childKey, child]) => flattenJson(child, `${key}.${childKey}`, `${locator}.${childKey}`, output));
    return;
  }
  if (value === undefined) return;
  output.push(makeEvidence({
    key: key.replace(/^document\./, ""),
    label: key.split(".").at(-1) ?? key,
    value: toJsonValue(value),
    locator,
    observedAt: null,
    qualityScore: 0.75
  }));
}

function parseText(buffer: Buffer, extension: string): ParsedEvidenceFile {
  const lines = buffer.toString("utf8").split(/\r?\n/);
  const evidence: ParsedEvidenceItem[] = [];
  let heading = "文档内容";
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      heading = headingMatch[1]!.trim();
      return;
    }
    evidence.push(makeEvidence({
      key: `document.line.${index + 1}`,
      label: heading,
      value: line.replace(/^[-*+]\s+/, ""),
      locator: `第${index + 1}行`,
      observedAt: null,
      qualityScore: 0.6
    }));
  });
  return finalize(evidence, { format: extension.slice(1), line_count: lines.length });
}

function makeEvidence(input: {
  key: string;
  label: string;
  value: JsonValue;
  locator: string | null;
  observedAt: string | null;
  qualityScore: number;
}): ParsedEvidenceItem {
  return {
    evidenceKey: input.key.trim().slice(0, 240),
    label: input.label.trim().slice(0, 240),
    value: input.value,
    normalizedText: normalizeText(`${input.key} ${input.label} ${stringifyValue(input.value)}`),
    sourceLocator: input.locator,
    observedAt: input.observedAt,
    qualityScore: Math.max(0, Math.min(1, input.qualityScore))
  };
}

function finalize(evidence: ParsedEvidenceItem[], metadata: { [key: string]: JsonValue }): ParsedEvidenceFile {
  const usable = evidence.filter((item) => item.normalizedText.length > 0).slice(0, MAX_EVIDENCE_ITEMS);
  if (usable.length === 0) throw new ServiceError("文件中没有可导入的数据", 400);
  return { evidence: usable, metadata: { ...metadata, truncated: evidence.length > MAX_EVIDENCE_ITEMS } };
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function slugKey(value: string): string {
  const result = value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "");
  return result || "field";
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function stringifyValue(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

function numberValue(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("result" in value && value.result !== undefined) return String(value.result);
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return String(value.text);
  }
  return String(value);
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (character === '"') {
      if (quoted && text[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field); field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((item) => item.length > 0)) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some((item) => item.length > 0)) rows.push(row);
  return rows;
}
