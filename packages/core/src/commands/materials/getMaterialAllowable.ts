/** get_material_allowable (08 MAT M2/M8, VC-MAT-05 / 16 / 23): a value for the exact key, with basis, provenance and the review flags. */

import { BASES, PROPERTY_DIRECTIONS, type PropertyModel } from '../../model/propertyModel';
import { evaluatePropertyModel, isRefused, type PropertyRecord } from '../../model/propertyModelEval';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { candidateOf, modelsForKey } from './allowableLookup';
import { refuseMaterial } from './refusal';

const COMMAND = 'get_material_allowable';

const quantity = (what: string): z.ZodObject<{ value: z.ZodNumber; unit: z.ZodString }> =>
  z.object({
    value: z.number().describe(`${what}: value.`),
    unit: z.string().describe(`${what}: unit, e.g. 'in', 'mm', 'degF', 'degC', 'K'.`),
  });

/**
 * @affects nothing — read-only; data { available, value, unit, basis, provenance, unverified, unverifiedReasons, reviewRequired: true, … }
 * @invariant never returns a value of another basis, direction, thickness, e/D or temperature mode than asked; never extrapolates a temperature
 *   table; reviewRequired is always true
 * @failure no value for the key MAT_ALLOWABLE_NOT_AVAILABLE (data.candidates); several preferred-less MAT_ALLOWABLE_AMBIGUOUS; temperature outside
 *   the table MAT_TEMPERATURE_OUT_OF_RANGE; forCertification on a superseded source MAT_SOURCE_SUPERSEDED, on an unverified value
 *   MAT_VALUE_UNVERIFIED; unresolved private record MAT_LIBRARY_UNRESOLVED (all rejections with data.available = false)
 */
export const getMaterialAllowable = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true },
  description:
    'Read one design value of a material for the EXACT key (property, basis, direction, thickness, e/D, temperature): e.g. Ftu, basis A, L, ' +
    '0.050 in. A basis is never substituted: when none matches, data.available is false and data.candidates lists the values that exist ' +
    '(MAT_ALLOWABLE_NOT_AVAILABLE). Without temperature the room-temperature value is returned; with temperature the temperature table is ' +
    'interpolated linearly and refused outside its range (MAT_TEMPERATURE_OUT_OF_RANGE, no extrapolation). Every value carries basis, ' +
    'provenance, unverified / unverifiedReasons and reviewRequired: true: an engineer must review it. forCertification: true refuses ' +
    'superseded sources (MAT_SOURCE_SUPERSEDED) and typical / supplier_unstated / unspecified values (MAT_VALUE_UNVERIFIED). Add values with set_material_property.',
  params: z.object({
    material: z.string().describe('Material id (record).'),
    property: z.string().describe('Property: Ftu, Fty, Fcy, Fsu, Fbru, Fbry, E, Ec, G, nu, density, elongation, cte, k, cp.'),
    basis: z.enum(BASES).describe('Required basis: A, B, S, typical, supplier_unstated, company, unspecified. Never substituted.'),
    direction: z
      .enum([...PROPERTY_DIRECTIONS, 'isotropic'])
      .optional()
      .describe('Direction of the value (L, LT, ST, …); omit or isotropic for a direction-free value.'),
    thickness: quantity('Product thickness')
      .optional()
      .describe('Thickness the value must cover; needed for a value tabulated per thickness range.'),
    temperature: quantity('Temperature')
      .optional()
      .describe('Temperature for a temperature-dependent value; omit for the room-temperature value.'),
    edOverD: z.number().optional().describe('Bearing edge-distance ratio e/D (1.5 or 2.0) for Fbru / Fbry.'),
    unit: z.string().optional().describe("Unit of the answer (default: the stored unit), e.g. 'MPa'."),
    forCertification: z.boolean().optional().describe('Refuse superseded sources and unverified values (default false).'),
  }),
  run: (doc, params): CommandResult => {
    const { material: name, forCertification, unit } = params;
    const material = Object.hasOwn(doc.materials, name) ? doc.materials[name] : undefined;
    const key = `${params.property} basis ${params.basis}${params.direction !== undefined ? ` ${params.direction}` : ''}`;
    const refuse = (code: string, message: string, extra: Record<string, unknown> = {}, path?: string): CommandResult =>
      refuseMaterial(doc, COMMAND, code, message, {
        ids: [name],
        ...(path !== undefined ? { path } : {}),
        data: { available: false, code, reason: message, material: name, key, reviewRequired: true, ...extra },
      });
    if (material === undefined) return refuse('MAT_RECORD_NOT_FOUND', `no material '${name}'`, {}, 'material');
    if (material.record?.unresolved !== undefined)
      return refuse('MAT_LIBRARY_UNRESOLVED', `'${name}' has no values on this machine (${material.record.unresolved.reason})`);
    const models = material.propertyModels ?? [];
    const matches = modelsForKey(models, params);
    const candidates = models.filter((model) => model.property === params.property).map(candidateOf);
    const preferred = matches.filter((model) => model.preferred === true);
    const chosen: PropertyModel | undefined = matches.length === 1 ? matches[0] : preferred.length === 1 ? preferred[0] : undefined;
    if (chosen === undefined)
      return matches.length === 0
        ? refuse('MAT_ALLOWABLE_NOT_AVAILABLE', `'${name}' has no ${key} value for this thickness / e/D / temperature`, { candidates })
        : refuse('MAT_ALLOWABLE_AMBIGUOUS', `${matches.length} values of ${key} match and none is preferred`, {
            candidates: matches.map(candidateOf),
          });
    const superseded = material.record?.superseded;
    if (superseded !== undefined && forCertification === true)
      return refuse('MAT_SOURCE_SUPERSEDED', `'${name}' comes from a superseded source (${superseded.note}; use ${superseded.by})`, {
        superseded,
      });
    const record: PropertyRecord = { name, propertyModels: models };
    const evaluated = evaluatePropertyModel(record, chosen, params.temperature !== undefined ? { T: params.temperature } : {}, {
      forCertification: forCertification === true,
      ...(unit !== undefined ? { outputUnit: unit } : {}),
    });
    if (isRefused(evaluated)) {
      const outOfRange = evaluated.code === 'PROP_OUT_OF_RANGE' && evaluated.path === 'at.T';
      return refuse(
        outOfRange ? 'MAT_TEMPERATURE_OUT_OF_RANGE' : evaluated.code,
        evaluated.reason,
        { modelId: chosen.id, ...(evaluated.validity !== undefined ? { validity: evaluated.validity } : {}) },
        evaluated.path,
      );
    }
    const base =
      chosen.form.kind === 'ratioOf'
        ? models.find((model) => model.id === (chosen.form as { baseModelId: string }).baseModelId)
        : undefined;
    const warnings = [
      ...evaluated.warnings,
      ...(superseded !== undefined
        ? [{ code: 'MAT_SOURCE_SUPERSEDED', message: `superseded source: ${superseded.note}; use ${superseded.by} for certification` }]
        : []),
      ...(evaluated.unverified ? [{ code: 'MAT_VALUE_UNVERIFIED', message: `unverified: ${evaluated.unverifiedReasons.join(', ')}` }] : []),
    ];
    return report(
      doc,
      `get_material_allowable '${name}' ${key}: ${evaluated.value} ${evaluated.unit} (${chosen.id}; ${evaluated.unverified ? `UNVERIFIED — ${evaluated.unverifiedReasons.join(', ')}` : 'verified basis'}); review required.`,
      {
        available: true,
        material: name,
        property: params.property,
        value: evaluated.value,
        unit: evaluated.unit,
        basis: evaluated.basis,
        ...(chosen.direction !== undefined ? { direction: chosen.direction } : {}),
        ...(chosen.condition !== undefined ? { condition: chosen.condition } : {}),
        modelId: chosen.id,
        provenance: evaluated.provenance,
        ...(base !== undefined ? { baseProvenance: base.provenance, baseModelId: base.id } : {}),
        at: evaluated.at,
        rangeStatus: evaluated.rangeStatus,
        unverified: evaluated.unverified,
        unverifiedReasons: evaluated.unverifiedReasons,
        reviewRequired: true,
        warnings,
        ...(superseded !== undefined ? { superseded } : {}),
      },
    );
  },
});
