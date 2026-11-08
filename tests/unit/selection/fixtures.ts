import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

export const PACK = path.resolve(__dirname, '../../../docs/physics/12-material-selection/validation');

interface PinnedValue {
  readonly value: number | null;
  readonly unit: string;
  readonly basis?: string;
  readonly status: string;
  readonly source?: string;
}

interface WorkedMaterial {
  readonly id: string;
  readonly label: string;
  readonly density: PinnedValue;
  readonly E: PinnedValue;
  readonly Fty: PinnedValue;
  readonly nu: PinnedValue;
}

interface SyntheticMaterial {
  readonly id: string;
  readonly densityGcm3: number;
  readonly eGPa: number;
  readonly strengthMPa: number;
  readonly costPerKg: number;
  readonly co2KgPerKg: number;
  readonly maxServiceTempC: number;
}

/** The pinned inputs of the validation pack (selection_materials.json): worked example (sourced) and synthetic materials (algorithm tests). */
export const inputs = JSON.parse(readFileSync(path.join(PACK, 'selection_materials.json'), 'utf8')) as {
  synthetic: SyntheticMaterial[];
  workedExample: WorkedMaterial[];
};

export interface Case {
  readonly id: string;
  readonly value: unknown;
  readonly tolerance: { readonly rel?: number; readonly abs?: number; readonly exact?: boolean };
}

const expected = JSON.parse(readFileSync(path.join(PACK, 'expected_results.json'), 'utf8')) as { cases: Case[]; [key: string]: unknown };

/** The pinned case `id` of expected_results.json. */
export function expectedCase(id: string): Case {
  const found = expected.cases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no validation case ${id}`);
  return found;
}

/** Top-level pinned section (synthetic, substitution, workedExample ...). */
export const pinned = <T>(key: string): T => expected[key] as T;

/** |actual - value| within the pinned tolerance (the pins carry 12 significant digits, so a relative 1e-9 band is widened to 1e-11 at least). */
export function withinCase(actual: number, value: number, id: string): boolean {
  const { rel, abs } = expectedCase(id).tolerance;
  return rel === undefined ? Math.abs(actual - value) <= (abs ?? 0) : Math.abs(actual - value) <= Math.max(rel, 1e-11) * Math.abs(value);
}

export const run = (doc: CadDocument, name: string, params: Record<string, unknown>): CommandResult => execute(doc, name, params);

/** The document after a command that must succeed. */
export function step(doc: CadDocument, name: string, params: Record<string, unknown>): CadDocument {
  const result = run(doc, name, params);
  if (result.rejected === true || result.document === doc) throw new Error(`${name} did not apply: ${result.summary}`);
  return result.document;
}

export const dataOf = (result: CommandResult): Record<string, unknown> => (result.data ?? {}) as Record<string, unknown>;

export const empty = (): CadDocument => step(createEmptyDocument(), 'set_units', { units: 'mm' });

export interface ValueInput {
  readonly property: string;
  readonly value: number;
  readonly unit: string;
  readonly basis: string;
  readonly citation: string;
  readonly id?: string;
  readonly direction?: string;
  readonly preferred?: true;
}

/** Defines the record `id` with sourced values (set_material_property). */
export function withMaterial(doc: CadDocument, id: string, values: readonly ValueInput[]): CadDocument {
  let next = step(doc, 'define_material_record', {
    id,
    designation: id,
    specs: [],
    licence: 'vendor-catalogue',
    exportMarking: { regime: 'none' },
  });
  for (const entry of values) {
    next = step(next, 'set_material_property', {
      material: id,
      property: entry.property,
      value: entry.value,
      unit: entry.unit,
      basis: entry.basis,
      ...(entry.id !== undefined ? { id: entry.id } : {}),
      ...(entry.direction !== undefined ? { direction: entry.direction } : {}),
      ...(entry.preferred === true ? { preferred: true } : {}),
      source: { citation: entry.citation },
    });
  }
  return next;
}

const SYNTHETIC_CITATION = 'synthetic test fixture: selection_materials.json (round numbers, not a material)';

/** The five synthetic materials syn_a .. syn_e (density, E, Fty) with company basis. */
export function syntheticDocument(): CadDocument {
  return inputs.synthetic.reduce(
    (doc, material) =>
      withMaterial(doc, material.id, [
        { property: 'density', value: material.densityGcm3, unit: 'g/cm^3', basis: 'company', citation: SYNTHETIC_CITATION },
        { property: 'E', value: material.eGPa, unit: 'GPa', basis: 'company', citation: SYNTHETIC_CITATION },
        { property: 'Fty', value: material.strengthMPa, unit: 'MPa', basis: 'company', citation: SYNTHETIC_CITATION },
      ]),
    empty(),
  );
}

/** The sourced worked example (typical / supplier / secondary values): every pinned value with its own basis and citation; a `tbd` value is not stored. */
export function workedDocument(): CadDocument {
  return inputs.workedExample.reduce((doc, material) => {
    const values: ValueInput[] = [];
    for (const property of ['density', 'E', 'Fty', 'nu'] as const) {
      const pin = material[property];
      if (pin.value === null) continue;
      // 'derived' (06 CMP laminate constants) is not a stored basis: unspecified, which is unverified like typical
      values.push({
        property,
        value: pin.value,
        unit: pin.unit === '-' ? '1' : pin.unit,
        basis: pin.basis === undefined || pin.basis === 'derived' ? 'unspecified' : pin.basis,
        citation: `${material.id} ${property}: ${pin.source ?? 'selection_materials.json'}`,
      });
    }
    return withMaterial(doc, material.id, values);
  }, empty());
}

/** A 100 x 50 x 10 mm box made of `material` (the 08 worked block, 50 cm^3). */
export function withBlock(doc: CadDocument, material: string): { readonly doc: CadDocument; readonly id: string } {
  const added = run(doc, 'add_box', { size: [100, 50, 10], anchor: 'min' });
  const id = added.affected[0] ?? '';
  return { doc: step(added.document, 'assign_material', { materialName: material, entityIds: [id] }), id };
}
