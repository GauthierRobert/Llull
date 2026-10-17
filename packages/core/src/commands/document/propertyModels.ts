/** define_property_model / remove_property_model (PHY-01): property laws with units, ranges and provenance on a document material. */

import { canonicalJson } from '../../lib/canonicalJson';
import { sha256Hex } from '../../lib/sha256';
import { preferenceKey, type FitRecord, type PropertyForm, type PropertyModel, type Provenance } from '../../model/propertyModel';
import { materialModelsReading } from '../../model/materialLaws/references';
import { modelProblem } from '../../model/propertyModelValidate';
import type { CadDocument, Material } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, commandError, rejection } from '../noop';
import { editableMaterial } from './libraryReadonly';
import { fitRecordSchema, formSchema, modelInputSchema, withoutUndefined } from './propertyModelSchema';

const REMEDIATION: Readonly<Record<string, string>> = {
  MAT_RECORD_NOT_FOUND: 'create the material first with create_material (its name is the material id)',
  PROP_FORM_INVALID: 'follow the form definition in `llull describe define_property_model`',
  PROP_TABLE_NOT_MONOTONIC: 'sort / fix the table, or choose a linear mode',
  PROP_RANGE_INVALID: 'give data ⊆ equation ranges for every variable',
  PROP_MODEL_EXISTS: 'pass replace: true or a new id',
  PROP_MODEL_NOT_FOUND: 'list the material models (describe_scene / evaluate_property candidates)',
  PROP_MODEL_IN_USE: 'remove or re-base the dependent ratioOf models first',
  PROP_PROPERTY_UNKNOWN: 'use a catalogue property (k, cp, E, G, nu, density, cte, thermalStrain, Ftu, Fty, …)',
  MAT_UNIT_DIMENSION: 'use a unit of the property / variable dimension',
  MAT_UNIT_INVALID: "write units like 'W/(m*K)', 'J/(kg*K)', 'GPa', 'K', 'degC', '1e-5'",
  MAT_PROVENANCE_MISSING: 'give source.citation (and locator / url / accessed)',
  MAT_PREFERRED_CONFLICT: 'drop preferred on one of them (remove_property_model or replace)',
};

export const refuseWith = (
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  ids: readonly string[] = [],
  path?: string,
): CommandResult =>
  rejection(
    doc,
    `${command}: ${code} — ${message}; no-op.`,
    commandError(code, REMEDIATION[code] ?? 'see the command description', ids, path !== undefined ? [path] : []),
  );

/** `coefficientsSha256` = sha256 of the canonical JSON of the form (TR-PROP-09). */
export const formHash = (form: PropertyForm): string => sha256Hex(canonicalJson(form));

const withModels = (doc: CadDocument, name: string, material: Material, models: readonly PropertyModel[]): CadDocument => ({
  ...doc,
  materials: { ...doc.materials, [name]: { ...material, propertyModels: models } },
});

const conditionSchema = z.strictObject({
  temper: z.string().optional(),
  productForm: z.string().optional(),
  rrr: z.number().optional(),
  environment: z.string().optional(),
  note: z.string().optional(),
});

const firstIssuePath = (error: z.ZodError, prefix: string): string => {
  const path = error.issues[0]?.path ?? [];
  return [prefix, ...path.map(String)].join('.');
};

/**
 * @affects CadDocument.materials[material].propertyModels (adds or, with replace, replaces one model)
 * @invariant coefficientsSha256 recomputed from the form, never taken from params; one preferred model per (property, direction, basis,
 *   condition); a validity range for every variable; reviewedBy is never set here
 * @failure unknown material -> MAT_RECORD_NOT_FOUND; library record -> MAT_RECORD_READONLY; malformed form -> PROP_FORM_INVALID; table not increasing -> PROP_TABLE_NOT_MONOTONIC;
 *   wrong unit dimension -> MAT_UNIT_DIMENSION; duplicate id without replace -> PROP_MODEL_EXISTS; second preferred -> MAT_PREFERRED_CONFLICT
 *   (all rejections, document unchanged)
 */
export const definePropertyModel = defineCommand({
  name: 'define_property_model',
  description:
    'Attach a property model to a material (create_material first): a law such as thermal conductivity k(T), specific heat cp(T), ' +
    "Young's modulus E(T), thermal strain or a strain-rate factor, with the unit of its output, every variable with its unit, a REQUIRED " +
    'valid range per variable (data range of the measurements and the wider equation range the source allows), a basis and the source ' +
    'citation. Forms: constant, table1d, table2d, polynomial, log10Polynomial (NIST), nistRational (NIST copper), arrhenius, powerLaw, ' +
    'piecewise, product, rateFactor (Johnson-Cook / Cowper-Symonds), ratioOf (e.g. % of room temperature). The coefficient hash is ' +
    'recomputed; llull never extrapolates outside the range. Next: evaluate_property / sample_property, then check_property_models.',
  params: z.object({
    material: z.string().describe('Material id: the name given to create_material.'),
    model: modelInputSchema.describe('The property model.'),
    replace: z.boolean().optional().describe('Replace an existing model with the same id (default false: refused with PROP_MODEL_EXISTS).'),
  }),
  run: (doc, { material: materialId, model: input, replace }): CommandResult => {
    const name = 'define_property_model';
    const editable = editableMaterial(doc, name, materialId, refuseWith);
    if ('refusal' in editable) return editable.refusal;
    const { material } = editable;
    const form = formSchema.safeParse(input.form);
    if (!form.success)
      return refuseWith(
        doc,
        name,
        'PROP_FORM_INVALID',
        `the form does not match its kind (${form.error.issues[0]?.message ?? ''})`,
        [input.id],
        firstIssuePath(form.error, 'model.form'),
      );
    const condition = conditionSchema.safeParse(input.condition ?? {});
    if (!condition.success)
      return refuseWith(
        doc,
        name,
        'PROP_FORM_INVALID',
        'condition fields are temper, productForm, environment, note (text) and rrr (number)',
        [input.id],
        firstIssuePath(condition.error, 'model.condition'),
      );
    let fit: FitRecord | undefined;
    if (input.fit !== undefined) {
      const parsedFit = fitRecordSchema.safeParse(input.fit);
      if (!parsedFit.success)
        return refuseWith(
          doc,
          name,
          'PROP_FORM_INVALID',
          'model.fit is not a fit_property_model record',
          [input.id],
          firstIssuePath(parsedFit.error, 'model.fit'),
        );
      fit = withoutUndefined<FitRecord>(parsedFit.data);
    }
    const existing = material.propertyModels ?? [];
    const index = existing.findIndex((model) => model.id === input.id);
    if (index >= 0 && replace !== true)
      return refuseWith(doc, name, 'PROP_MODEL_EXISTS', `'${materialId}' already has a model '${input.id}'`, [input.id], 'model.id');
    const provenance = withoutUndefined<Provenance>(input.source);
    const model: PropertyModel = {
      id: input.id,
      property: input.property,
      unit: input.unit,
      variables: withoutUndefined<PropertyModel['variables']>(input.variables),
      form: form.data,
      validity: withoutUndefined<PropertyModel['validity']>(input.validity),
      basis: input.basis,
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.condition !== undefined ? { condition: withoutUndefined<NonNullable<PropertyModel['condition']>>(input.condition) } : {}),
      ...(input.uncertainty !== undefined
        ? { uncertainty: withoutUndefined<NonNullable<PropertyModel['uncertainty']>>(input.uncertainty) }
        : {}),
      provenance,
      coefficientsSha256: formHash(form.data),
      ...(fit !== undefined ? { fit } : {}),
      ...(input.preferred === true ? { preferred: true as const } : {}),
    };
    const others = existing.filter((m) => m.id !== input.id);
    const issue = modelProblem(model, new Set(others.map((m) => m.id)));
    if (issue !== null) return refuseWith(doc, name, issue.code, issue.message, [input.id], issue.path);
    const rival =
      model.preferred === true ? others.find((m) => m.preferred === true && preferenceKey(m) === preferenceKey(model)) : undefined;
    if (rival !== undefined)
      return refuseWith(
        doc,
        name,
        'MAT_PREFERRED_CONFLICT',
        `'${rival.id}' is already preferred for ${model.property}`,
        [rival.id, model.id],
        'model.preferred',
      );
    const models = index >= 0 ? existing.map((m) => (m.id === model.id ? model : m)) : [...existing, model];
    if (index >= 0) {
      const { broken } = materialModelsReading(materialId, model.id, material.materialModels ?? [], models);
      if (broken !== null)
        return refuseWith(
          doc,
          name,
          'PROP_MODEL_IN_USE',
          `material model '${broken.modelId}' reads '${model.id}' and would break (${broken.message})`,
          [broken.modelId],
          'model.id',
        );
    }
    return changed(
      withModels(doc, materialId, material, models),
      `define_property_model '${materialId}/${model.id}': ${model.property} [${model.unit}] as ${model.form.kind} over ${model.validity
        .map((r) => `${r.variable} ${(r.equation ?? r.data).join('…')} ${r.unit}`)
        .join(', ')} (basis ${model.basis}, sha256 ${model.coefficientsSha256.slice(0, 12)}…)${index >= 0 ? ', replaced' : ''}.`,
      [],
    );
  },
});

/**
 * @affects CadDocument.materials[material].propertyModels (removes one model)
 * @invariant other models untouched
 * @failure unknown material -> MAT_RECORD_NOT_FOUND; library record -> MAT_RECORD_READONLY; unknown id -> PROP_MODEL_NOT_FOUND; base of a ratioOf model -> PROP_MODEL_IN_USE
 */
export const removePropertyModel = defineCommand({
  name: 'remove_property_model',
  annotations: { destructive: true },
  description:
    'Remove one property model from a material. Refused while another model of the material is a ratioOf of it, or a material law reads it (PROP_MODEL_IN_USE).',
  params: z.object({
    material: z.string().describe('Material id (create_material name).'),
    modelId: z.string().describe('Id of the model to remove.'),
  }),
  run: (doc, { material: materialId, modelId }): CommandResult => {
    const name = 'remove_property_model';
    const editable = editableMaterial(doc, name, materialId, refuseWith);
    if ('refusal' in editable) return editable.refusal;
    const { material } = editable;
    const models = material.propertyModels ?? [];
    if (!models.some((m) => m.id === modelId))
      return refuseWith(doc, name, 'PROP_MODEL_NOT_FOUND', `'${materialId}' has no model '${modelId}'`, [modelId], 'modelId');
    const dependants = models.filter((m) => JSON.stringify(m.form).includes(`"baseModelId":${JSON.stringify(modelId)}`)).map((m) => m.id);
    if (dependants.length > 0)
      return refuseWith(doc, name, 'PROP_MODEL_IN_USE', `${dependants.join(', ')} build on '${modelId}'`, dependants, 'modelId');
    const { readers } = materialModelsReading(materialId, modelId, material.materialModels ?? [], models);
    if (readers.length > 0)
      return refuseWith(doc, name, 'PROP_MODEL_IN_USE', `material model(s) ${readers.join(', ')} read '${modelId}'`, readers, 'modelId');
    return changed(
      withModels(
        doc,
        materialId,
        material,
        models.filter((m) => m.id !== modelId),
      ),
      `remove_property_model '${materialId}/${modelId}': removed.`,
      [],
    );
  },
});
