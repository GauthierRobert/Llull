/**
 * Plant 06 STA-FU2b: a steel stair whose stringer profile or grating type left the catalogue (a file written by an older catalogue) is measured with
 * zero sizes and masses, evaluated / exported as nothing and never throws.
 */

import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { SteelStairElement } from '@aec/building/types';
import { stairFlightBoxes } from '@aec/plant/structures/clash/structuresClashBodies';
import { evaluateSteelStair } from '@aec/plant/structures/evaluate/evaluateSteelStair';
import { stairQuantities, stairSizes, treadMassKgM2, treadThickness } from '@aec/plant/structures/stair/steelStairMeasure';
import { apply } from '../../../helpers/commandAssertions';

const built = (): { doc: CadDocument; stair: SteelStairElement; level: NonNullable<CadDocument['building']>['levels'][string] } => {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'add_level', { name: 'Grade', elevation: 0, height: 3000 });
  const levelId = Object.keys(doc.building?.levels ?? {})[0] as string;
  doc = apply(doc, 'add_steel_stair', {
    start: [0, 0, 0],
    angle: 0,
    rise: 3000,
    riserMax: 180,
    going: 280,
    landings: [{ afterRiser: 9, length: 1000, turn: 'quarter_left' }],
    levelId,
  });
  const stair = doc.building?.elements['steelStair-1'] as SteelStairElement;
  return { doc, stair, level: doc.building?.levels[levelId] as never };
};

describe('steel stair with catalogue gaps', () => {
  it('an unknown stringer profile gives zero sizes and no stringer mass; evaluation and clash bodies are empty', () => {
    const { doc, stair, level } = built();
    const gone: SteelStairElement = { ...stair, stringerProfile: 'NOPE999' };
    expect(stairSizes(doc, gone)).toEqual({ stringerWeb: 0, stringerDepth: 0 });
    expect(stairQuantities(doc, gone).stringerKg).toBe(0);
    expect(evaluateSteelStair(doc, gone, level)).toEqual([]);
    expect(stairFlightBoxes(doc, gone, level)).toEqual([]);
  });

  it('an unknown grating type has no thickness and no mass; a known one has both; a plate is thickness x 7850', () => {
    const { doc, stair } = built();
    const missing: SteelStairElement['tread'] = { kind: 'grating', gratingType: 'NOPE' };
    expect(treadThickness(doc, missing)).toBe(0);
    expect(treadMassKgM2(doc, missing)).toBe(0);
    expect(treadMassKgM2(doc, stair.tread)).toBeGreaterThan(0);
    expect(treadThickness(doc, stair.tread)).toBeGreaterThan(0);
    expect(treadMassKgM2(doc, { kind: 'checker_plate', thickness: 6 })).toBeCloseTo(0.006 * 7850, 9);
    expect(stairQuantities(doc, { ...stair, tread: missing }).treadKg).toBe(0);
  });
});
