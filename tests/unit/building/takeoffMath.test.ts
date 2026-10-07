import { describe, expect, it } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import type { FootingElement } from '@core/model/building';
import { footingRebarMass, scaleFor, stairVolume } from '@aec/takeoffBasics';

const footing = (width: number, length: number): FootingElement => ({
  id: 'footing-1',
  category: 'footing',
  mark: 'F1',
  entityIds: [],
  levelId: 'level-1',
  location: [0, 0],
  width,
  length,
  thickness: 500,
  topOffset: 0,
  material: 'concrete',
  reinforcement: { barDiameter: 16, spacing: 200, cover: 50 },
});

const AREA_OF_16MM_BAR = (Math.PI * 0.016 ** 2) / 4;

describe('computed outputs on a small model, checked by hand', () => {
  const model = (units: 'mm' | 'm' = 'mm'): CadDocument => {
    const k = units === 'm' ? 0.001 : 1;
    let doc: CadDocument = { ...createEmptyDocument(), units };
    const steps: Array<[string, Record<string, unknown>]> = [
      [
        'add_steel_member',
        {
          profile: 'IPE300',
          role: 'beam',
          start: [0, 0, 3000 * k],
          end: [3000 * k, 4000 * k, 3000 * k],
        },
      ],
      [
        'add_pipe_run',
        {
          points: [
            [0, 0, 0],
            [3000 * k, 0, 0],
            [3000 * k, 4000 * k, 0],
          ],
          diameter: 100 * k,
        },
      ],
      [
        'add_cable_tray',
        {
          points: [
            [0, 0, 0],
            [0, 0, 3000 * k],
            [4000 * k, 0, 3000 * k],
          ],
          width: 300 * k,
          height: 60 * k,
        },
      ],
    ];
    for (const [name, params] of steps) doc = execute(doc, name, params).document;
    return doc;
  };
  const lines = (doc: CadDocument): Array<{ key: string; quantity: number }> =>
    (
      execute(doc, 'quantity_takeoff', {}).data as {
        lines: Array<{ key: string; quantity: number }>;
      }
    ).lines;
  const quantity = (doc: CadDocument, key: string): number | undefined =>
    lines(doc).find((line) => line.key === key)?.quantity;

  it.each(['mm', 'm'] as const)('weights, lengths and paint in a %s document', (units) => {
    const doc = model(units);
    // Beam: 3-4-0 diagonal = 5 m of IPE300 (42.2 kg/m, painted perimeter 1.1858 m2/m).
    expect(quantity(doc, 'member.IPE300.m')).toBeCloseTo(5, 6);
    expect(quantity(doc, 'member.IPE300.kg')).toBeCloseTo(211, 6);
    expect(quantity(doc, 'member.paint.m2')).toBeCloseTo(5 * 1.1858, 3);
    // Pipe 3 m + 4 m, tray 3 m up + 4 m across.
    const pipe = lines(doc).find((line) => line.key.startsWith('pipe.'));
    expect(pipe?.quantity).toBeCloseTo(7, 6);
    const tray = lines(doc).find((line) => line.key.startsWith('tray.'));
    expect(tray?.quantity).toBeCloseTo(7, 6);
  });

  it('prices the roll-up: quantity x rate per line, wildcard fallbacks, total and unpriced', () => {
    const doc = model();
    const priced = execute(doc, 'estimate_cost', {
      rates: { 'member.IPE300.kg': 2, 'pipe.*.m': 10 },
    }).data as {
      total: number;
      unpriced: string[];
      lines: Array<{ key: string; amount: number | null }>;
    };
    // 211 kg x 2 + 7 m x 10 = 492; the tray and the paint stay unpriced.
    expect(priced.total).toBeCloseTo(492, 6);
    expect(priced.unpriced.some((key) => key.startsWith('tray.'))).toBe(true);
    expect(priced.unpriced).toContain('member.paint.m2');
  });

  it('measures clash penetration as the smallest overlap, in mm in the summary', () => {
    let doc = createEmptyDocument();
    doc = execute(doc, 'add_equipment', {
      mark: 'A',
      name: 'A',
      location: [0, 0],
      size: [1000, 1000, 1000],
      clearance: 0,
    }).document;
    doc = execute(doc, 'add_equipment', {
      mark: 'B',
      name: 'B',
      location: [900, 0],
      size: [1000, 1000, 1000],
      clearance: 0,
    }).document;
    const clash = (execute(doc, 'check_clashes', {}).data as { clashes: Array<{ depth: number }> })
      .clashes[0];
    // Boxes span x -500..500 and 400..1400: 100 mm overlap in x is the minimum axis.
    expect(clash?.depth).toBeCloseTo(100, 6);
  });
});

describe('takeoff math by hand', () => {
  it('weighs the two-way mat of a 1 m x 1 m pad: 5 bars each way of 0.9 m plus 10% laps', () => {
    const scale = scaleFor(createEmptyDocument());
    const expected = (5 * 0.9 + 5 * 0.9) * AREA_OF_16MM_BAR * 7850 * 1.1;
    expect(footingRebarMass(footing(1000, 1000), scale)).toBeCloseTo(expected, 6);
  });

  it('never returns a negative mass for a pad narrower than twice the cover', () => {
    const scale = scaleFor(createEmptyDocument());
    expect(footingRebarMass(footing(80, 1000), scale)).toBeGreaterThanOrEqual(0);
    expect(footingRebarMass(footing(80, 80), scale)).toBe(0);
  });

  it('sums stair steps as riser x tread x width x n(n+1)/2', () => {
    const volume = stairVolume({
      id: 'stair-1',
      category: 'stair',
      mark: 'S1',
      entityIds: [],
      levelId: 'level-1',
      start: [0, 0],
      angle: 0,
      width: 1000,
      riserCount: 4,
      riserHeight: 150,
      treadDepth: 300,
      material: 'concrete',
    });
    expect(volume).toBe(300 * 1000 * 150 * 10);
  });
});
