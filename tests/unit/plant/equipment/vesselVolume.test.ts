import { describe, expect, it } from 'vitest';
import { execute, listCommands, toToolSchemas } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { data, expectRefusal, ok } from '../../../helpers/commandAssertions';

interface VolumeData {
  totalVolumeM3: number;
  insideHeight: number;
  headDepths: { first: number; second: number };
  levels: { level: number; liquidVolumeM3: number; percent: number }[];
  unverified: boolean;
  sources: string[];
}

const mmDocument = (): CadDocument => ok(createEmptyDocument(), 'set_units', { units: 'mm' }).document;
const ellipsoidal = { type: 'ellipsoidal', ratio: 2 };
const rel = (actual: number, expected: number): number => Math.abs(actual / expected - 1);

describe('vessel_volume', () => {
  it('SC-EQP-02 horizontal drum D 2000 x 6000, 2:1 heads: half full and 0.5 m', () => {
    const result = data<VolumeData>(mmDocument(), 'vessel_volume', {
      orientation: 'horizontal',
      insideDiameter: 2000,
      tangentLength: 6000,
      heads: { first: ellipsoidal, second: ellipsoidal },
      levels: [1000, 500, 2000, 0],
    });
    expect(rel(result.totalVolumeM3, 20.943951023931955)).toBeLessThan(1e-9);
    expect(rel(result.levels[0]?.liquidVolumeM3 ?? 0, 10.471976)).toBeLessThan(1e-7);
    expect(rel(result.levels[1]?.liquidVolumeM3 ?? 0, 4.012358)).toBeLessThan(1e-6);
    expect(result.levels[0]?.percent).toBeCloseTo(50, 9);
    expect(result.levels[2]?.liquidVolumeM3).toBeCloseTo(result.totalVolumeM3, 9);
    expect(result.levels[3]?.liquidVolumeM3).toBe(0);
    expect(result.insideHeight).toBeCloseTo(2000, 9);
    expect(result.headDepths.first).toBeCloseTo(500, 9);
    expect(result.unverified).toBe(false);
  });

  it('SC-EQP-01 vertical separator ID 1500 T/T 4000: operating liquid at 1875 mm is 3.0925 m3', () => {
    const result = data<VolumeData>(mmDocument(), 'vessel_volume', {
      orientation: 'vertical',
      insideDiameter: 1500,
      tangentLength: 4000,
      heads: { first: ellipsoidal, second: ellipsoidal },
      levels: [1875],
    });
    const radius = 0.75;
    expect(rel(result.levels[0]?.liquidVolumeM3 ?? 0, Math.PI * radius * radius * 1.75)).toBeLessThan(1e-12);
    expect(rel(result.totalVolumeM3, Math.PI * radius * radius * 4 + (Math.PI * 1.5 ** 3) / 12)).toBeLessThan(1e-12);
    expect(result.insideHeight).toBeCloseTo(4750, 9);
  });

  it('volumes are independent of the document unit', () => {
    const inches = ok(createEmptyDocument(), 'set_units', { units: 'in' }).document;
    const result = data<VolumeData>(inches, 'vessel_volume', {
      orientation: 'vertical',
      insideDiameter: 60,
      tangentLength: 120,
      heads: { first: { type: 'flat' }, second: { type: 'hemispherical' } },
    });
    const radius = 30 * 0.0254;
    expect(rel(result.totalVolumeM3, Math.PI * radius * radius * 120 * 0.0254 + (2 * Math.PI * radius ** 3) / 3)).toBeLessThan(1e-12);
    expect(result.levels).toEqual([]);
  });

  it('a grade B head standard reports unverified with its source', () => {
    const result = data<VolumeData>(mmDocument(), 'vessel_volume', {
      orientation: 'vertical',
      insideDiameter: 1000,
      tangentLength: 1000,
      heads: { first: { type: 'torispherical', standard: 'asme_80_10' }, second: { type: 'torispherical', standard: 'asme_fd' } },
    });
    expect(result.unverified).toBe(true);
    expect(result.sources).toHaveLength(2);
    expect(result.sources[0]).toContain('grade B');
  });

  it('torispherical radii are read in document units and match the named standard', () => {
    const base = { orientation: 'vertical', insideDiameter: 1000, tangentLength: 1000, levels: [300] };
    const radii = { type: 'torispherical', crownRadius: 1000, knuckleRadius: 60 };
    const named = data<VolumeData>(mmDocument(), 'vessel_volume', {
      ...base,
      heads: { first: { type: 'torispherical', standard: 'asme_fd' }, second: radii },
    });
    const explicit = data<VolumeData>(mmDocument(), 'vessel_volume', { ...base, heads: { first: radii, second: radii } });
    expect(rel(explicit.totalVolumeM3, named.totalVolumeM3)).toBeLessThan(1e-12);
    expect(rel(explicit.levels[0]?.liquidVolumeM3 ?? 0, named.levels[0]?.liquidVolumeM3 ?? 1)).toBeLessThan(1e-12);
    expect(explicit.unverified).toBe(false);
  });

  it('horizontal torispherical: total allowed, partial level refused EQP_HEAD_NOT_COVERED', () => {
    const doc = mmDocument();
    const base = {
      orientation: 'horizontal',
      insideDiameter: 1000,
      tangentLength: 2000,
      heads: { first: { type: 'torispherical', standard: 'asme_fd' }, second: ellipsoidal },
    };
    data(doc, 'vessel_volume', { ...base, levels: [0, 1000] });
    expectRefusal(doc, 'vessel_volume', { ...base, levels: [500] }, 'EQP_HEAD_NOT_COVERED', 'levels.0');
  });

  it('refuses a level above the inside height and an invalid head, document unchanged', () => {
    const doc = mmDocument();
    const base = {
      orientation: 'horizontal',
      insideDiameter: 1000,
      tangentLength: 2000,
      heads: { first: ellipsoidal, second: ellipsoidal },
    };
    expectRefusal(doc, 'vessel_volume', { ...base, levels: [100, 1001] }, 'EQP_LEVEL_OUT_OF_RANGE', 'levels.1');
    expectRefusal(
      doc,
      'vessel_volume',
      { ...base, heads: { first: { type: 'ellipsoidal' }, second: ellipsoidal } },
      'EQP_HEAD_INVALID',
      'heads.first.ratio',
    );
    expectRefusal(
      doc,
      'vessel_volume',
      { ...base, heads: { first: ellipsoidal, second: { type: 'torispherical', crownRadius: 400, knuckleRadius: 100 } } },
      'EQP_HEAD_INVALID',
      'heads.second.crownRadius',
    );
  });

  it('rejects invalid params through the schema', () => {
    const doc = mmDocument();
    const result = execute(doc, 'vessel_volume', {
      orientation: 'vertical',
      insideDiameter: -1,
      tangentLength: 1,
      heads: { first: ellipsoidal, second: ellipsoidal },
    });
    expect(result.document).toBe(doc);
    expect(result.affected).toEqual([]);
    expect(result.summary).toContain('invalid params');
  });

  it('is pure and deterministic', () => {
    const doc = mmDocument();
    const before = JSON.stringify(doc);
    const params = {
      orientation: 'vertical',
      insideDiameter: 1500,
      tangentLength: 4000,
      heads: { first: ellipsoidal, second: { type: 'conical', halfAngleDeg: 30 } },
      levels: [100, 3000],
    };
    const first = execute(doc, 'vessel_volume', params);
    const second = execute(doc, 'vessel_volume', params);
    expect(JSON.stringify(doc)).toBe(before);
    expect(first.document).toBe(doc);
    expect(first.affected).toEqual([]);
    expect(JSON.stringify(first.data)).toBe(JSON.stringify(second.data));
  });

  it('is registered 1:1 in the tool schemas', () => {
    expect(listCommands().some((command) => command.name === 'vessel_volume')).toBe(true);
    expect(toToolSchemas().some((tool) => tool.name === 'vessel_volume')).toBe(true);
  });
});
