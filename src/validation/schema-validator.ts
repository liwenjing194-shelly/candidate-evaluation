import { createRequire } from "node:module";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import type { ValidationIssue } from "../domain/types.js";
import { readJsonFile } from "../lib/json.js";

export class SchemaValidator {
  private readonly inputValidator: ValidateFunction;
  private readonly templateValidator: ValidateFunction;
  private readonly goldenValidator: ValidateFunction;

  constructor(inputSchemaPath: string, templateSchemaPath: string, goldenSchemaPath: string) {
    const require = createRequire(import.meta.url);
    const addFormats = require("ajv-formats") as FormatsPlugin;
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    this.inputValidator = ajv.compile(readJsonFile(inputSchemaPath));
    this.templateValidator = ajv.compile(readJsonFile(templateSchemaPath));
    this.goldenValidator = ajv.compile(readJsonFile(goldenSchemaPath));
  }

  validateInput(value: unknown): ValidationIssue[] {
    return this.run(this.inputValidator, value);
  }

  validateTemplate(value: unknown): ValidationIssue[] {
    return this.run(this.templateValidator, value);
  }

  validateGolden(value: unknown): ValidationIssue[] {
    return this.run(this.goldenValidator, value);
  }

  private run(validator: ValidateFunction, value: unknown): ValidationIssue[] {
    return validator(value) ? [] : (validator.errors ?? []).map(formatAjvError);
  }
}

function formatAjvError(error: ErrorObject): ValidationIssue {
  const missingProperty = error.keyword === "required"
    ? String((error.params as { missingProperty?: unknown }).missingProperty ?? "")
    : "";
  const path = `${error.instancePath || "/"}${missingProperty ? `/${missingProperty}` : ""}`;
  return {
    path,
    message: error.message ?? "结构不符合Schema",
    keyword: error.keyword
  };
}
