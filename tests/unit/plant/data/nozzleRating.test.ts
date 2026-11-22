import type { EquipmentElement } from '@aec/building/types';
/**
 * Plant 08 DAT J4: `check_plant_data` compares the nozzle a routed line names with the line's spec class and with the P-T rating at the line design
 * temperature. Oracles are the bundled ASME B16.5 group 1.1 table values (CL150 19.6 bar at 38 degC, 13.8 bar at 200 degC; CL300 51.1 bar at 38 degC).
 */

import { describe, expect, it } from 'vitest';
import type { CadDocument } from '@core/model/types';
import { getPiping } from '@aec/plant/piping/model';
import { data as queryData, apply } from '../../../helpers/commandAssertions';
import { scDat02Document } from './dataFixtures';

interface Check {
  status: string;
  findings: Array<{ code: string; severity: string; message: string; paths: string[] }>;
}

const check = (doc: CadDocument): Check => queryData<Check>(doc, 'check_plant_data', {});
const ratingCodes = (doc: CadDocument): string[] =>
  check(doc)
    .findings.filter((finding) => finding.code.startsWith('DAT_NOZZLE_RATING'))
    .map((finding) => finding.code);

function nozzleName(doc: CadDocument, mark: string): string {
  const element = Object.values(doc.building?.elements ?? {}).find(
    (item): item is EquipmentElement => item.category === 'equipment' && item.mark === mark,
  );
  const nozzle = element?.plant?.nozzles[0];
  if (nozzle === undefined) throw new Error(`no nozzle on ${mark}`);
  return `${mark}:${nozzle.mark}`;
}

const lineId = (doc: CadDocument): string => getPiping(doc).lineOrder[0] as string;

function named(doc: CadDocument, extra: Record<string, unknown> = {}): CadDocument {
  return apply(doc, 'update_pipeline', { lineId: lineId(doc), from: nozzleName(doc, 'P-101'), to: nozzleName(doc, 'V-101'), ...extra });
}

/** The rating of every nozzle of equipment `mark` set straight in the building slice (a file edited by hand). */
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

describe('check_plant_data nozzle rating (J4)', () => {
  it('reports the nozzle ends as unchecked, naming why, with no design conditions or a PN-rated nozzle', () => {
    const doc = named(scDat02Document());
    const piping = doc.plant?.piping;
    const id = lineId(doc);
    const line = piping?.lines[id];
    if (doc.plant === undefined || piping === undefined || line === undefined) throw new Error('no line');
    const { designTempC: _dropped, ...withoutTemperature } = line;
    const bare = {
      ...doc,
      plant: { ...doc.plant, piping: { ...piping, lines: { ...piping.lines, [id]: withoutTemperature } } },
    } as CadDocument;
    const found = check(bare).findings.filter((finding) => finding.code === 'DAT_NOZZLE_RATING_UNCHECKED');
    expect(found.length).toBeGreaterThan(0);
    expect(found[0]?.severity).toBe('info');
    expect(found[0]?.message).toContain('designTempC');
    const pn = withNozzleRating(doc, 'P-101', 'PN16');
    expect(check(pn).findings.some((finding) => finding.code === 'DAT_NOZZLE_RATING_UNCHECKED' && finding.message.includes('PN16'))).toBe(
      true,
    );
    const odd = withNozzleRating(doc, 'P-101', 'big');
    expect(check(odd).findings.some((finding) => finding.code === 'DAT_NOZZLE_RATING_UNCHECKED' && finding.message.includes('"big"'))).toBe(
      true,
    );
  });

  it('passes a design pressure inside the nozzle rating at the design temperature and fails one above it', () => {
    const nozzle = named(scDat02Document());
    const classes = new Set(
      Object.values(nozzle.building?.elements ?? {}).flatMap((item) =>
        item.category === 'equipment' ? [item.plant?.nozzles[0]?.rating] : [],
      ),
    );
    expect([...classes].every((rating) => rating === 'CL150')).toBe(true);
    const inside = named(scDat02Document(), { designTempC: 38, designPressureBarG: 19 });
    expect(ratingCodes(inside).filter((code) => code !== 'DAT_NOZZLE_RATING_UNCHECKED')).toEqual([]);
    const hot = named(scDat02Document(), { designTempC: 200, designPressureBarG: 15 });
    const failing = check(hot).findings.filter((finding) => finding.code === 'DAT_NOZZLE_RATING_LOW');
    expect(failing.length).toBeGreaterThan(0);
    expect(failing[0]?.severity).toBe('fail');
    expect(failing[0]?.message).toContain('13.8');
    expect(check(hot).status).toBe('fail');
    const cold = named(scDat02Document(), { designTempC: 200, designPressureBarG: 13 });
    expect(ratingCodes(cold)).not.toContain('DAT_NOZZLE_RATING_LOW');
  });

  it('refuses by name (unchecked) a design temperature outside the table, and flags a nozzle class that differs from the spec', () => {
    const outside = named(scDat02Document(), { designTempC: 900, designPressureBarG: 1 });
    const unchecked = check(outside).findings.filter((finding) => finding.code === 'DAT_NOZZLE_RATING_UNCHECKED');
    expect(unchecked.some((finding) => finding.message.includes('PSC_PT_TEMPERATURE_OUT_OF_TABLE'))).toBe(true);
    const mismatched = withNozzleRating(named(scDat02Document()), 'P-101', 'CL300');
    expect(ratingCodes(mismatched)).toContain('DAT_NOZZLE_RATING_CLASS');
    expect(ratingCodes(mismatched)).not.toContain('DAT_NOZZLE_RATING_LOW');
  });

  it('says nothing for a line that names no nozzle, and is pure', () => {
    const doc = scDat02Document();
    const before = JSON.stringify(doc);
    expect(ratingCodes(doc)).toEqual([]);
    check(named(doc, { designTempC: 38, designPressureBarG: 5 }));
    expect(JSON.stringify(doc)).toBe(before);
  });
});
