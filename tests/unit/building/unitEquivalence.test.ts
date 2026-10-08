import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';

type Step = [name: string, params: (k: number) => Record<string, unknown>];

const STEPS: Record<string, Step[]> = {
  'duopitch hall with crane': [
    [
      'add_portal_frame_building',
      (k) => ({
        span: 18000 * k,
        length: 24000 * k,
        baySpacing: 6000 * k,
        eaveHeight: 6000 * k,
        roofPitch: 6,
        crane: { capacity: 10, railHeight: 4500 * k },
      }),
    ],
  ],
  'two-span monopitch hall': [
    [
      'add_portal_frame_building',
      (k) => ({
        spans: [12000 * k, 12000 * k],
        length: 18000 * k,
        baySpacing: 6000 * k,
        eaveHeight: 5000 * k,
        roofType: 'monopitch',
        roofPitch: 5,
      }),
    ],
  ],
  'standalone crane runway on columns': [
    [
      'add_steel_member',
      (k) => ({ profile: 'HEA400', role: 'column', start: [0, 0, 0], end: [0, 0, 6000 * k] }),
    ],
    [
      'add_steel_member',
      (k) => ({
        profile: 'HEA400',
        role: 'column',
        start: [0, 6000 * k, 0],
        end: [0, 6000 * k, 6000 * k],
      }),
    ],
    [
      'add_crane_runway',
      (k) => ({
        start: [700 * k, 0],
        end: [700 * k, 12000 * k],
        railHeight: 5000 * k,
        capacity: 5,
      }),
    ],
  ],
};

interface Line {
  key: string;
  quantity: number;
}

function build(steps: Step[], units: 'mm' | 'm'): CadDocument {
  const k = units === 'm' ? 0.001 : 1;
  let doc: CadDocument = { ...createEmptyDocument(), units };
  for (const [name, params] of steps) {
    const result = execute(doc, name, params(k));
    expect(result.affected.length, `${units} ${name}: ${result.summary}`).toBeGreaterThan(0);
    doc = result.document;
  }
  return doc;
}

const lines = (doc: CadDocument): Line[] =>
  (execute(doc, 'quantity_takeoff', {}).data as { lines: Line[] }).lines;

describe('industrial generators: m and mm documents are the same building', () => {
  for (const [label, steps] of Object.entries(STEPS)) {
    it(`${label}: same elements and the same metric takeoff`, () => {
      const mm = build(steps, 'mm');
      const metres = build(steps, 'm');
      expect(Object.keys(metres.building?.elements ?? {})).toEqual(
        Object.keys(mm.building?.elements ?? {}),
      );
      const [a, b] = [lines(mm), lines(metres)];
      expect(b.map((line) => line.key)).toEqual(a.map((line) => line.key));
      for (const [index, line] of a.entries()) {
        const other = b[index] as Line;
        expect(other.quantity, line.key).toBeCloseTo(line.quantity, 2);
      }
    });
  }
});
