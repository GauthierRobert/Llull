/** get_material (08 MAT M2): the record, its values with basis / provenance, the resolved density and the markings. */

import { resolveDensity } from '../../geometry/resolveDensity';
import type { PropertyModel } from '../../model/propertyModel';
import { modelUnverifiedReasons } from '../../model/propertyModelEval';
import type { CadDocument, Material } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import { markingText } from './marking';
import { dependsOnTemperature } from './propertyKey';
import { refuseMaterial } from './refusal';

/** One value of a material as an agent reads it. */
export function valueView(model: PropertyModel): Record<string, unknown> {
  const reasons = modelUnverifiedReasons(model);
  return {
    id: model.id,
    property: model.property,
    unit: model.unit,
    form: model.form.kind,
    ...(model.form.kind === 'constant' ? { value: model.form.value } : {}),
    ...(model.direction !== undefined ? { direction: model.direction } : {}),
    basis: model.basis,
    ...(model.condition !== undefined ? { condition: model.condition } : {}),
    temperatureDependent: dependsOnTemperature(model),
    preferred: model.preferred === true,
    provenance: model.provenance,
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
  };
}

function densityView(doc: CadDocument, name: string, material: Material): Record<string, unknown> {
  const resolved = resolveDensity(doc, name);
  if (resolved === null) return { available: false };
  if (!resolved.available) return { available: false, code: resolved.code, reason: resolved.reason, remediation: resolved.remediation };
  const legacy = resolved.modelId === undefined;
  return {
    available: true,
    kgPerM3: resolved.kgPerM3,
    gPerDocUnit3: resolved.gPerDocUnit3,
    source: resolved.source,
    basis: legacy ? 'unspecified' : (resolved.basis ?? 'unspecified'),
    provenance: legacy ? 'legacy' : (material.propertyModels?.find((model) => model.id === resolved.modelId)?.provenance ?? null),
    unverified: resolved.unverified,
    unverifiedReasons: resolved.unverifiedReasons,
  };
}

/**
 * @affects nothing — read-only; data { material, legacy, record?, marking?, density, values[] }
 * @invariant a legacy material (no record) reports basis unspecified and provenance legacy; every value carries basis, provenance and unverified
 * @failure unknown material -> MAT_RECORD_NOT_FOUND rejection
 */
export const getMaterial = defineCommand({
  name: 'get_material',
  annotations: { readOnly: true },
  description:
    'Read a material: its record (designation, temper, form, specs, licence, export marking, superseded, library origin), every stored value ' +
    '(density, moduli, allowables) with unit, basis, direction, thickness / e/D / temperature condition, provenance and whether it is unverified, ' +
    'which value is preferred, and the density mass_properties would use. A material made with create_material is legacy: density basis ' +
    'unspecified, provenance legacy. A private-library record without values on this machine says unresolved. Next: get_material_allowable.',
  params: z.object({ material: z.string().describe('Material id (create_material name or record id).') }),
  run: (doc, { material: name }): CommandResult => {
    const material = Object.hasOwn(doc.materials, name) ? doc.materials[name] : undefined;
    if (material === undefined)
      return refuseMaterial(doc, 'get_material', 'MAT_RECORD_NOT_FOUND', `no material '${name}'`, {
        ids: [name],
        path: 'material',
        data: { available: false, code: 'MAT_RECORD_NOT_FOUND', materials: Object.keys(doc.materials) },
      });
    const values = (material.propertyModels ?? []).map(valueView);
    const record = material.record;
    const density = densityView(doc, name, material);
    return report(
      doc,
      `get_material '${name}': ${record === undefined ? 'legacy material' : `record ${record.designation}${record.temper !== undefined ? ` ${record.temper}` : ''}`}, ${values.length} value(s)` +
        `${record?.unresolved !== undefined ? `, UNRESOLVED (${record.unresolved.reason})` : ''}` +
        `${record !== undefined ? `, marking ${markingText(record.exportMarking)}` : ''}; density ${density['available'] === true ? `${String(density['kgPerM3'])} kg/m^3 (${String(density['source'])})` : 'not available'}.`,
      {
        material: name,
        legacy: record === undefined,
        ...(record !== undefined ? { record, marking: record.exportMarking } : {}),
        ...(record?.unresolved !== undefined ? { unresolved: record.unresolved } : {}),
        density,
        values,
      },
    );
  },
});
