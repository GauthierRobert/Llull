import { readFileSync } from 'node:fs';
import path from 'node:path';
import { execute } from '@core/commands/registry';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

const PACK = path.resolve(__dirname, '../../../docs/physics/14-moisture-outgassing/validation');

interface ExpectedCase {
  readonly id: string;
  readonly value: unknown;
  readonly tolerance: { readonly rel?: number; readonly abs?: number; readonly exact?: boolean };
}

const expected = JSON.parse(readFileSync(path.join(PACK, 'expected_results.json'), 'utf8')) as {
  cases: ExpectedCase[];
  outgassing: Record<string, Record<string, unknown>>;
  fickTau: Record<string, number>;
};

/** The pinned value of case `id` in the validation pack (expected_results.json, 12 significant digits). */
export function pinned(id: string): unknown {
  const found = expected.cases.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no validation case ${id}`);
  return found.value;
}

export const pinnedOutgassing = expected.outgassing;
export const pinnedTau = expected.fickTau;

/** Relative closeness at the pack tolerance, widened by the 12-digit rounding of the pins. */
export const close = (actual: number, wanted: number, rel = 1e-9): boolean =>
  Math.abs(actual - wanted) <= Math.max(rel, 1e-11) * Math.abs(wanted);

/** Runs a command, throwing when it is rejected (a fixture step that must work). */
export function run(doc: CadDocument, name: string, params: Record<string, unknown>): CommandResult {
  const result = execute(doc, name, params);
  if (result.error !== undefined) throw new Error(`${name} refused: ${result.summary}`);
  return result;
}

const source = { citation: 'synthetic test value (PHY-14 validation pack)' };

/** A material with E595 values (percent) and density 0.0012 g/mm^3. */
export function withMaterial(doc: CadDocument, name: string, values: Record<string, number>, density = 0.0012): CadDocument {
  let next = run(doc, 'create_material', { name, density, color: '#d9a441', metalness: 0, roughness: 0.6 }).document;
  for (const [property, value] of Object.entries(values))
    next = run(next, 'set_material_property', { material: name, property, value, unit: '%', basis: 'company', source }).document;
  return next;
}

/** A 200 g box (100 x 100 x 16.6667 mm at 0.0012 g/mm^3) of material `material`; returns the document and the entity id. */
export function withPanel(doc: CadDocument, material: string): { document: CadDocument; id: string } {
  const added = run(doc, 'add_box', { size: [100, 100, 16.6666666667], anchor: 'min' });
  const id = added.affected[0] ?? '';
  return { document: run(added.document, 'assign_material', { materialName: material, entityIds: [id] }).document, id };
}

export const emptyMm = (): CadDocument => run(createEmptyDocument(), 'set_units', { units: 'mm' }).document;

/** A document with a populated mission environment: a custom profile, a humidity exposure and an AO fluence, and a screened panel. */
export function missionDocument(): CadDocument {
  const panel = withPanel(withMaterial(emptyMm(), 'syn_low', { TML: 0.95, CVCM: 0.05, WVR: 0.3 }), 'syn_low');
  return run(panel.document, 'set_mission_environment', {
    outgassingProfile: {
      id: 'program_x',
      label: 'Program X contamination plan',
      limits: [
        { quantity: 'TML', op: '<', value: 1, unit: '%' },
        { quantity: 'CVCM', op: '<=', value: 0.1, unit: '%' },
      ],
      testMethod: 'ASTM_E595',
      source: 'Program X CCP rev B',
    },
    humidityExposure: {
      relativeHumidity: 50,
      temperature: { value: 20, unit: 'degC' },
      duration: { value: 7, unit: 'd' },
      faces: 'both',
      source: 'storage specification',
    },
    aoFluence: { value: 1e21, unit: 'atoms/cm^2', source: 'mission analysis rev B' },
  }).document;
}
