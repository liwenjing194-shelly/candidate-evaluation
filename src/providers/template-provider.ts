import type { EvaluationTemplate, TemplateGeneratorInput } from "../domain/types.js";

export interface TemplateProvider {
  generate(input: TemplateGeneratorInput): Promise<EvaluationTemplate>;
}
