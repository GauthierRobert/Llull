/**
 * Plant 02 RTE V1 part 2: `line_heat_loss` and `set_heat_tracing`. The reference is the ht 1.2.0 / Bergman NPS 3 Sch 40 pipe with 50 mm of insulation
 * (data/insulation_heat_loss.json: 73.120 W/m at 180 / 28 degC, h_o 22.697193, k_steel 56.045, k_ins 0.0598535265) with the CS150 spec row (wall 5.49,
 * ID 77.92): R_s = ln(88.9 / 77.92) / (2 pi 56.045) = 0.131829 / 352.1411 = 3.7437e-4, R_ins = ln(188.9 / 88.9) / (2 pi 0.0598535) = 0.753706 / 0.376071 = 2.004159,
 * R_o = 1 / (22.697193 pi 0.1889) = 0.074241 K m/W; total 2.078775; Q' = 152 / 2.078775 = 73.1200 W/m; outer surface 28 + 73.12 x 0.074241 = 33.4285 degC.
 */

import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { deserializeDocument, serializeDocument } from '@core/commands/persistence/serialization';
import type { CadDocument } from '@core/model/types';
import { heatLossPerMetre } from '@aec/plant/piping/heatLoss';
import { pipingErrors } from '@aec/plant/piping/validate';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectPure } from '../../../helpers/expectNoOp';
import { addTie, cs150Document } from './rteFixtures';

const HOT = { service: 'HO', sequence: '4001', spec: 'CS150', dn: 80, designTempC: 180, insulation: { code: 'H', thickness: 'fromSpec' } };
const INPUT = { fluidTempC: 180, ambientTempC: 28, outsideFilmWm2K: 22.697193, steelConductivityWmK: 56.045 };

interface Loss {
  heatLossWPerM: number;
  surfaceTempC: number;
  steelOuterTempC: number;
  lengthM: number;
  totalHeatLossW: number;
  resistances: { inside: number; steel: number; insulation: number; outside: number; total: number };
  diametersMm: { inside: number; outside: number; envelope: number };
  defaults: Array<{ input: string; assumed: string }>;
  tracing: { type: string; tracers: number; maintainTempC: number | null; heatLossAtMaintainWPerM: number | null } | null;
  reviewRequired: boolean;
  provenance: { formula: string; pipeRow: string };
}

function hotLine(extra: Record<string, unknown> = {}): { doc: CadDocument; lineId: string; runId: string } {
  const a = addTie(cs150Document(), 'TP-H1', [0, 0, 3000], [1, 0, 0], { dn: 80 });
  const b = addTie(a.doc, 'TP-H2', [6000, 0, 3000], [-1, 0, 0], { dn: 80 });
  const created = ok(b.doc, 'create_pipeline', { ...HOT, ...extra });
  const lineId = created.affected[0] as string;
  const doc = apply(created.document, 'route_pipe', { lineId, from: { portId: a.id }, to: { portId: b.id } });
  return { doc, lineId, runId: doc.plant?.piping?.runOrder[0] as string };
}

describe('heatLossPerMetre (the closed form)', () => {
  const base = {
    fluidTempC: 180,
    ambientTempC: 28,
    outsideDiameterMm: 88.9,
    wallMm: 5.49,
    insulationThicknessMm: 50,
    steelConductivityWmK: 56.045,
    insulationConductivityWmK: 0.0598535265,
    outsideFilmWm2K: 22.697193,
    insideFilmWm2K: null,
  } as const;

  it('NPS 3 with 50 mm: 152 / 2.078775 = 73.120 W/m, surface 33.4285 degC, steel outer wall 179.9726 degC', () => {
    const result = heatLossPerMetre(base);
    expect(result.heatLossWPerM).toBeCloseTo(73.12, 3);
    expect(result.surfaceTempC).toBeCloseTo(33.4285, 4);
    expect(result.steelOuterTempC).toBeCloseTo(179.9726, 4);
    expect(result.resistances.steel).toBeCloseTo(3.7437e-4, 7);
    expect(result.resistances.insulation).toBeCloseTo(2.004159, 6);
    expect(result.resistances.outside).toBeCloseTo(0.074241, 6);
    expect(result.resistances.total).toBeCloseTo(2.078775, 6);
    expect(result.diametersMm).toEqual({ inside: 77.92, outside: 88.9, envelope: 188.9 });
  });

  it('an inside film of 1000 W/m2K adds R_i = 1 / (1000 pi 0.07792) = 0.0040851: 152 / 2.082860 = 72.9766 W/m', () => {
    expect(heatLossPerMetre({ ...base, insideFilmWm2K: 1000 }).heatLossWPerM).toBeCloseTo(72.9766, 4);
  });

  it('bare pipe: R_o = 1 / (22.697193 pi 0.0889) = 0.157746, no insulation term: 152 / (0.000374 + 0.157746) = 961.25 W/m', () => {
    const bare = heatLossPerMetre({ ...base, insulationThicknessMm: 0 });
    expect(bare.heatLossWPerM).toBeCloseTo(961.25, 1);
    expect(bare.resistances.insulation).toBe(0);
  });

  it('a cold line gains heat: the sign flips with the temperature difference', () => {
    expect(heatLossPerMetre({ ...base, fluidTempC: -10, ambientTempC: 28 }).heatLossWPerM).toBeLessThan(0);
  });
});

describe('line_heat_loss', () => {
  const s = hotLine();

  it('SC-RTE-07 line: 73.120 W/m through the spec row (k 0.0598535 from H dn<=100 T<=200C), 6 m = 438.72 W, review required', () => {
    const result = data<Loss>(s.doc, 'line_heat_loss', { lineId: s.lineId, ...INPUT });
    expect(result.heatLossWPerM).toBeCloseTo(73.12, 3);
    expect(result.surfaceTempC).toBeCloseTo(33.4285, 4);
    expect(result.lengthM).toBe(6);
    expect(result.totalHeatLossW).toBeCloseTo(438.72, 2);
    expect(result.reviewRequired).toBe(true);
    expect(result.provenance.pipeRow).toContain('CS150');
    expect(result.provenance.formula).toContain('ln(D2/D1)');
  });

  it('names every defaulted input: the inside film (neglected) and the insulation conductivity (the spec row)', () => {
    const { defaults } = data<Loss>(s.doc, 'line_heat_loss', { lineId: s.lineId, ...INPUT });
    expect(defaults.map((entry) => entry.input)).toEqual(['insulationConductivityWmK', 'insideFilmWm2K']);
    expect(defaults[0]?.assumed).toContain('H dn<=100 T<=200C');
    expect(defaults[1]?.assumed).toContain('neglected');
  });

  it('explicit inputs replace the defaults: inside film 1000 and k 0.04 are echoed, nothing is defaulted', () => {
    const result = data<Loss>(s.doc, 'line_heat_loss', {
      lineId: s.lineId,
      ...INPUT,
      insideFilmWm2K: 1000,
      insulationConductivityWmK: 0.04,
    });
    expect(result.defaults).toEqual([]);
    expect(result.resistances.inside).toBeCloseTo(0.0040851, 6);
    expect(result.heatLossWPerM).toBeCloseTo(152 / (0.0040851 + 3.7437e-4 + 0.131829 * 0 + 0.753706 / (2 * Math.PI * 0.04) + 0.074241), 2);
  });

  it('a bare line (no insulation) names it as a default and uses D2 = D1', () => {
    const bare = hotLine({ insulation: undefined });
    const result = data<Loss>(bare.doc, 'line_heat_loss', { lineId: bare.lineId, ...INPUT });
    expect(result.diametersMm.envelope).toBe(88.9);
    expect(result.heatLossWPerM).toBeCloseTo(961.25, 1);
    expect(result.defaults.map((entry) => entry.input)).toContain('insulation');
  });

  it('with a maintain temperature on the tracing it also gives the heat the tracing must supply: 122 / 2.078775 = 58.688 W/m at 150 degC', () => {
    const traced = apply(s.doc, 'set_heat_tracing', { lineId: s.lineId, type: 'electric', tracers: 1, maintainTempC: 150 });
    const result = data<Loss>(traced, 'line_heat_loss', { lineId: s.lineId, ...INPUT });
    expect(result.tracing).toEqual({
      type: 'electric',
      tracers: 1,
      maintainTempC: 150,
      heatLossAtMaintainWPerM: expect.closeTo(58.688, 3),
    });
  });

  it('is pure and read-only', () => {
    expectPure(s.doc, () => execute(s.doc, 'line_heat_loss', { lineId: s.lineId, ...INPUT }));
    expect(execute(s.doc, 'line_heat_loss', { lineId: s.lineId, ...INPUT }).document).toBe(s.doc);
  });

  it('refuses an unknown line, a zero film or conductivity, and an insulation without a conductivity', () => {
    expectRefusal(s.doc, 'line_heat_loss', { lineId: 'line-99', ...INPUT }, 'RTE_UNKNOWN_LINE', 'lineId');
    expectRefusal(s.doc, 'line_heat_loss', { lineId: s.lineId, ...INPUT, outsideFilmWm2K: 0 }, 'RTE_HEAT_LOSS_INPUT', 'outsideFilmWm2K');
    expectRefusal(
      s.doc,
      'line_heat_loss',
      { lineId: s.lineId, ...INPUT, steelConductivityWmK: -1 },
      'RTE_HEAT_LOSS_INPUT',
      'steelConductivityWmK',
    );
    expectRefusal(s.doc, 'line_heat_loss', { lineId: s.lineId, ...INPUT, insideFilmWm2K: 0 }, 'RTE_HEAT_LOSS_INPUT', 'insideFilmWm2K');
    const explicit = hotLine({ designTempC: undefined, insulation: { code: 'H', thickness: 40 } });
    expectRefusal(
      explicit.doc,
      'line_heat_loss',
      { lineId: explicit.lineId, ...INPUT },
      'RTE_SPEC_NO_COMPONENT',
      'insulationConductivityWmK',
    );
    const given = data<Loss>(explicit.doc, 'line_heat_loss', {
      lineId: explicit.lineId,
      ...INPUT,
      insulationConductivityWmK: 0.0598535265,
    });
    expect(given.diametersMm.envelope).toBe(168.9);
  });
});

describe('set_heat_tracing', () => {
  const s = hotLine();

  it('records the tracing on the line (data only: the run and its entities are untouched)', () => {
    const result = ok(s.doc, 'set_heat_tracing', {
      lineId: s.lineId,
      type: 'steam',
      tracers: 2,
      maintainTempC: 120,
      allowances: { valveM: 1.5, flangeM: 0.5, supportM: 0.25 },
    });
    expect(result.affected[0]).toBe(s.lineId);
    expect(result.document.plant?.piping?.lines[s.lineId]?.tracing).toEqual({
      type: 'steam',
      tracers: 2,
      maintainTempC: 120,
      allowances: { valveM: 1.5, flangeM: 0.5, supportM: 0.25 },
    });
    expect(result.document.plant?.piping?.runs).toEqual(s.doc.plant?.piping?.runs);
    expect(result.document.entities).toEqual(s.doc.entities);
  });

  it('later calls change single fields; the same values are a no-op; remove deletes the tracing', () => {
    const first = apply(s.doc, 'set_heat_tracing', { lineId: s.lineId, type: 'electric', tracers: 1 });
    const second = apply(first, 'set_heat_tracing', { lineId: s.lineId, tracers: 3, maintainTempC: 90 });
    expect(second.plant?.piping?.lines[s.lineId]?.tracing).toEqual({ type: 'electric', tracers: 3, maintainTempC: 90 });
    const same = execute(second, 'set_heat_tracing', { lineId: s.lineId, tracers: 3 });
    expect(same.document).toBe(second);
    expect(same.summary).toContain('already');
    const removed = apply(second, 'set_heat_tracing', { lineId: s.lineId, remove: true });
    expect(removed.plant?.piping?.lines[s.lineId]?.tracing).toBeUndefined();
    expect(execute(removed, 'set_heat_tracing', { lineId: s.lineId, remove: true }).document).toBe(removed);
  });

  it('refuses an unknown line, a first setting without type or tracers, and out-of-range tracers (params)', () => {
    expectRefusal(s.doc, 'set_heat_tracing', { lineId: 'line-99', type: 'electric', tracers: 1 }, 'RTE_UNKNOWN_LINE', 'lineId');
    expectRefusal(s.doc, 'set_heat_tracing', { lineId: s.lineId, type: 'electric' }, 'RTE_TRACING_INVALID', 'tracers');
    expectRefusal(s.doc, 'set_heat_tracing', { lineId: s.lineId, tracers: 2 }, 'RTE_TRACING_INVALID', 'type');
    const invalid = execute(s.doc, 'set_heat_tracing', { lineId: s.lineId, type: 'electric', tracers: 9 });
    expect(invalid.rejected).toBe(true);
    expect(invalid.document).toBe(s.doc);
  });

  it('is pure; the tracing survives a save and load; a malformed record is refused on load', () => {
    expectPure(s.doc, () => execute(s.doc, 'set_heat_tracing', { lineId: s.lineId, type: 'electric', tracers: 1 }));
    const traced = apply(s.doc, 'set_heat_tracing', {
      lineId: s.lineId,
      type: 'hot_water',
      tracers: 2,
      allowances: { valveM: 1, flangeM: 1, supportM: 1 },
    });
    expect(deserializeDocument(serializeDocument(traced)).plant?.piping?.lines[s.lineId]?.tracing?.type).toBe('hot_water');
    const piping = JSON.parse(JSON.stringify(traced.plant?.piping)) as { lines: Record<string, { tracing: unknown }> };
    (piping.lines[s.lineId] as { tracing: unknown }).tracing = { type: 'laser', tracers: 0 };
    expect(pipingErrors(piping).join(' ')).toContain('.tracing must be');
  });

  it('piping_takeoff lists the tracer length: 2 tracers x (6 m + 3 supports x 0.25 m) = 13.5 m, with the allowances it used', () => {
    const traced = apply(s.doc, 'set_heat_tracing', {
      lineId: s.lineId,
      type: 'electric',
      tracers: 2,
      allowances: { valveM: 1.5, flangeM: 0.5, supportM: 0.25 },
    });
    const beams = [500, 3000, 5500].reduce(
      (doc, x) => apply(doc, 'add_steel_member', { role: 'beam', start: [x, -1000, 2830], end: [x, 1000, 2830], profile: 'IPE200' }),
      traced,
    );
    const supported = apply(beams, 'add_pipe_support', { runId: s.runId, spacing: 3000 });
    const takeoff = data<{ tracing: Array<Record<string, unknown>>; supports: Record<string, number> }>(supported, 'piping_takeoff', {});
    expect(takeoff.supports).toEqual({ [s.runId]: 3 });
    expect(takeoff.tracing).toEqual([
      expect.objectContaining({
        lineId: s.lineId,
        tracers: 2,
        centrelineM: 6,
        valves: 0,
        flanges: 0,
        supports: 3,
        allowances: { valveM: 1.5, flangeM: 0.5, supportM: 0.25 },
        tracerLengthM: 13.5,
      }),
    ]);
    const without = data<{ tracing: Array<{ tracerLengthM: number; allowances: unknown }> }>(
      apply(s.doc, 'set_heat_tracing', { lineId: s.lineId, type: 'electric', tracers: 2 }),
      'piping_takeoff',
      {},
    );
    expect(without.tracing[0]).toMatchObject({ tracerLengthM: 12, allowances: null });
  });
});
