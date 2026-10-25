/**
 * Plant 06 STA M2: grating catalogue, closed forms against the pack's 19-W-4 table (VC-STA-06), add_grating / update_grating / check_grating,
 * takeoff and schedule lines. Hand numbers: 19-W-4 1-1/4x3/16 has 1000 / 30.1625 = 33.153 bars per metre, S = n t d^2 / 6 = 2.6528e4 mm3/m;
 * U = 8 F S / L^2 with F = 18000 psi = 124.106 MPa gives 70.875 kPa at 609.6 mm and 31.50 kPa at 914.4 mm.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { createEmptyDocument } from '@core/model/types';
import { buildingErrors } from '@aec/building/validate';
import {
  allowableConcentratedKNPerM,
  allowableUniformKPa,
  concentratedDeflectionMm,
  selfWeightKPa,
  uniformDeflectionMm,
} from '@aec/plant/structures/grating/gratingSpan';
import { GRATING_TYPES, findGratingType, sectionPerMetre } from '@aec/plant/structures/grating/gratingTypes';
import { apply, data, expectRefusal, ok } from '../../../helpers/commandAssertions';
import { expectNoOp, expectPure } from '../../../helpers/expectNoOp';
import { TYPE, gratedFrame, gratingFrame } from './accessFixtures';

const TABLE = JSON.parse(
  readFileSync(
    path.resolve(__dirname, '../../../../docs/plant/06-plant-structures-access/validation/data/grating_19w4_load_table.json'),
    'utf8',
  ),
) as {
  published: Array<{ spanFt: number; U_psf: number; grade: string }>;
  closedForm: Array<{ spanFt: number; U_psf: number; D_U_in: number; C_lbft: number; D_C_in: number }>;
  pedestrianSpan: { spanIn: number };
};
const PSF = 0.04788025898;
const LB_PER_FT_KN_M = 0.014593903;
const type = findGratingType(TYPE)!;

interface PanelRow {
  id: string;
  mark: string;
  spanMm: number;
  allowableUniformKPa: number;
  allowableConcentratedKNPerM: number;
  selfWeightKPa: number;
  deflectionMm: number;
  totalDeflectionMm: number;
  concentratedDeflectionMm: number | null;
  stressUtilisation: number;
  deflectionUtilisation: number;
  verdict: string;
  findings: Array<{ code: string; severity: string; ids: string[]; ruleId: string; remediation: string }>;
}
interface GratingCheck {
  verdict: string;
  panels: PanelRow[];
  findings: Array<{ code: string }>;
  unverifiedTypesUsed: string[];
  reviewRequired: boolean;
}
const check = (doc: Parameters<typeof data>[0], params: Record<string, unknown>): GratingCheck =>
  data<GratingCheck>(doc, 'check_grating', {
    uniformLoadKPa: 4.788,
    ...('deflectionRatio' in params ? {} : { deflectionLimitMm: 6.35 }),
    ...params,
  });

describe('grating catalogue and closed forms (VC-STA-06)', () => {
  it('lists the rows with geometry, section values per metre and the verified flag', () => {
    const { types } = data<{ types: Array<{ name: string; verified: boolean; massKgM2: number; sectionModulusMm3PerM: number }> }>(
      gratingFrame(),
      'list_grating_types',
      { standard: 'naamm_mbg_531' },
    );
    expect(types.map((row) => row.name)).toEqual(GRATING_TYPES.map((row) => row.name));
    expect(types.filter((row) => row.verified).map((row) => row.name)).toEqual([TYPE]);
    const verified = types.find((row) => row.name === TYPE)!;
    expect(verified.massKgM2).toBeCloseTo(43.4536, 3);
    expect(verified.sectionModulusMm3PerM).toBeCloseTo(26528, -1);
    expect(types.find((row) => row.name === '19-W-4 2x3/16')!.massKgM2).toBeGreaterThan(verified.massKgM2);
  });

  it('filters by text and answers an empty list for no match', () => {
    const only = data<{ types: Array<{ name: string }> }>(gratingFrame(), 'list_grating_types', { query: ' 15-W-4 ' });
    expect(only.types.map((row) => row.name)).toEqual(['15-W-4 1-1/4x3/16', '15-W-4 1-1/2x3/16']);
    const none = ok(gratingFrame(), 'list_grating_types', { query: 'no such grating' });
    expect(none.summary).toContain('0 grating type(s)');
    expect((none.data as { types: unknown[] }).types).toEqual([]);
  });

  it('reproduces the published U row within the integer psf of the tables at 2.0 / 2.5 / 3.0 ft and the closed form at every span', () => {
    for (const row of TABLE.published.filter((entry) => entry.grade === 'A')) {
      const psf = allowableUniformKPa(type, row.spanFt * 304.8) / PSF;
      expect(Math.abs(psf - row.U_psf), `${row.spanFt} ft`).toBeLessThanOrEqual(0.5);
    }
    for (const row of TABLE.closedForm) {
      const span = row.spanFt * 304.8;
      expect(allowableUniformKPa(type, span) / PSF).toBeCloseTo(row.U_psf, 2);
      expect(allowableConcentratedKNPerM(type, span) / LB_PER_FT_KN_M).toBeCloseTo(row.C_lbft, 1);
      expect(uniformDeflectionMm(type, span, allowableUniformKPa(type, span)) / 25.4).toBeCloseTo(row.D_U_in, 4);
      expect(concentratedDeflectionMm(type, span, allowableConcentratedKNPerM(type, span)) / 25.4).toBeCloseTo(row.D_C_in, 4);
    }
  });

  it('puts the pedestrian span (100 psf, 1/4 in) at 1711.3 mm and the 914.4 mm deflection at 0.5176 mm', () => {
    expect(TABLE.pedestrianSpan.spanIn * 25.4).toBeCloseTo(1711.3, 1);
    expect(uniformDeflectionMm(type, TABLE.pedestrianSpan.spanIn * 25.4, 100 * PSF)).toBeCloseTo(6.35, 2);
    expect(uniformDeflectionMm(type, 914.4, 4.788)).toBeCloseTo(0.5176, 3);
  });

  it('gives the self weight in kPa from the mass (43.4536 kg/m2 -> 0.4261 kPa)', () => {
    expect(selfWeightKPa(type)).toBeCloseTo(0.42614, 4);
    expect(sectionPerMetre(type).inertia).toBeGreaterThan(0);
  });
});

describe('add_grating', () => {
  it('splits the SC-STA-06 region into one panel per bay: spans 609.6 / 914.4 / 1800 mm on beams 9..12', () => {
    const frame = gratingFrame();
    const result = ok(frame, 'add_grating', {
      supportedBy: 'beams',
      bounds: [
        [3324, 3000],
        [0, 0],
      ],
      gratingType: TYPE,
      bearingBarDirection: [2, 0],
      thickness: 31.75,
    });
    const info = result.data as {
      panels: Array<{ id: string; mark: string; spanMm: number; areaM2: number; massKg: number; supportIds: string[] }>;
      massKg: number;
      defaults: string[];
    };
    expect(info.panels.map((panel) => [panel.mark, panel.spanMm])).toEqual([
      ['GR1', 609.6],
      ['GR2', 914.4],
      ['GR3', 1800],
    ]);
    expect(info.panels[0]!.areaM2).toBeCloseTo(1.8288, 6);
    expect(info.massKg).toBeCloseTo(9.972 * 43.4536, 2);
    expect(info.defaults).toEqual(['topOffset 0 (walking surface at the level elevation)']);
    expect(info.panels.map((panel) => panel.supportIds)).toEqual([
      ['member-9', 'member-10'],
      ['member-10', 'member-11'],
      ['member-11', 'member-12'],
    ]);
    expect(result.affected.slice(0, 3)).toEqual(['grating-1', 'grating-2', 'grating-3']);
    expect(result.affected.length).toBeGreaterThan(3);
    const element = result.document.building?.elements['grating-2'];
    expect(element).toMatchObject({ category: 'grating', gratingType: TYPE, topOffset: 0, bearingBarAngle: 0, levelId: 'level-1' });
    const entity = result.document.entities['grating-2:body'];
    expect(entity?.kind).toBe('mesh');
    expect(result.document.order).toContain('grating-2:body');
    expect(buildingErrors(result.document.building)).toEqual([]);
    expect(result.summary).toContain('spans 609.6, 914.4, 1800 mm');
  });

  it('builds panels from a convex polygon by clipping at the supports (trapezoid: area is conserved)', () => {
    const polygon = [
      [0, 0],
      [1524, 0],
      [1524, 3000],
      [0, 2000],
    ];
    const result = ok(gratingFrame(), 'add_grating', {
      supportedBy: 'beams',
      boundary: polygon,
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
    });
    const info = result.data as { panels: Array<{ spanMm: number; areaM2: number }>; areaM2: number };
    expect(info.panels.map((panel) => panel.spanMm)).toEqual([609.6, 914.4]);
    expect(info.areaM2).toBeCloseTo(((2000 + 3000) / 2 / 1000) * 1.524, 4);
  });

  it('spans the other way when the bars run along y: one 3000 mm panel between the two x-direction beams', () => {
    const result = ok(gratingFrame(), 'add_grating', {
      supportedBy: 'beams',
      bounds: [
        [0, 0],
        [3324, 3000],
      ],
      gratingType: TYPE,
      bearingBarDirection: [0, 1],
    });
    expect((result.data as { panels: Array<{ spanMm: number }> }).panels.map((panel) => panel.spanMm)).toEqual([3000]);
    expect(result.document.building?.elements['grating-1']).toMatchObject({ bearingBarAngle: Math.PI / 2 });
  });

  it('bears on named members and records them', () => {
    const frame = gratingFrame();
    const result = ok(frame, 'add_grating', {
      supportedBy: ['member-10', 'member-11'],
      bounds: [
        [609.6, 0],
        [1524, 3000],
      ],
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
    });
    expect((result.data as { panels: Array<{ supportIds: string[] }> }).panels[0]?.supportIds).toEqual(['member-10', 'member-11']);
  });

  it('refuses with a stable code: unknown type, region, thickness, direction, supports, twin, level', () => {
    const frame = gratingFrame();
    const base = {
      supportedBy: 'beams',
      bounds: [
        [0, 0],
        [3324, 3000],
      ],
      gratingType: TYPE,
      bearingBarDirection: [1, 0],
    };
    expectRefusal(frame, 'add_grating', { ...base, gratingType: '19-W-4 9x9' }, 'STA_GRATING_TYPE_UNKNOWN', 'gratingType');
    expectRefusal(
      frame,
      'add_grating',
      {
        ...base,
        boundary: [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
      },
      'STA_INVALID_GEOMETRY',
      'bounds',
    );
    const { bounds: _bounds, ...noRegion } = base;
    void _bounds;
    expectRefusal(frame, 'add_grating', noRegion, 'STA_INVALID_GEOMETRY', 'boundary');
    expectRefusal(frame, 'add_grating', { ...base, bearingBarDirection: [0, 0] }, 'STA_INVALID_GEOMETRY', 'bearingBarDirection');
    expectRefusal(frame, 'add_grating', { ...base, thickness: 40 }, 'STA_INVALID_GEOMETRY', 'thickness');
    expectRefusal(frame, 'add_grating', { ...base, levelId: 'level-9' }, 'STA_INVALID_GEOMETRY', 'levelId');
    const lShape = {
      ...noRegion,
      boundary: [
        [0, 0],
        [3000, 0],
        [3000, 1000],
        [1000, 1000],
        [1000, 3000],
        [0, 3000],
      ],
    };
    expectRefusal(frame, 'add_grating', lShape, 'STA_INVALID_GEOMETRY', 'boundary');
    expectRefusal(frame, 'add_grating', { ...base, supportedBy: ['no-such-member'] }, 'STA_UNKNOWN_ELEMENT', 'supportedBy');
    expectRefusal(frame, 'add_grating', { ...base, supportedBy: ['grating-1'] }, 'STA_UNKNOWN_ELEMENT', 'supportedBy');
  });

  it('refuses when no support reaches an end edge, when a named member cannot bear, and when no beam exists', () => {
    const frame = gratingFrame();
    const base = { supportedBy: 'beams', gratingType: TYPE, bearingBarDirection: [1, 0] };
    const overhang = expectRefusal(
      frame,
      'add_grating',
      {
        ...base,
        bounds: [
          [0, 0],
          [4000, 3000],
        ],
      },
      'STA_NO_SUPPORT_FOUND',
      'supportedBy',
    );
    expect(overhang.summary).toContain('no support under the end edge');
    const early = expectRefusal(
      frame,
      'add_grating',
      {
        ...base,
        bounds: [
          [-500, 0],
          [3324, 3000],
        ],
      },
      'STA_NO_SUPPORT_FOUND',
    );
    expect(early.summary).toContain('no support under the start edge');
    const column = Object.values(frame.building?.elements ?? {}).find(
      (element) => element.category === 'member' && element.role === 'column',
    )!;
    const notBearing = expectRefusal(
      frame,
      'add_grating',
      {
        ...base,
        supportedBy: [column.id, 'member-10'],
        bounds: [
          [0, 0],
          [3324, 3000],
        ],
      },
      'STA_NO_SUPPORT_FOUND',
      'supportedBy',
    );
    expect(notBearing.error?.ids).toEqual([column.id]);
    const high = expectRefusal(
      frame,
      'add_grating',
      {
        ...base,
        bounds: [
          [0, 0],
          [3324, 3000],
        ],
        topOffset: 200,
      },
      'STA_NO_SUPPORT_FOUND',
    );
    expect(high.summary).toContain('0 bear under');
    const bare = apply(apply(createEmptyDocument(), 'set_units', { units: 'mm' }), 'add_level', {
      name: 'Grade',
      elevation: 0,
      height: 4000,
    });
    expectRefusal(
      bare,
      'add_grating',
      {
        ...base,
        bounds: [
          [0, 0],
          [1000, 1000],
        ],
      },
      'STA_NO_SUPPORT_FOUND',
    );
  });

  it('refuses a twin of an existing panel and is pure', () => {
    const { doc } = gratedFrame();
    expectRefusal(
      doc,
      'add_grating',
      {
        supportedBy: 'beams',
        bounds: [
          [0, 0],
          [3324, 3000],
        ],
        gratingType: TYPE,
        bearingBarDirection: [1, 0],
      },
      'STA_INVALID_GEOMETRY',
    );
    expectPure(gratingFrame(), () => {
      const frame = gratingFrame();
      execute(frame, 'add_grating', {
        supportedBy: 'beams',
        bounds: [
          [0, 0],
          [3324, 3000],
        ],
        gratingType: TYPE,
        bearingBarDirection: [1, 0],
      });
      return frame;
    });
  });
});

describe('update_grating', () => {
  it('changes the type of the given panels and re-evaluates them', () => {
    const { doc, ids } = gratedFrame();
    const result = ok(doc, 'update_grating', { ids: [ids[2]!, ids[2]!], gratingType: '19-W-4 1-1/2x3/16' });
    expect(result.affected[0]).toBe(ids[2]);
    expect(result.document.building?.elements[ids[2]!]).toMatchObject({ gratingType: '19-W-4 1-1/2x3/16' });
    expect(result.document.building?.elements[ids[0]!]).toMatchObject({ gratingType: TYPE });
    expect(result.summary).toContain('unverified type');
    expect(result.document.entities[`${ids[2]}:body`]).toBeDefined();
  });

  it('refuses unknown types and ids, and does nothing when the type is already set', () => {
    const { doc, ids } = gratedFrame();
    expectRefusal(doc, 'update_grating', { ids, gratingType: 'x' }, 'STA_GRATING_TYPE_UNKNOWN', 'gratingType');
    expectRefusal(doc, 'update_grating', { ids: ['member-1'], gratingType: TYPE }, 'STA_UNKNOWN_ELEMENT', 'ids');
    expectNoOp(execute(doc, 'update_grating', { ids, gratingType: TYPE }), doc, 'already has type');
    expectPure(doc, () => execute(doc, 'update_grating', { ids, gratingType: '19-W-4 1x3/16' }));
    expectPure(doc, () => execute(doc, 'list_grating_types', {}));
  });
});

describe('check_grating', () => {
  const { doc, ids } = gratedFrame();

  it('reproduces AC-07: allowable 70.88 / 31.50 kPa, 0.5176 mm at 914.4 mm, and 1800 mm fails the 6.35 mm limit', () => {
    const result = check(doc, {});
    expect(result.panels.map((panel) => panel.spanMm)).toEqual([609.6, 914.4, 1800]);
    expect(result.panels[0]!.allowableUniformKPa).toBeCloseTo(70.875, 2);
    expect(result.panels[1]!.allowableUniformKPa).toBeCloseTo(31.5, 2);
    expect(result.panels[1]!.deflectionMm).toBeCloseTo(0.5176, 3);
    expect(result.panels[1]!.totalDeflectionMm).toBeGreaterThan(result.panels[1]!.deflectionMm);
    expect(result.panels[2]!.findings.map((finding) => [finding.code, finding.severity])).toEqual([['STA_GRATING_DEFLECTION', 'fail']]);
    expect(result.panels[2]!.findings[0]!.remediation.length).toBeGreaterThan(0);
    expect(result.panels[0]!.verdict).toBe('pass');
    expect(result.verdict).toBe('fail');
    expect(result.reviewRequired).toBe(true);
    expect(result.unverifiedTypesUsed).toEqual([]);
    expect(result.panels[2]!.stressUtilisation).toBeCloseTo((4.788 + 0.42614) / 8.1291, 3);
  });

  it('adds the self weight to the demand and flags overstress at a high load', () => {
    const result = check(doc, { uniformLoadKPa: 30, deflectionRatio: 20, ids: [ids[1]!] });
    expect(result.panels).toHaveLength(1);
    const panel = result.panels[0]!;
    expect(panel.stressUtilisation).toBeCloseTo((30 + panel.selfWeightKPa) / panel.allowableUniformKPa, 3);
    expect(panel.stressUtilisation).toBeLessThanOrEqual(1);
    const heavy = check(doc, { uniformLoadKPa: 31.5, deflectionRatio: 20, ids: [ids[1]!] });
    expect(heavy.panels[0]!.findings.map((finding) => finding.code)).toEqual(['STA_GRATING_OVERSTRESS']);
    expect(heavy.panels[0]!.findings[0]!.ruleId).toBe('NAAMM-STRESS');
  });

  it('checks the concentrated case alone with the self weight (M/Mcap = P/C + w/U)', () => {
    const result = check(doc, { uniformLoadKPa: 1, concentratedLoadKNPerM: 20, deflectionRatio: 200, ids: [ids[1]!] });
    const panel = result.panels[0]!;
    expect(panel.allowableConcentratedKNPerM).toBeCloseTo((4 * 124.1056 * sectionPerMetre(type).modulus) / 914.4 / 1000, 2);
    expect(panel.concentratedDeflectionMm).toBeGreaterThan(0);
    expect(panel.stressUtilisation).toBeCloseTo(
      20 / panel.allowableConcentratedKNPerM + panel.selfWeightKPa / panel.allowableUniformKPa,
      3,
    );
  });

  it('measures the clear span when asked (minus the half top-flange widths: 100 mm for IPE200)', () => {
    const centre = check(doc, { ids: [ids[1]!] }).panels[0]!;
    const clear = check(doc, { ids: [ids[1]!], spanBasis: 'clear' }).panels[0]!;
    expect(clear.spanMm).toBeCloseTo(centre.spanMm - 100, 3);
    expect(clear.allowableUniformKPa).toBeGreaterThan(centre.allowableUniformKPa);
  });

  it('warns for an unverified type and re-verifies the supports (a deeper type buries the beam top, a deleted support is found)', () => {
    const deeper = apply(doc, 'update_grating', { ids, gratingType: '19-W-4 2x3/16' });
    const warn = check(deeper, { deflectionLimitMm: 100 });
    expect(warn.unverifiedTypesUsed).toEqual(['19-W-4 2x3/16']);
    expect(warn.panels[0]!.findings.map((finding) => finding.code)).toContain('STA_NO_SUPPORT_FOUND');
    const slightly = apply(doc, 'update_grating', { ids: [ids[0]!], gratingType: '19-W-4 1x3/16' });
    const flagged = check(slightly, { deflectionLimitMm: 100, ids: [ids[0]!] });
    expect(flagged.panels[0]!.findings.map((finding) => [finding.code, finding.severity])).toEqual([
      ['STA_GRATING_TYPE_UNVERIFIED', 'warn'],
    ]);
    expect(flagged.verdict).toBe('warn');
    const removed = apply(doc, 'delete_building_element', { elementIds: ['member-10'] });
    const missing = check(removed, { ids: [ids[0]!] });
    expect(missing.panels[0]!.findings.map((finding) => finding.code)).toEqual(['STA_NO_SUPPORT_FOUND']);
    expect(missing.verdict).toBe('fail');
  });

  it('finds a support turned parallel to the bars', () => {
    const turned = apply(doc, 'update_steel_member', { memberId: 'member-10', start: [609.6, 0, -132], end: [1409.6, 0, -132] });
    const result = check(turned, { ids: [ids[0]!] });
    expect(result.panels[0]!.findings.map((finding) => finding.code)).toEqual(['STA_GRATING_SPAN_DIRECTION']);
  });

  it('refuses unknown ids, needs exactly one deflection limit and is read-only', () => {
    expectRefusal(doc, 'check_grating', { uniformLoadKPa: 1, deflectionRatio: 200, ids: ['member-1'] }, 'STA_UNKNOWN_ELEMENT', 'ids');
    expectNoOp(execute(doc, 'check_grating', { uniformLoadKPa: 1 }), doc, 'exactly one of deflectionLimitMm or deflectionRatio');
    expectNoOp(execute(doc, 'check_grating', { uniformLoadKPa: 1, deflectionRatio: 200, deflectionLimitMm: 5 }), doc);
    const none = check(gratingFrame(), { deflectionRatio: 200 });
    expect(none.panels).toEqual([]);
    expect(none.verdict).toBe('pass');
    expectPure(doc, () => execute(doc, 'check_grating', { uniformLoadKPa: 4.788, deflectionLimitMm: 6.35 }));
  });
});

describe('grating takeoff, schedule and persistence', () => {
  const { doc } = gratedFrame();

  it('adds grating.<type>.m2 / kg / ea lines to quantity_takeoff', () => {
    const lines = data<{ lines: Array<{ key: string; quantity: number }> }>(doc, 'quantity_takeoff', {}).lines;
    const byKey = new Map(lines.map((line) => [line.key, line.quantity]));
    expect(byKey.get(`grating.${TYPE}.m2`)).toBeCloseTo(9.972, 3);
    expect(byKey.get(`grating.${TYPE}.kg`)).toBeCloseTo(9.972 * 43.4536, 2);
    expect(byKey.get(`grating.${TYPE}.ea`)).toBe(3);
  });

  it('lists the panels in building_schedule grating', () => {
    const schedule = data<{ columns: string[]; rows: Array<Array<string | number>> }>(doc, 'building_schedule', { kind: 'grating' });
    expect(schedule.columns[0]).toBe('Mark');
    expect(schedule.rows.map((row) => [row[0], row[1], row[3]])).toEqual([
      ['GR1', TYPE, 1.829],
      ['GR2', TYPE, 2.743],
      ['GR3', TYPE, 5.4],
    ]);
  });

  it('validates the stored panels and rejects a malformed one', () => {
    expect(buildingErrors(doc.building)).toEqual([]);
    const broken = JSON.parse(JSON.stringify(doc.building)) as { elements: Record<string, Record<string, unknown>> };
    broken.elements['grating-1'] = { ...broken.elements['grating-1'], boundary: [[0, 0]], supportIds: ['a'], gratingType: 3 };
    const errors = buildingErrors(broken);
    expect(errors).toEqual(
      expect.arrayContaining([
        'building element grating-1: boundary must be a polygon of ≥ 3 [x, y] points',
        'building element grating-1: gratingType must be a string',
        'building element grating-1: supportIds must list two member ids',
      ]),
    );
  });

  it('moves with move_building_element', () => {
    const moved = apply(doc, 'move_building_element', { elementIds: ['grating-1'], delta: [100, 50] });
    const panel = moved.building?.elements['grating-1'];
    expect(panel?.category === 'grating' && panel.boundary[0]).toEqual([100, 50]);
  });
});
