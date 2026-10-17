/** Load-time validation of the PHY-02 data stored on a document material (shape, unique ids, parameter hash, catalogue rules, sets). */

import { isRecord } from '../../lib/isRecord';
import { lawIssues } from '../../model/materialLawCatalog';
import { validityIssue } from '../../model/materialLaws/validity';
import { combinationIssues } from '../../model/materialLaws/combination';
import { SET_SLOTS, type ConstitutiveSet, type MaterialModel } from '../../model/materialModel';
import { BASES, type PropertyModel } from '../../model/propertyModel';
import { z } from '../schema';
import { lawSchema, materialFitSchema, validRangeSchema } from './materialLawSchema';
import { lawHash } from './materialModels';

const storedModelSchema = z.looseObject({
  id: z.string().min(1),
  model: lawSchema,
  validity: z.array(validRangeSchema).optional(),
  basis: z.enum(BASES),
  provenance: z.looseObject({ citation: z.string().optional(), sourceId: z.string().optional() }),
  reviewedBy: z.never().optional(),
  parametersSha256: z.string(),
  fit: materialFitSchema.optional(),
  preferred: z.literal(true).optional(),
});

const storedSetSchema = z.looseObject({
  id: z.string().min(1),
  ...Object.fromEntries(SET_SLOTS.map((slot) => [slot, z.string().optional()])),
});

/** First problem of a material's `materialModels`, `constitutiveSets` and `defaultConstitutiveSet`, or null. */
export function storedMaterialModelsProblem(
  materialName: string,
  models: unknown,
  sets: unknown,
  defaultSet: unknown,
  propertyModels: unknown,
): string | null {
  const where = `material '${materialName}'`;
  if (models !== undefined && !Array.isArray(models)) return `${where}: materialModels must be an array`;
  if (sets !== undefined && !Array.isArray(sets)) return `${where}: constitutiveSets must be an array`;
  const parsedModels: MaterialModel[] = [];
  const ids = new Set<string>();
  const record = {
    name: materialName,
    ...(Array.isArray(propertyModels) ? { propertyModels: propertyModels.filter(isRecord) as unknown as PropertyModel[] } : {}),
  };
  for (const [i, raw] of ((models as unknown[] | undefined) ?? []).entries()) {
    const parsed = storedModelSchema.safeParse(raw);
    if (!parsed.success)
      return `${where}: materialModels[${i}] ${parsed.error.issues[0]?.path.join('.') ?? ''}: ${parsed.error.issues[0]?.message ?? ''}`;
    const model = parsed.data as unknown as MaterialModel;
    if (ids.has(model.id)) return `${where}: duplicate material model id '${model.id}'`;
    ids.add(model.id);
    if ((model.provenance.citation ?? '').trim() === '' && (model.provenance.sourceId ?? '') === '')
      return `${where}: model '${model.id}' MAT_PROVENANCE_MISSING at provenance.citation: give a citation or sourceId`;
    const rival =
      model.preferred === true
        ? parsedModels.find((other) => other.preferred === true && other.model.kind === model.model.kind)
        : undefined;
    if (rival !== undefined)
      return `${where}: MAT_PREFERRED_CONFLICT: '${rival.id}' and '${model.id}' are both the preferred ${model.model.kind}`;
    if (lawHash(model.model) !== model.parametersSha256) return `${where}: model '${model.id}' parametersSha256 does not match its law`;
    const rangeIssue = model.validity === undefined ? null : validityIssue(model.validity);
    if (rangeIssue !== null) return `${where}: model '${model.id}' ${rangeIssue.code} at ${rangeIssue.path}: ${rangeIssue.message}`;
    const issue = lawIssues(model.model, { record, ...(model.validity !== undefined ? { validity: model.validity } : {}) }).find(
      (candidate) => candidate.severity === 'error',
    );
    if (issue !== undefined) return `${where}: model '${model.id}' ${issue.code} at ${issue.path}: ${issue.message}`;
    parsedModels.push(model);
  }
  const setIds = new Set<string>();
  for (const [i, raw] of ((sets as unknown[] | undefined) ?? []).entries()) {
    const parsed = storedSetSchema.safeParse(raw);
    if (!parsed.success)
      return `${where}: constitutiveSets[${i}] ${parsed.error.issues[0]?.path.join('.') ?? ''}: ${parsed.error.issues[0]?.message ?? ''}`;
    const set = parsed.data as unknown as ConstitutiveSet;
    if (setIds.has(set.id)) return `${where}: duplicate constitutive set id '${set.id}'`;
    setIds.add(set.id);
    const problem = combinationIssues(set, parsedModels)[0];
    if (problem !== undefined) return `${where}: constitutive set '${set.id}' ${problem.code} at ${problem.path}: ${problem.message}`;
  }
  if (defaultSet !== undefined && (typeof defaultSet !== 'string' || !setIds.has(defaultSet)))
    return `${where}: defaultConstitutiveSet must name an existing constitutive set`;
  return null;
}
