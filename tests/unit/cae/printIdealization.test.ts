/**
 * 14 FLL-M3: set_print_idealization, record_print_coupon, fit_print_infill_exponent and the homogenised orthotropic deck of a printed part.
 * Oracles: infill density 1 recovers the solid coupon moduli exactly; a power law sampled at known (C, m) is recovered by the fit to the ulp;
 * the E_z / E_xy ratio of the coupons survives every infill density; the skin fraction of a box is the hand sum of face area x thickness / volume.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { PrintIdealization } from '@core/model/printIdealization';
import { writeInp } from '@cae/decks/inpWriter';
import { printAxes } from '@cae/flightLoads/print/deck';
import { fitPowerLaw, homogenise, isStable, skinEstimate } from '@cae/flightLoads/print/homogenize';
import { printErrors } from '@cae/flightLoads/print/validate';
import { buildDeckContext } from '@cae/decks/context';
import { analysisInputHash } from '@cae/hash/inputHash';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { X0_NODES, barDocument, barMesh, mustRun } from './deckFixtures';
import { GPa, MPa, NL1_VALIDITY, ONE, T293, addModel, defineSet } from '../physics/materials/materialFixtures';
import { BAR_PRINT, COUPON_SOURCE, SOLID_COUPON, printedBar, recordCoupon } from './printFixtures';

const bar = barDocument();
const print = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  analysisId: bar.analysisId,
  entityId: bar.boxId,
  ...BAR_PRINT,
  ...overrides,
});
const codeOf = (result: ReturnType<typeof execute>): string | undefined => result.error?.code;

describe('fitPowerLaw (oracle: data sampled from E = C density^m)', () => {
  const sample = (C: number, m: number, densities: number[]): { density: number; modulus: number }[] =>
    densities.map((density) => ({ density, modulus: C * density ** m }));

  it('recovers C and m of exact data with zero residual, for 2 and for 5 densities', () => {
    for (const densities of [
      [0.2, 0.6],
      [0.15, 0.25, 0.4, 0.7, 1],
    ]) {
      const fit = fitPowerLaw(sample(1850, 1.73, densities));
      if (typeof fit === 'string') throw new Error(fit);
      expect(fit.m).toBeCloseTo(1.73, 12);
      expect(fit.C).toBeCloseTo(1850, 8);
      expect(fit.rmsLogResidual).toBeLessThan(1e-12);
      expect(fit.maxRelativeResidual).toBeLessThan(1e-11);
      expect(fit.points).toBe(densities.length);
    }
  });

  it('reports a non-zero residual for data off the law (least squares, not interpolation)', () => {
    const noisy = sample(2000, 1.5, [0.2, 0.4, 0.6, 0.8]).map((p, i) => ({ ...p, modulus: p.modulus * (i % 2 === 0 ? 1.05 : 0.95) }));
    const fit = fitPowerLaw(noisy);
    if (typeof fit === 'string') throw new Error(fit);
    expect(fit.rmsLogResidual).toBeGreaterThan(0.01);
    expect(fit.rSquared).toBeLessThan(1);
  });

  it('refuses fewer than 2 points, one repeated density and invalid values', () => {
    expect(fitPowerLaw([{ density: 0.5, modulus: 1000 }])).toMatch(/at least 2/);
    expect(fitPowerLaw([])).toMatch(/at least 2/);
    expect(fitPowerLaw(sample(1000, 1, [0.5, 0.5]))).toMatch(/distinct/);
    expect(
      fitPowerLaw([
        { density: 1.5, modulus: 10 },
        { density: 0.5, modulus: 5 },
      ]),
    ).toMatch(/density in \(0, 1\]/);
    expect(
      fitPowerLaw([
        { density: 0.5, modulus: -1 },
        { density: 0.2, modulus: 5 },
      ]),
    ).toMatch(/modulus > 0/);
  });
});

describe('homogenise and skinEstimate', () => {
  const base: PrintIdealization = {
    walls: 2,
    lineWidthMm: 0.4,
    layerHeightMm: 0.2,
    topBottomLayers: 3,
    infill: { pattern: 'grid', density: 1 },
    layerAxis: [0, 0, 1],
    coupon: { E_xyMpa: 2000, E_zMpa: 1500, uts_xyMpa: 30, uts_zMpa: 20, source: COUPON_SOURCE },
    exponent: { value: 1.6, basis: 'given', source: { citation: 'x' } },
  };

  it('infill density 1 recovers the solid coupon moduli exactly, whatever the skin and exponent', () => {
    for (const f of [0, 0.3, 1]) {
      const part = homogenise(base, 0.35, f);
      expect(part.E1).toBe(2000);
      expect(part.E2).toBe(2000);
      expect(part.E3).toBe(1500);
      expect(part.densityRatio).toBe(1);
    }
  });

  it('keeps the E_z / E_xy ratio of the coupons at every density and gives the core law with no skin', () => {
    const part = homogenise({ ...base, infill: { pattern: 'grid', density: 0.3 } }, 0.35, 0);
    expect(part.E3 / part.E1).toBeCloseTo(0.75, 14);
    expect(part.E1).toBeCloseTo(2000 * 0.3 ** 1.6, 9);
    expect(part.densityRatio).toBe(0.3);
    expect(part.coreFactor).toBeCloseTo(0.3 ** 1.6, 14);
  });

  it('mixes skin and core in parallel', () => {
    const part = homogenise({ ...base, infill: { pattern: 'grid', density: 0.5 } }, 0.3, 0.25);
    expect(part.E1).toBeCloseTo(2000 * (0.25 + 0.75 * 0.5 ** 1.6), 9);
    expect(part.G12).toBeCloseTo(part.E1 / 2.6, 9);
    expect(part.G13).toBeCloseTo(part.E3 / 2.6, 9);
    expect(isStable(part)).toBe(true);
  });

  it('flags a Poisson ratio too large for the modulus gap as unstable', () => {
    expect(isStable(homogenise({ ...base, coupon: { ...base.coupon, E_zMpa: 40000 } }, 0.49, 0.2))).toBe(false);
  });

  type Corner = readonly [number, number, number];
  const box = (x: number, y: number, z: number): (readonly [Corner, Corner, Corner])[] => {
    const v = (i: number, j: number, k: number): Corner => [i * x, j * y, k * z];
    const quads: Corner[][] = [
      [v(0, 0, 0), v(0, 1, 0), v(1, 1, 0), v(1, 0, 0)],
      [v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)],
      [v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)],
      [v(0, 1, 0), v(0, 1, 1), v(1, 1, 1), v(1, 1, 0)],
      [v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)],
      [v(1, 0, 0), v(1, 1, 0), v(1, 1, 1), v(1, 0, 1)],
    ];
    return quads.flatMap(([a, b, c, d]) => [[a!, b!, c!] as const, [a!, c!, d!] as const]);
  };

  it('is the hand sum of face area x thickness over the volume for a 2 x 1 x 1 box', () => {
    // axis z: sides 2 x (1 x 1) + 2 x (2 x 1) = 6 mm^2 x 0.1 wall; top and bottom 2 x 2 mm^2 x 0.1 layer; volume 2 -> (0.6 + 0.4) / 2
    const skin = skinEstimate(box(2, 1, 1), [0, 0, 1], 0.1, 0.1);
    expect(skin?.volume).toBeCloseTo(2, 12);
    expect(skin?.fraction).toBeCloseTo(0.5, 12);
    // axis x: the two 1 x 1 end faces x 0.3 layer = 0.6; the four 2 x 1 side faces = 8 mm^2 x 0.1 wall = 0.8 -> (0.6 + 0.8) / 2
    expect(skinEstimate(box(2, 1, 1), [1, 0, 0], 0.1, 0.3)?.fraction).toBeCloseTo((0.6 + 0.8) / 2, 12);
  });

  it('caps at 1 for a skin thicker than the part and refuses a part without volume', () => {
    expect(skinEstimate(box(1, 1, 1), [0, 0, 1], 5, 5)?.fraction).toBe(1);
    expect(skinEstimate([], [0, 0, 1], 1, 1)).toBeNull();
  });
});

describe('printAxes (oracle: axis1 x axis2 = the build direction)', () => {
  it('is orthonormal and 3 = layerAxis for z, x and an oblique axis', () => {
    for (const axis of [
      [0, 0, 1],
      [1, 0, 0],
      [1, 1, 1],
      [0, -1, 0],
    ] as const) {
      const { axis1, axis2 } = printAxes(axis);
      const unit = Math.hypot(...axis);
      const third = [
        axis1[1] * axis2[2] - axis1[2] * axis2[1],
        axis1[2] * axis2[0] - axis1[0] * axis2[2],
        axis1[0] * axis2[1] - axis1[1] * axis2[0],
      ];
      third.forEach((component, i) => expect(component).toBeCloseTo(axis[i]! / unit, 12));
      expect(axis1[0] * axis2[0] + axis1[1] * axis2[1] + axis1[2] * axis2[2]).toBeCloseTo(0, 12);
      expect(Math.hypot(...axis1)).toBeCloseTo(1, 12);
    }
  });
});

describe('record_print_coupon', () => {
  const params = {
    id: 'c1',
    pattern: 'gyroid',
    infillDensity: 0.25,
    direction: 'xy',
    modulus: { value: 1.2, unit: 'GPa' },
    uts: { value: 15, unit: 'MPa' },
    source: COUPON_SOURCE,
  };

  it('records the coupon in MPa in recording order', () => {
    const result = execute(bar.doc, 'record_print_coupon', params);
    expect(result.affected).toEqual(['c1']);
    expect(result.document.analysis?.printCoupons?.['c1']).toMatchObject({
      modulusMpa: 1200,
      utsMpa: 15,
      infillDensity: 0.25,
      direction: 'xy',
    });
    const second = execute(result.document, 'record_print_coupon', { ...params, id: 'c2' });
    expect(second.document.analysis?.printCouponOrder).toEqual(['c1', 'c2']);
    expect(second.summary).toContain('2 coupon(s)');
  });

  it('refuses a duplicate id unless replace, an empty citation, a reserved id and a bad unit or value', () => {
    const doc = execute(bar.doc, 'record_print_coupon', params).document;
    const duplicate = execute(doc, 'record_print_coupon', params);
    expect(codeOf(duplicate)).toBe('FLL_PRINT_COUPON_EXISTS');
    expectNoOp(duplicate, doc);
    const replaced = execute(doc, 'record_print_coupon', { ...params, modulus: { value: 1100, unit: 'MPa' }, replace: true });
    expect(replaced.document.analysis?.printCoupons?.['c1']?.modulusMpa).toBe(1100);
    expect(replaced.document.analysis?.printCouponOrder).toEqual(['c1']);
    const noSource = execute(doc, 'record_print_coupon', { ...params, id: 'c9', source: { citation: '  ' } });
    expect(codeOf(noSource)).toBe('FLL_PRINT_PARAM');
    expectNoOp(noSource, doc);
    expect(codeOf(execute(doc, 'record_print_coupon', { ...params, id: '__proto__' }))).toBe('CMD_RESERVED_ID');
    expect(codeOf(execute(doc, 'record_print_coupon', { ...params, id: 'c8', modulus: { value: 3, unit: 'mm' } }))).toBe('FLL_PRINT_PARAM');
    expect(codeOf(execute(doc, 'record_print_coupon', { ...params, id: 'c8', modulus: { value: -3, unit: 'MPa' } }))).toBe(
      'FLL_PRINT_PARAM',
    );
    expect(codeOf(execute(doc, 'record_print_coupon', { ...params, id: 'c8', uts: { value: 1, unit: 'kg' } }))).toBe('FLL_PRINT_PARAM');
  });

  it('is pure', () => {
    expectPure(bar.doc, () => execute(bar.doc, 'record_print_coupon', params));
  });
});

describe('fit_print_infill_exponent', () => {
  const withCoupons = (): ReturnType<typeof recordCoupon> => {
    let doc = bar.doc;
    for (const [i, density] of [0.2, 0.4, 0.7].entries()) doc = recordCoupon(doc, `xy${i}`, density, 'xy', 2000 * density ** 1.4);
    doc = recordCoupon(doc, 'z0', 0.3, 'z', 900);
    return recordCoupon(doc, 'g0', 0.5, 'xy', 100, 'grid');
  };

  it('fits only the coupons of the pattern and direction and reports the fit and its residual', () => {
    const result = execute(withCoupons(), 'fit_print_infill_exponent', { pattern: 'gyroid', direction: 'xy' });
    const data = result.data as {
      m: number;
      C: number;
      couponIds: string[];
      rmsLogResidual: number;
      residuals: unknown[];
      warning: string | null;
    };
    expect(data.couponIds).toEqual(['xy0', 'xy1', 'xy2']);
    expect(data.m).toBeCloseTo(1.4, 12);
    expect(data.C).toBeCloseTo(2000, 8);
    expect(data.rmsLogResidual).toBeLessThan(1e-12);
    expect(data.residuals).toHaveLength(3);
    expect(data.warning).toBeNull();
    expect(result.affected).toEqual([]);
  });

  it('refuses with fewer than 2 coupons of the pattern and direction (FLL_PRINT_FIT_POINTS)', () => {
    const doc = withCoupons();
    for (const [pattern, direction] of [
      ['gyroid', 'z'],
      ['grid', 'xy'],
      ['honeycomb', 'xy'],
    ] as const) {
      const result = execute(doc, 'fit_print_infill_exponent', { pattern, direction });
      expect(codeOf(result)).toBe('FLL_PRINT_FIT_POINTS');
      expectNoOp(result, doc);
    }
  });

  it('warns that two coupons fit exactly', () => {
    let doc = recordCoupon(bar.doc, 'a', 0.2, 'xy', 300);
    doc = recordCoupon(doc, 'b', 0.6, 'xy', 1200);
    const data = execute(doc, 'fit_print_infill_exponent', { pattern: 'gyroid', direction: 'xy' }).data as { warning: string };
    expect(data.warning).toMatch(/two coupons/);
  });
});

describe('set_print_idealization', () => {
  it('stores the print on the case, normalises the axis, converts the coupon to MPa and reports the homogenised constants', () => {
    const result = execute(bar.doc, 'set_print_idealization', print({ layerAxis: [0, 0, 4] }));
    expect(result.affected).toEqual([bar.analysisId]);
    const stored = result.document.analysis?.cases[bar.analysisId]?.printed?.[bar.boxId];
    expect(stored?.layerAxis).toEqual([0, 0, 1]);
    expect(stored?.coupon).toMatchObject({ E_xyMpa: 2000, E_zMpa: 1500, uts_xyMpa: 30, uts_zMpa: 20 });
    expect(stored?.exponent).toMatchObject({ value: 1.5, basis: 'given' });
    const data = result.data as {
      skinFraction: number;
      effective: { E_xy: number; E_z: number; densityRatio: number };
      ratioEzOverExy: number;
      unverified: boolean;
      strengths: { homogenised: boolean };
    };
    expect(data.skinFraction).toBeCloseTo(0.5, 12);
    expect(data.effective.E_xy).toBeCloseTo(2000 * (0.5 + 0.5 * 0.4 ** 1.5), 9);
    expect(data.effective.densityRatio).toBeCloseTo(0.5 + 0.5 * 0.4, 12);
    expect(data.ratioEzOverExy).toBeCloseTo(0.75, 12);
    expect(data.unverified).toBe(true);
    expect(data.strengths.homogenised).toBe(false);
    expect(result.document.order).toEqual(bar.doc.order);
  });

  it('makes the full analysis hash differ (a solve input, not a mesh input) and clear restores it', () => {
    const printed = execute(bar.doc, 'set_print_idealization', print()).document;
    expect(analysisInputHash(printed, bar.analysisId, 'full')).not.toBe(analysisInputHash(bar.doc, bar.analysisId, 'full'));
    expect(analysisInputHash(printed, bar.analysisId, 'mesh')).toBe(analysisInputHash(bar.doc, bar.analysisId, 'mesh'));
    const cleared = execute(printed, 'set_print_idealization', { analysisId: bar.analysisId, entityId: bar.boxId, clear: true });
    expect(cleared.document.analysis?.cases[bar.analysisId]?.printed).toBeUndefined();
    expect(analysisInputHash(cleared.document, bar.analysisId, 'full')).toBe(analysisInputHash(bar.doc, bar.analysisId, 'full'));
  });

  it('fits the exponent from the recorded coupons of the infill pattern (basis fit, solid mismatch warning)', () => {
    let doc = bar.doc;
    for (const [i, density] of [0.2, 0.5, 0.8].entries()) doc = recordCoupon(doc, `c${i}`, density, 'xy', 1000 * density ** 1.8);
    const result = execute(doc, 'set_print_idealization', print({ infillExponent: { fitDirection: 'xy' } }));
    const stored = result.document.analysis?.cases[bar.analysisId]?.printed?.[bar.boxId];
    expect(stored?.exponent.basis).toBe('fit');
    expect(stored?.exponent.value).toBeCloseTo(1.8, 12);
    expect(stored?.exponent.source.citation).toContain('c0, c1, c2');
    const data = result.data as { warnings: string[]; fit: { m: number } };
    expect(data.fit.m).toBeCloseTo(1.8, 12);
    expect(data.warnings.join(' ')).toMatch(/differs .* % from the solid coupon/);
  });

  it('refuses the missing coupon with FLL_PRINT_COUPON_MISSING and invents no typical values', () => {
    const { coupon, ...rest } = print();
    void coupon;
    const result = execute(bar.doc, 'set_print_idealization', rest);
    expect(codeOf(result)).toBe('FLL_PRINT_COUPON_MISSING');
    expect(result.error?.remediation).toMatch(/no typical/);
    expectNoOp(result, bar.doc);
  });

  it('refuses a missing exponent, both exponent forms, a missing exponent source and a fit without 2 coupons', () => {
    const { infillExponent, ...rest } = print();
    void infillExponent;
    expect(codeOf(execute(bar.doc, 'set_print_idealization', rest))).toBe('FLL_PRINT_EXPONENT_MISSING');
    expect(codeOf(execute(bar.doc, 'set_print_idealization', print({ infillExponent: {} })))).toBe('FLL_PRINT_EXPONENT_MISSING');
    expect(codeOf(execute(bar.doc, 'set_print_idealization', print({ infillExponent: { value: 1.5, fitDirection: 'xy' } })))).toBe(
      'FLL_PRINT_PARAM',
    );
    expect(codeOf(execute(bar.doc, 'set_print_idealization', print({ infillExponent: { value: 1.5 } })))).toBe('FLL_PRINT_PARAM');
    const fit = execute(bar.doc, 'set_print_idealization', print({ infillExponent: { fitDirection: 'z' } }));
    expect(codeOf(fit)).toBe('FLL_PRINT_FIT_POINTS');
    expectNoOp(fit, bar.doc);
  });

  it('refuses a fitted exponent that is not positive', () => {
    let doc = recordCoupon(bar.doc, 'a', 0.2, 'xy', 1500);
    doc = recordCoupon(doc, 'b', 0.8, 'xy', 500);
    expect(codeOf(execute(doc, 'set_print_idealization', print({ infillExponent: { fitDirection: 'xy' } })))).toBe('FLL_PRINT_PARAM');
  });

  it('refuses unknown analysis, wrong case type, a part not in the case, missing settings, bad coupon units and a zero axis', () => {
    expect(codeOf(execute(bar.doc, 'set_print_idealization', print({ analysisId: 'nope' })))).toBe('FEA_ANALYSIS_NOT_FOUND');
    const thermal = barDocument({ analysisType: 'thermo_static' });
    expect(codeOf(execute(thermal.doc, 'set_print_idealization', print({ analysisId: thermal.analysisId, entityId: thermal.boxId })))).toBe(
      'FLL_PRINT_CASE_TYPE',
    );
    expect(codeOf(execute(bar.doc, 'set_print_idealization', print({ entityId: 'ghost' })))).toBe('FEA_PART_NOT_IN_ANALYSIS');
    const { walls, ...rest } = print();
    void walls;
    expect(codeOf(execute(bar.doc, 'set_print_idealization', rest))).toBe('FLL_PRINT_PARAM');
    expect(codeOf(execute(bar.doc, 'set_print_idealization', print({ coupon: { ...SOLID_COUPON, E_z: { value: 1, unit: 'kg' } } })))).toBe(
      'FLL_PRINT_PARAM',
    );
    expect(codeOf(execute(bar.doc, 'set_print_idealization', print({ coupon: { ...SOLID_COUPON, E_z: { value: 0, unit: 'MPa' } } })))).toBe(
      'FLL_PRINT_PARAM',
    );
    expect(codeOf(execute(bar.doc, 'set_print_idealization', print({ coupon: { ...SOLID_COUPON, source: { citation: ' ' } } })))).toBe(
      'FLL_PRINT_PARAM',
    );
    expect(codeOf(execute(bar.doc, 'set_print_idealization', print({ layerAxis: [0, 0, 0] })))).toBe('FLL_PRINT_PARAM');
  });

  it('refuses a part without a material and constants that are not positive definite', () => {
    const bare = barDocument({ material: 'none' });
    expect(codeOf(execute(bare.doc, 'set_print_idealization', print({ analysisId: bare.analysisId, entityId: bare.boxId })))).toBe(
      'FEA_MATERIAL_MISSING',
    );
    const soft = execute(
      bar.doc,
      'set_print_idealization',
      print({ coupon: { ...SOLID_COUPON, E_z: { value: 40, unit: 'GPa' } }, walls: 0, topBottomLayers: 0 }),
    );
    expect(codeOf(soft)).toBe('FLL_PRINT_STIFFNESS');
    expectNoOp(soft, bar.doc);
  });

  it('is pure', () => {
    expectPure(bar.doc, () => execute(bar.doc, 'set_print_idealization', print()));
  });
});

describe('the deck of a printed part', () => {
  const fixture = printedBar();
  const sets = (c: Record<string, string>): Record<string, number[]> => ({
    [`C_${c['x0']}`]: X0_NODES,
    [`C_${c['nodeA']}`]: [1],
    [`C_${c['nodeB']}`]: [3],
  });
  const meshOf = (b: typeof fixture): ReturnType<typeof barMesh> => barMesh(b.printed, b.analysisId, b.boxId, sets(b.constraints));
  const mesh = meshOf(fixture);
  const deckText = (doc = fixture.printed, m = mesh): string => {
    const deck = writeInp(doc, fixture.analysisId, m);
    if ('code' in deck) throw new Error(`${deck.code}: ${deck.message}`);
    return deck.text;
  };

  it('writes engineering constants, the effective density and the orientation of a build direction along z', () => {
    const f = 0.5;
    const core = 0.4 ** 1.5;
    const exy = 2000 * (f + (1 - f) * core);
    const ez = 1500 * (f + (1 - f) * core);
    const text = deckText();
    const lines = text.split('\n');
    const at = lines.indexOf('*ELASTIC, TYPE=ENGINEERING CONSTANTS');
    expect(at).toBeGreaterThan(0);
    const first = lines[at + 1]!.split(',').map(Number);
    expect(first[0]).toBeCloseTo(exy, 6);
    expect(first[1]).toBeCloseTo(exy, 6);
    expect(first[2]).toBeCloseTo(ez, 6);
    expect(first.slice(3, 6)).toEqual([0.3, 0.3, 0.3]);
    expect(first[6]).toBeCloseTo(exy / 2.6, 6);
    expect(first[7]).toBeCloseTo(ez / 2.6, 6);
    expect(Number(lines[at + 2])).toBeCloseTo(ez / 2.6, 6);
    expect(lines[at + 3]).toBe('*DENSITY');
    expect(Number(lines[at + 4])).toBeCloseTo(7.85e-9 * (f + (1 - f) * 0.4), 18);
    expect(text).toMatch(/\*ORIENTATION, NAME=OR_PRT_\w+, SYSTEM=RECTANGULAR\n1, 0, 0, 0, 1, 0\n/);
    expect(text).toMatch(/\*SOLID SECTION, ELSET=P_\S+, MATERIAL=M_1, ORIENTATION=OR_PRT_/);
    expect(text).toContain('** UNVERIFIED:');
  });

  it('rotates the material axes with the build direction (x build: direction 3 is x)', () => {
    const along = printedBar({ layerAxis: [1, 0, 0] });
    const deck = deckText(along.printed, meshOf(along));
    const row = /SYSTEM=RECTANGULAR\n(.*)\n/.exec(deck)?.[1]?.split(',').map(Number) ?? [];
    // axis1 = y (the document axis least aligned with x), axis2 = x cross y = z: their cross product is x
    expect(row.map((v) => Math.abs(v))).toEqual([0, 1, 0, 0, 0, 1]);
  });

  it('infill 1 writes the solid coupon moduli (oracle: density 1 recovers the coupon)', () => {
    const solid = printedBar({ infill: { pattern: 'gyroid', density: 1 } });
    const deck = deckText(solid.printed, meshOf(solid));
    expect(deck).toMatch(
      /\*ELASTIC, TYPE=ENGINEERING CONSTANTS\n2000, 2000, 1500, 0\.3, 0\.3, 0\.3, 769\.230769231, 576\.923076923\n576\.923076923\n\*DENSITY\n7\.85e-9/,
    );
  });

  it('a solid part of the same material keeps its own isotropic *MATERIAL (the M_ names do not collide)', () => {
    const box = execute(fixture.printed, 'add_box', { size: [1, 1, 1] });
    const second = box.affected[0] ?? '';
    let doc = mustRun(box.document, 'assign_material', { materialName: 'steel', entityIds: [second] });
    doc = mustRun(doc, 'set_part_idealization', { analysisId: fixture.analysisId, entityId: second });
    const ctx = buildDeckContext(doc, fixture.analysisId, mesh);
    expect([ctx?.materialName(fixture.boxId), ctx?.materialName(second)]).toEqual(['M_1', 'M_2']);
    const cleared = mustRun(doc, 'set_print_idealization', { analysisId: fixture.analysisId, entityId: fixture.boxId, clear: true });
    const plain = buildDeckContext(cleared, fixture.analysisId, mesh);
    expect([plain?.materialName(fixture.boxId), plain?.materialName(second)]).toEqual(['M_1', 'M_1']);
  });

  it('refuses a printed part whose material also has a plastic set (FLL_PRINT_CONSTITUTIVE)', () => {
    let doc = addModel(
      fixture.printed,
      'steel',
      'elasticv',
      { kind: 'elastic_isotropic', E: GPa(210), nu: ONE(0.3) },
      { validity: T293, basis: 'A' },
    );
    doc = addModel(
      doc,
      'steel',
      'j2',
      { kind: 'j2_plasticity', isotropic: { kind: 'perfect', yieldStress: MPa(100) }, kinematic: { kind: 'none' } },
      { validity: NL1_VALIDITY, basis: 'A' },
    );
    doc = defineSet(doc, 'steel', { id: 'nl', elastic: 'elasticv', plastic: 'j2' }, true);
    const deck = writeInp(doc, fixture.analysisId, { ...mesh, inputHash: analysisInputHash(doc, fixture.analysisId, 'mesh') });
    expect('code' in deck && deck.code).toBe('FLL_PRINT_CONSTITUTIVE');
  });
});

describe('load validation of printed data', () => {
  const printed = printedBar().printed;
  type Bag = Record<string, unknown>;
  const rawOf = (doc: unknown): Bag => JSON.parse(JSON.stringify(doc)) as Bag;
  const dig = (root: unknown, ...path: string[]): Bag => path.reduce<unknown>((node, key) => (node as Bag)[key], root) as Bag;
  const errorsAfter = (doc: unknown, edit: (analysis: Bag) => void): string => {
    const raw = rawOf(doc);
    edit(dig(raw, 'analysis'));
    return printErrors(raw).join('\n');
  };
  const withCoupon = recordCoupon(printed, 'c1', 0.3, 'xy', 800);
  const caseId = Object.keys(dig(rawOf(printed), 'analysis', 'cases'))[0] ?? '';
  const printedOf = (analysis: Bag): Bag => dig(analysis, 'cases', caseId, 'printed');
  const part = (analysis: Bag): Bag => Object.values(printedOf(analysis))[0] as Bag;

  it('accepts a valid slice and a document without analysis', () => {
    expect(printErrors(rawOf(withCoupon))).toEqual([]);
    expect(printErrors({})).toEqual([]);
  });

  it('refuses every malformed field of the print, naming the path', () => {
    const cases: [string, (analysis: Bag) => void, RegExp][] = [
      ['walls', (a) => (part(a)['walls'] = 1.5), /walls/],
      ['line width', (a) => (part(a)['lineWidthMm'] = 0), /lineWidthMm/],
      ['layer height', (a) => (part(a)['layerHeightMm'] = 'x'), /layerHeightMm/],
      ['top layers', (a) => (part(a)['topBottomLayers'] = -1), /topBottomLayers/],
      ['infill', (a) => (part(a)['infill'] = { pattern: 'x', density: 0.5 }), /infill/],
      ['infill density', (a) => (part(a)['infill'] = { pattern: 'grid', density: 1.2 }), /infill/],
      ['axis', (a) => (part(a)['layerAxis'] = [0, 0, 2]), /layerAxis/],
      ['coupon', (a) => (part(a)['coupon'] = { E_xyMpa: 1 }), /coupon/],
      ['coupon source', (a) => (dig(part(a), 'coupon')['source'] = { citation: '' }), /coupon.source.citation/],
      ['source field', (a) => (dig(part(a), 'coupon', 'source')['url'] = 4), /source.url/],
      ['exponent', (a) => (part(a)['exponent'] = { value: -1, basis: 'given', source: { citation: 'x' } }), /exponent/],
      ['exponent basis', (a) => (dig(part(a), 'exponent')['basis'] = 'typical'), /exponent/],
      ['exponent source', (a) => (dig(part(a), 'exponent')['source'] = {}), /exponent.source/],
      ['record', (a) => (printedOf(a)[Object.keys(printedOf(a))[0] ?? ''] = 4), /must be a record/],
      ['printed type', (a) => (dig(a, 'cases', caseId)['printed'] = []), /printed must be a record/],
      ['case type', (a) => (dig(a, 'cases', caseId)['type'] = 'heat_steady'), /static, modal and buckling/],
      ['not a part', (a) => (printedOf(a)['ghost'] = part(a)), /not a solid part/],
      ['reserved', (a) => Object.defineProperty(printedOf(a), '__proto__', { value: part(a), enumerable: true }), /reserved/],
    ];
    for (const [label, edit, pattern] of cases) expect(errorsAfter(printed, edit), label).toMatch(pattern);
  });

  it('refuses malformed coupons and an inconsistent coupon order', () => {
    const edit = (change: (analysis: Bag) => void): string => errorsAfter(withCoupon, change);
    const coupon = (analysis: Bag): Bag => dig(analysis, 'printCoupons', 'c1');
    expect(edit((a) => (coupon(a)['id'] = 'other'))).toMatch(/id must equal its key/);
    expect(edit((a) => (coupon(a)['pattern'] = 'zig'))).toMatch(/pattern/);
    expect(edit((a) => (coupon(a)['infillDensity'] = 0))).toMatch(/infillDensity/);
    expect(edit((a) => (coupon(a)['direction'] = 'q'))).toMatch(/direction/);
    expect(edit((a) => (coupon(a)['modulusMpa'] = -5))).toMatch(/modulusMpa/);
    expect(edit((a) => (coupon(a)['utsMpa'] = 'x'))).toMatch(/utsMpa/);
    expect(edit((a) => (coupon(a)['source'] = {}))).toMatch(/citation/);
    expect(edit((a) => (dig(a, 'printCoupons')['c1'] = 7))).toMatch(/must be a record/);
    expect(edit((a) => (a['printCouponOrder'] = []))).toMatch(/missing from printCouponOrder/);
    expect(edit((a) => (a['printCouponOrder'] = ['c1', 'c1']))).toMatch(/twice/);
    expect(edit((a) => (a['printCouponOrder'] = ['c1', 'c2']))).toMatch(/no coupon/);
    expect(edit((a) => delete a['printCouponOrder'])).toMatch(/expected a record/);
    expect(edit((a) => Object.defineProperty(dig(a, 'printCoupons'), 'constructor', { value: {}, enumerable: true }))).toMatch(/reserved/);
  });
});
