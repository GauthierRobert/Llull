/** Shared fixtures of the 01 PSC spec tests: the pack's CS150-A1 spec, the MIX-1 spec of plan SC-PSC-05, and documents holding them. */

import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';
import { packJson } from './packData';

export type Json = Record<string, unknown>;

/** The pack fixture `CS150-A1` (a fresh copy per call: tests mutate it). */
export const fixtureSpec = (): Json => packJson<Json>('sample_spec_cs150.json');

export const importedDoc = (spec: Json = fixtureSpec()): CadDocument => apply(createEmptyDocument(), 'import_pipe_spec', { spec });

/** EN 10220 pipe + ASME B16.9 elbow DN50..100 (SC-PSC-05 step 5). */
export const mixSpec = (): Json => ({
  format: 'llull-pipe-spec',
  schemaVersion: 1,
  id: 'MIX-1',
  dimensionalStandard: 'EN',
  rating: { system: 'EN 1092-1', pn: 16 },
  corrosionAllowance: { value: 1, unit: 'mm' },
  sizeRange: { fromDn: 50, toDn: 100 },
  catalogs: ['llull-open-piping'],
  components: [
    { id: 'P', type: 'pipe', fromDn: 50, toDn: 100, standard: 'EN 10220', wallMm: 3.6, catalogRef: 'en-10220' },
    { id: 'E', type: 'elbow90', radius: 'LR', fromDn: 50, toDn: 100, catalogRef: 'asme-b16.9' },
  ],
  status: 'draft',
});

/** A small ASME spec with three components, for edit and check tests. */
export const smallSpec = (over: Json = {}): Json => ({
  format: 'llull-pipe-spec',
  schemaVersion: 1,
  id: 'SMALL',
  dimensionalStandard: 'ASME',
  rating: { system: 'ASME B16.5', class: 150, materialGroup: '1.1' },
  corrosionAllowance: { value: 3, unit: 'mm' },
  designLimits: { minTemperatureC: -29, maxTemperatureC: 200 },
  sizeRange: { fromNps: 2, toNps: 6 },
  catalogs: ['llull-open-piping'],
  components: [
    { id: 'P', type: 'pipe', fromNps: 2, toNps: 6, schedule: '40', ends: 'BE', catalogRef: 'asme-b36.10m' },
    { id: 'E', type: 'elbow90', fromNps: 2, toNps: 6, radius: 'LR', ends: 'BW', scheduleFromPipe: true, catalogRef: 'asme-b16.9' },
  ],
  branchTable: { cells: { '4': { '2': 'W', '4': 'T' } } },
  ...over,
});

/** A document with one pipe element bound (or not) to a spec revision. */
export function withPipe(base: CadDocument, id: string, diameter: number, spec?: Json): CadDocument {
  const pipe = {
    id,
    category: 'pipe',
    levelId: 'lvl-0',
    entityIds: [],
    points: [
      [0, 0, 0],
      [1000, 0, 0],
    ],
    diameter,
    service: 'water',
    material: 'steel',
    ...(spec === undefined ? {} : { spec }),
  };
  const building = base.building ?? { elements: {}, elementOrder: [] };
  return {
    ...base,
    building: { ...building, elements: { ...building.elements, [id]: pipe }, elementOrder: [...building.elementOrder, id] },
  } as unknown as CadDocument;
}
