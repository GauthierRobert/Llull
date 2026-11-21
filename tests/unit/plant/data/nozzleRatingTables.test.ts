import type { EquipmentElement } from '@aec/building/types';
/**
 * Plant 08 DAT J4: which rating table `check_plant_data` uses for a nozzle against its line spec, and what it refuses to assume. The spec / table / nozzle
 * data are set straight in the document slices (a file edited by hand) so each branch is one row of the table below.
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import type { RatingTable } from '@aec/plant/catalog/types';
import type { SpecRating } from '@aec/plant/spec/types';
import { getPiping } from '@aec/plant/piping/model';
import { data as queryData, apply } from '../../../helpers/commandAssertions';
import { scDat02Document } from './dataFixtures';

interface Finding {
  code: string;
  severity: string;
  message: string;
}

const findings = (doc: CadDocument): Finding[] =>
  queryData<{ findings: Finding[] }>(doc, 'check_plant_data', {}).findings.filter((finding) =>
    finding.code.startsWith('DAT_NOZZLE_RATING'),
  );

const nozzleOf = (doc: CadDocument, mark: string): string => {
  const element = Object.values(doc.building?.elements ?? {}).find(
    (item): item is EquipmentElement => item.category === 'equipment' && item.mark === mark,
  );
  return `${mark}:${element?.plant?.nozzles[0]?.mark ?? ''}`;
};

/** SC-DAT-02 with the line naming both nozzles and the given design conditions. */
function scene(extra: Record<string, unknown> = { designTempC: 200, designPressureBarG: 10 }): CadDocument {
  const doc = scDat02Document();
  return apply(doc, 'update_pipeline', {
    lineId: getPiping(doc).lineOrder[0],
    from: nozzleOf(doc, 'P-101'),
    to: nozzleOf(doc, 'V-101'),
    ...extra,
  });
}

function withSpecRating(doc: CadDocument, rating: SpecRating | null): CadDocument {
  const plant = doc.plant;
  const id = getPiping(doc).lines[getPiping(doc).lineOrder[0] as string]?.spec as string;
  const revisions = plant?.spec?.specs[id];
  if (plant?.spec === undefined || revisions === undefined) throw new Error('no spec');
  const edited = rating === null ? [] : revisions.map((spec, index) => (index === revisions.length - 1 ? { ...spec, rating } : spec));
  return { ...doc, plant: { ...plant, spec: { ...plant.spec, specs: { ...plant.spec.specs, [id]: edited } } } } as CadDocument;
}

function withTable(doc: CadDocument, table: RatingTable): CadDocument {
  const plant = doc.plant;
  const catalog = plant?.catalog;
  if (plant === undefined || catalog === undefined) throw new Error('no catalog');
  return {
    ...doc,
    plant: { ...plant, catalog: { ...catalog, ratingTables: { ...catalog.ratingTables, [table.id]: table } } },
  } as CadDocument;
}

function withNozzleRating(doc: CadDocument, mark: string, rating: string): CadDocument {
  const building = doc.building;
  if (building === undefined) throw new Error('no building');
  const elements = Object.fromEntries(
    Object.entries(building.elements).map(([id, element]) => [
      id,
      element.category === 'equipment' && element.plant !== undefined && element.mark === mark
        ? { ...element, plant: { ...element.plant, nozzles: element.plant.nozzles.map((nozzle) => ({ ...nozzle, rating })) } }
        : element,
    ]),
  );
  return { ...doc, building: { ...building, elements } } as CadDocument;
}

const dim = (value: number, verified: boolean): RatingTable['rows'][number]['bar'] => ({
  value,
  unit: 'bar',
  verified,
  provenance: { sourceId: 'test', citation: 'test fixture' },
});

const table = (patch: Partial<RatingTable> & { id: string }, rows: ReadonlyArray<[number, number, number, boolean]>): RatingTable => ({
  standard: 'ASME B16.5',
  materialGroup: '2.2',
  minTemperatureC: -29,
  rows: rows.map(([ratingClass, temperatureC, bar, verified]) => ({ ratingClass, temperatureC, bar: dim(bar, verified) })),
  ...patch,
});

const GROUP_22 = table({ id: 'g22' }, [
  [150, 38, 15, false],
  [150, 300, 8, false],
]);
const PN_TABLE = table({ id: 'en16', standard: 'EN 1092-1', materialGroup: 'EN 1.0460', ratingKey: 'pn' }, [
  [16, 20, 16, true],
  [16, 300, 10, true],
]);

const messages = (doc: CadDocument, code: string): Finding[] => findings(doc).filter((finding) => finding.code === code);
const unchecked = (doc: CadDocument): Finding[] => messages(doc, 'DAT_NOZZLE_RATING_UNCHECKED');

describe('nozzle rating tables (J4)', () => {
  const classSpec: SpecRating = { system: 'ASME B16.5', class: 150, materialGroup: '1.1' };

  it.each([
    ['the spec is not in the document', null, 'not in the document'],
    ['no material group: 1.1 is never assumed', { system: 'ASME B16.5', class: 150 }, 'group 1.1 is not assumed'],
    ['no table for the material group', { ...classSpec, materialGroup: '3.1' }, 'no rating table for ASME B16.5 group 3.1'],
    ['a table id the document lacks', { ...classSpec, ratingTableId: 'missing' }, 'is not in the document'],
    [
      'a table of another group than the spec',
      { ...classSpec, materialGroup: '2.2', ratingTableId: 'asme-b16.5-group-1.1' },
      'group 1.1 but spec',
    ],
  ] as Array<[string, SpecRating | null, string]>)('refuses by name, as a warning: %s', (_name, rating, text) => {
    const found = unchecked(withSpecRating(scene(), rating));
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((finding) => finding.severity === 'warn' && finding.message.includes(text))).toBe(true);
    expect(messages(withSpecRating(scene(), rating), 'DAT_NOZZLE_RATING_LOW')).toEqual([]);
  });

  it('uses the table of the spec system and group: an imported group 2.2 table passes 8 bar and fails 9 bar at 300 degC, unverified rows named', () => {
    const base = withTable(
      withSpecRating(scene({ designTempC: 300, designPressureBarG: 8 }), { ...classSpec, materialGroup: '2.2' }),
      GROUP_22,
    );
    expect(findings(base)).toEqual([]);
    const high = withTable(
      withSpecRating(scene({ designTempC: 300, designPressureBarG: 9 }), { ...classSpec, materialGroup: '2.2' }),
      GROUP_22,
    );
    const low = messages(high, 'DAT_NOZZLE_RATING_LOW');
    expect(low.length).toBeGreaterThan(0);
    expect(low[0]?.message).toContain('g22');
    expect(low[0]?.message).toContain('unverified rows');
    const byId = withTable(
      withSpecRating(scene({ designTempC: 300, designPressureBarG: 9 }), { ...classSpec, materialGroup: '2.2', ratingTableId: 'g22' }),
      GROUP_22,
    );
    expect(messages(byId, 'DAT_NOZZLE_RATING_LOW').length).toBeGreaterThan(0);
  });

  it('a PN spec with a PN table and PN nozzles: passes inside the rating, fails above it; a class nozzle is refused and flagged against the PN spec', () => {
    const pnSpec: SpecRating = { system: 'EN 1092-1', pn: 16, materialGroup: 'EN 1.0460', ratingTableId: 'en16' };
    const build = (pressure: number, nozzle = 'PN16'): CadDocument =>
      withNozzleRating(
        withNozzleRating(
          withTable(withSpecRating(scene({ designTempC: 300, designPressureBarG: pressure }), pnSpec), PN_TABLE),
          'P-101',
          nozzle,
        ),
        'V-101',
        nozzle,
      );
    expect(findings(build(9))).toEqual([]);
    const failing = messages(build(11), 'DAT_NOZZLE_RATING_LOW');
    expect(failing.length).toBeGreaterThan(0);
    expect(failing[0]?.message).toContain('PN16 rating 10 bar');
    const mixed = findings(build(9, 'CL150'));
    expect(
      mixed.some(
        (finding) => finding.code === 'DAT_NOZZLE_RATING_CLASS' && finding.message.includes('spec') && finding.message.includes('PN16'),
      ),
    ).toBe(true);
    expect(unchecked(build(9, 'CL150')).every((finding) => finding.message.includes('rates by pn'))).toBe(true);
    const different = messages(build(9, 'PN25'), 'DAT_NOZZLE_RATING_CLASS');
    expect(different.length).toBeGreaterThan(0);
  });

  it('missing inputs are info; a class the table lacks and a temperature above the table are warnings naming the PSC code', () => {
    const noPressure = withNozzleRating(scene(), 'V-101', 'CL150');
    const plant = noPressure.plant;
    const id = getPiping(noPressure).lineOrder[0] as string;
    const line = getPiping(noPressure).lines[id];
    if (plant?.piping === undefined || line === undefined) throw new Error('no line');
    const { designPressureBarG: _dropped, ...rest } = line;
    const bare = {
      ...noPressure,
      plant: { ...plant, piping: { ...plant.piping, lines: { ...plant.piping.lines, [id]: rest } } },
    } as CadDocument;
    const info = unchecked(bare);
    expect(info.length).toBeGreaterThan(0);
    expect(info.every((finding) => finding.severity === 'info' && finding.message.includes('designPressureBarG'))).toBe(true);
    const missingClass = unchecked(withNozzleRating(withNozzleRating(scene(), 'P-101', 'CL400'), 'V-101', 'CL400'));
    expect(missingClass.some((finding) => finding.severity === 'warn' && finding.message.includes('PSC_CATALOG_ROW_MISSING'))).toBe(true);
    const hot = unchecked(scene({ designTempC: 900, designPressureBarG: 1 }));
    expect(hot.every((finding) => finding.severity === 'warn' && finding.message.includes('PSC_PT_TEMPERATURE_OUT_OF_TABLE'))).toBe(true);
  });

  it('an equipment tag held by two equipment is ambiguous and refused', () => {
    const doc = scene();
    const building = doc.building;
    const pump = Object.values(building?.elements ?? {}).find((item) => item.category === 'equipment' && item.mark === 'P-101');
    if (building === undefined || pump === undefined) throw new Error('no pump');
    const twin = { ...pump, id: 'equipment-twin', entityIds: [] };
    const doubled = {
      ...doc,
      building: { ...building, elements: { ...building.elements, [twin.id]: twin }, elementOrder: [...building.elementOrder, twin.id] },
    } as CadDocument;
    const found = unchecked(doubled).filter((finding) => finding.message.includes('ambiguous equipment tag'));
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.severity).toBe('warn');
  });
});
