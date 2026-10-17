/** set_material_property (08 MAT M2/M8): a sourced property value of a material record, stored as a PHY-01 property model. */

import { BASES, PROPERTY_DIRECTIONS, type PropertyModel } from '../../model/propertyModel';
import { modelProblem } from '../../model/propertyModelValidate';
import type { CadDocument } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed } from '../noop';
import { withMirroredDensity } from './libraryRecords';
import { inputProblem, modelIdFor, modelOf, rivalsOf, roomTemperatureBase, conditionOf, type PropertyInput } from './propertyInput';
import { refuseMaterial } from './refusal';

const COMMAND = 'set_material_property';

const temperatureSchema = z.object({
  mode: z
    .enum(['absolute', 'percentOfRT'])
    .describe(
      'absolute: points are [temperature, value] in `unit`; percentOfRT: points are [temperature, percent of the room-temperature value].',
    ),
  temperatureUnit: z.enum(['degF', 'degC', 'K']).describe('Unit of the temperature column of points.'),
  points: z
    .array(z.tuple([z.number(), z.number()]))
    .describe(
      '[[temperature, value or percent], …], at least 2, temperatures strictly increasing. Evaluation is linear and never extrapolates.',
    ),
  exposureHours: z
    .number()
    .positive()
    .optional()
    .describe('Exposure time at temperature in hours (MIL-HDBK-5 exposure curves); part of the value key.'),
  rtModelId: z
    .string()
    .optional()
    .describe(
      'percentOfRT only: id of the room-temperature model the percentages scale. Default: the only constant model with the same property, basis, direction, thickness and e/D.',
    ),
});

const sourceSchema = z.object({
  citation: z.string().describe('Bibliographic citation of the value, e.g. "MIL-HDBK-5J". Required; blank is MAT_PROVENANCE_MISSING.'),
  locator: z.string().optional().describe('Table / figure / page, e.g. "Table 3.2.3.0(b1)".'),
  url: z.string().optional().describe('Where the value was read.'),
  accessed: z.string().optional().describe('Access date, YYYY-MM-DD.'),
});

/**
 * @affects CadDocument.materials[material].propertyModels (adds or, with replace, replaces one model); legacy density mirrors the resolved density
 * @invariant one preferred model per (property, direction, basis, condition, room-temperature | temperature law); the coefficient hash is recomputed
 * @failure unknown material MAT_RECORD_NOT_FOUND; library record MAT_RECORD_READONLY; unit MAT_UNIT_INVALID / MAT_UNIT_DIMENSION; strength without
 *   basis MAT_BASIS_MISSING; no source MAT_PROVENANCE_MISSING; second preferred MAT_PREFERRED_CONFLICT; duplicate id PROP_MODEL_EXISTS
 *   (all rejections, document unchanged)
 */
export const setMaterialProperty = defineCommand({
  name: COMMAND,
  description:
    'Add a sourced property value to a material: density, E, Ec, G, nu, Ftu, Fty, Fcy, Fsu, Fbru, Fbry, elongation, cte, k, cp. Give value + unit ' +
    '(any unit of the right dimension: g/cm^3, lb/in^3, ksi, MPa, Msi, GPa), the basis (A, B, S, typical, supplier_unstated, company, unspecified; ' +
    'REQUIRED for strengths) and the source (citation + locator, REQUIRED). Optional keys: direction (L, LT, ST, isotropic …), thickness range, ' +
    'e/D for bearing, and a temperature table (absolute values or percent of the room-temperature value). Several values may coexist (two supplier ' +
    'densities); mark at most one preferred per key. Values of typical / supplier_unstated / unspecified basis are flagged unverified downstream. ' +
    'Stored as a PHY-01 property model, so evaluate_property and get_material_allowable read it. Records imported from a library are read-only. ' +
    'Next: get_material_allowable, mass_properties, check_materials.',
  params: z.object({
    material: z.string().describe('Material id (the name given to create_material or the id of define_material_record).'),
    property: z.string().describe('Property: density, E, Ec, G, nu, Ftu, Fty, Fcy, Fsu, Fbru, Fbry, elongation, cte, k, cp.'),
    value: z.number().optional().describe('The value in `unit` (room temperature). Omit when a temperature table is given.'),
    unit: z.string().describe("Unit of the value, e.g. 'g/cm^3', 'lb/in^3', 'ksi', 'MPa', 'GPa', '1' (dimensionless), '%'."),
    basis: z
      .enum(BASES)
      .optional()
      .describe(
        'A | B | S | typical | supplier_unstated | company | unspecified. Required for strengths; default unspecified (unverified).',
      ),
    direction: z
      .enum([...PROPERTY_DIRECTIONS, 'isotropic'])
      .optional()
      .describe('Grain / material direction: L, LT, ST, 1, 2, 3, normal, warp, fill, or isotropic (same as omitted).'),
    thickness: z
      .object({
        min: z.number().describe('Smallest product thickness the value applies to.'),
        max: z.number().describe('Largest product thickness the value applies to.'),
        unit: z.string().describe("Length unit, e.g. 'in' or 'mm'."),
      })
      .optional()
      .describe('Product thickness range of the value (allowables are tabulated per thickness range).'),
    edOverD: z.number().optional().describe('Bearing edge-distance ratio e/D (1.5 or 2.0) of an Fbru / Fbry value.'),
    temperature: temperatureSchema
      .optional()
      .describe('Temperature dependence; the room-temperature value is a separate call without temperature.'),
    source: sourceSchema.optional().describe('Provenance of the value. REQUIRED.'),
    preferred: z
      .literal(true)
      .optional()
      .describe('Mark as THE value for its key (at most one preferred per property, direction, basis, thickness, e/D).'),
    id: z.string().optional().describe('Id of the value on the material (default derived from the key, e.g. "Ftu.L.A.t0p02-0p128").'),
    replace: z.boolean().optional().describe('Replace an existing value with the same id (default false: PROP_MODEL_EXISTS).'),
  }),
  run: (doc, params): CommandResult => {
    const { material: name, replace, ...input } = params;
    const material = Object.hasOwn(doc.materials, name) ? doc.materials[name] : undefined;
    if (material === undefined)
      return refuseMaterial(doc, COMMAND, 'MAT_RECORD_NOT_FOUND', `no material '${name}'`, { ids: [name], path: 'material' });
    if (material.record?.libraryRef !== undefined)
      return refuseMaterial(doc, COMMAND, 'MAT_RECORD_READONLY', `'${name}' comes from library '${material.record.libraryRef.libraryId}'`, {
        ids: [name],
        path: 'material',
      });
    const request: PropertyInput = input;
    const invalid = inputProblem(request);
    if (invalid !== null) return refuseMaterial(doc, COMMAND, invalid.code, invalid.message, { ids: [name], path: invalid.path });
    const existing = material.propertyModels ?? [];
    const id = modelIdFor(
      request,
      new Set(replace === true ? existing.filter((m) => m.id !== input.id).map((m) => m.id) : existing.map((m) => m.id)),
    );
    if (replace !== true && existing.some((m) => m.id === id))
      return refuseMaterial(doc, COMMAND, 'PROP_MODEL_EXISTS', `'${name}' already has a value '${id}'`, { ids: [id], path: 'id' });
    const others = existing.filter((m) => m.id !== id);
    let base: PropertyModel | undefined;
    if (request.temperature?.mode === 'percentOfRT') {
      const found = roomTemperatureBase(others, request, conditionOf(request));
      if ('code' in found) return refuseMaterial(doc, COMMAND, found.code, found.message, { ids: [name], path: found.path });
      base = found;
    }
    const built = modelOf(request, id, base);
    if ('code' in built) return refuseMaterial(doc, COMMAND, built.code, built.message, { ids: [name], path: built.path });
    const issue = modelProblem(built, new Set(others.map((m) => m.id)));
    if (issue !== null)
      return refuseMaterial(doc, COMMAND, issue.code, issue.message, { ids: [id], path: issue.path.replace(/^model\./, '') });
    const rival = built.preferred === true ? rivalsOf(others, built)[0] : undefined;
    if (rival !== undefined)
      return refuseMaterial(doc, COMMAND, 'MAT_PREFERRED_CONFLICT', `'${rival.id}' is already preferred for ${built.property}`, {
        ids: [rival.id, built.id],
        path: 'preferred',
      });
    const models =
      replace === true && existing.some((m) => m.id === id) ? existing.map((m) => (m.id === id ? built : m)) : [...existing, built];
    const updated = withMirroredDensity(doc, name, { ...material, propertyModels: models });
    const next: CadDocument = { ...doc, materials: { ...doc.materials, [name]: updated } };
    const shown = built.form.kind === 'constant' ? `${built.form.value} ${built.unit}` : `${built.form.kind} [${built.unit}]`;
    return changed(
      next,
      `set_material_property '${name}/${built.id}': ${built.property} = ${shown} (basis ${built.basis}${built.preferred === true ? ', preferred' : ''}, source ${built.provenance.citation ?? built.provenance.sourceId ?? ''}).`,
      [],
    );
  },
});
