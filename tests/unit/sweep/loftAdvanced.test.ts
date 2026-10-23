/** SWG M5: loft end conditions, seam alignment, centreline, closed loft, point ends, guides (validation VC-SWG-19, 21, 22, 36; target_loft_conditions_alignment). */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type LoftEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { composeEulerXYZ } from '@lib/eulerRotation';
import { seamTwist } from '@core/commands/surface/checkLoft';
import { evaluateSurface } from '@lib/nurbs/surface';
import type { NurbsSurfaceData } from '@lib/nurbs/surfaceTypes';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { loftFacesVolume } from '../../helpers/loftVolume';
import { relError, runSwgPlan, swgCase, swgPlan, swgValue } from '../../helpers/swgPack';

const empty = createEmptyDocument();

function loft(
  doc: CadDocument,
  params: Record<string, unknown>,
): { entity: LoftEntity; data: Record<string, number | null>; doc: CadDocument } {
  const result = execute(doc, 'loft_sections', params);
  expect(result.affected, result.summary).toHaveLength(1);
  return {
    entity: result.document.entities[result.affected[0] as string] as LoftEntity,
    data: result.data as Record<string, number | null>,
    doc: result.document,
  };
}

/** Plan steps up to (not including) the first `mass_properties`, so the sections exist but the lofts are built by the test. */
const planCircles = (): { doc: CadDocument; ids: Record<string, string> } => {
  const actions = swgPlan('target_loft_conditions_alignment');
  const aliased = actions.filter((a) => a.command === 'create_nurbs_curve' || a.command === 'draw_arc');
  const { document, steps } = runSwgPlan(aliased);
  const ids: Record<string, string> = {};
  aliased.forEach((a, i) => {
    if (a.as !== undefined) ids[a.as] = steps[i + 0]?.affected[0] as string;
  });
  return { doc: document, ids };
};

describe('target_loft_conditions_alignment — the pack plan', () => {
  const actions = swgPlan('target_loft_conditions_alignment').filter((a) => a.command !== 'check_sweep_loft');
  const { document, steps } = runSwgPlan(actions);
  const loftOf = (alias: string): LoftEntity => {
    const at = actions.findIndex((a) => a.as === alias);
    return document.entities[steps[at]?.affected[0] as string] as LoftEntity;
  };
  it('every step succeeds', () => {
    expect(steps.filter((s) => !s.ok).map((s) => `${s.command}: ${s.summary}`)).toEqual([]);
  });
  it('VC-SWG-21: circles r 10 -> 5 with normal ends (m = 1) are a cubic Hermite loft of volume 9 312.578 and end angle 0', () => {
    const entity = loftOf('bottle');
    expect(relError(loftFacesVolume(entity), swgValue('VC-SWG-21', 'normal_both_ends_m1'))).toBeLessThan(1e-6);
  });
  it('VC-SWG-22: magnitude 2 bulges the loft to 9 462.178', () => {
    expect(relError(loftFacesVolume(loftOf('bottle2')), swgValue('VC-SWG-22', 'normal_both_ends_m2'))).toBeLessThan(1e-6);
  });
  it('VC-SWG-19: a ruled loft whose seams are 90 degrees apart (alignment none) is 2/3 of the cylinder; auto restores the cylinder', () => {
    const twisted = swgCase('VC-SWG-19').values as Record<string, number>;
    expect(relError(loftFacesVolume(loftOf('hyperboloid90')), twisted['ruled_circles_twist_90deg'] as number)).toBeLessThan(1e-6);
    expect(relError(loftFacesVolume(loftOf('cylinderAligned')), twisted['ruled_circles_twist_0deg'] as number)).toBeLessThan(1e-6);
  });
  it('VC-SWG-22: a loft of two circles along a quarter-arc centreline is a quarter torus 24 674.011', () => {
    expect(relError(loftFacesVolume(loftOf('elbowLoft')), swgValue('VC-SWG-22', 'centreline_quarter_arc'))).toBeLessThan(1e-4);
  });
});

describe('loft_sections — end conditions', () => {
  const { doc, ids } = planCircles();
  const sectionIds = [ids['c0'], ids['c1']];
  it('reports the achieved end angles (0 for a normal condition) and keeps the sections', () => {
    const { data } = loft(doc, { sectionIds, startCondition: { type: 'normal' }, endCondition: { type: 'normal' } });
    expect(data['startAngleRad']).toBeLessThan(1e-6);
    expect(data['endAngleRad']).toBeLessThan(1e-6);
    expect(data['sectionDeviation']).toBeLessThan(1e-6);
  });
  it('a draft angle narrows the loft toward the axis', () => {
    const plain = loft(doc, { sectionIds, startCondition: { type: 'normal' }, endCondition: { type: 'normal' } });
    const drafted = loft(doc, {
      sectionIds,
      startCondition: { type: 'normal', draftDeg: 20 },
      endCondition: { type: 'normal', draftDeg: 20 },
    });
    expect(loftFacesVolume(drafted.entity)).toBeLessThan(loftFacesVolume(plain.entity));
    expect(drafted.data['startAngleRad']).toBeLessThan(0.01);
  });
  it('a direction condition leaves along the given vector', () => {
    const { data } = loft(doc, { sectionIds, startCondition: { type: 'direction', direction: [0, 0, 1] } });
    expect(data['startAngleRad']).toBeLessThan(1e-6);
  });
  it('a point end adds the apex beyond the last section: every given section is kept and the skin ends at the apex', () => {
    const plain = loft(doc, { sectionIds: [ids['c0'], ids['c1']] });
    const { entity, data } = loft(doc, { sectionIds: [ids['c0'], ids['c1']], endCondition: { type: 'point', at: [0, 0, 80] } });
    expect(data['sections']).toBe(2);
    expect(data['sectionDeviation']).toBeLessThan(1e-6);
    const face = (entity.faces as NurbsSurfaceData[])[0] as NurbsSurfaceData;
    const [[u0, u1], [, v1]] = [
      [face.knotsU[0] as number, face.knotsU[face.knotsU.length - 1] as number],
      [0, face.knotsV[face.knotsV.length - 1] as number],
    ];
    const apex = evaluateSurface(face, (u0 + u1) / 3, v1);
    const [ax, ay, az] = [apex[0] + entity.position[0], apex[1] + entity.position[1], apex[2] + entity.position[2]];
    expect([ax, ay, az].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 0, 80]);
    expect(loftFacesVolume(entity)).toBeGreaterThan(loftFacesVolume(plain.entity));
  });
  it('tangent_to_face leaves tangent to a sheet the section lies on (VC-SWG-26 G1 within 0.01 rad)', () => {
    // a cylinder wall r 10, z -20..0: the first section (r 10 at z 0) lies on its top edge
    const w = Math.SQRT1_2;
    const ring = [
      [10, 0],
      [10, 10],
      [0, 10],
      [-10, 10],
      [-10, 0],
      [-10, -10],
      [0, -10],
      [10, -10],
      [10, 0],
    ];
    const wall = execute(doc, 'create_nurbs_surface', {
      degreeU: 2,
      degreeV: 1,
      poles: ring.map(([x, y]) => [
        [x, y, -20],
        [x, y, 0],
      ]),
      weights: ring.map((_, i) => (i % 2 === 0 ? [1, 1] : [w, w])),
      knotsU: [0, 0.25, 0.5, 0.75, 1],
      multiplicitiesU: [3, 2, 2, 2, 3],
    });
    const faceId = wall.affected[0] as string;
    const result = execute(wall.document, 'loft_sections', {
      sectionIds,
      startCondition: { type: 'tangent_to_face', faceId },
      endCondition: { type: 'normal' },
    });
    expect(result.affected, result.summary).toHaveLength(1);
    expect((result.data as { startAngleRad: number }).startAngleRad).toBeLessThan(0.01);
    const curved = execute(wall.document, 'loft_sections', {
      sectionIds,
      startCondition: { type: 'curvature_to_face', faceId },
      endCondition: { type: 'normal' },
    });
    expect(curved.affected, curved.summary).toHaveLength(1);
    // a section off the face is refused
    const away = execute(wall.document, 'loft_sections', {
      sectionIds: [ids['c1'], ids['c0']],
      startCondition: { type: 'tangent_to_face', faceId },
    });
    expectNoOp(away, wall.document, 'SWG_LOFT_FACE_NOT_ADJACENT');
    expect(away.error?.code).toBe('SWG_LOFT_FACE_NOT_ADJACENT');
  });
  it('refusals: ruled with conditions, bad magnitude, bad direction, missing face id', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ruled: true, startCondition: { type: 'normal' } }, 'SWG_LOFT_END_CONDITION_INVALID'],
      [{ startCondition: { type: 'normal', magnitude: 0 } }, 'SWG_LOFT_END_CONDITION_INVALID'],
      [{ startCondition: { type: 'direction', direction: [0, 0, 0] } }, 'SWG_LOFT_END_CONDITION_INVALID'],
      [{ startCondition: { type: 'direction' } }, 'SWG_LOFT_END_CONDITION_INVALID'],
      [{ startCondition: { type: 'tangent_to_face', faceId: 'nope' } }, 'SWG_LOFT_END_CONDITION_INVALID'],
      [{ startCondition: { type: 'point' } }, 'SWG_LOFT_END_CONDITION_INVALID'],
    ];
    for (const [extra, code] of cases) {
      const result = execute(doc, 'loft_sections', { sectionIds, ...extra });
      expectNoOp(result, doc, code);
      expect(result.error?.code, JSON.stringify(extra)).toBe(code);
    }
  });
  it('is pure', () => {
    expectPure(doc, () =>
      execute(doc, 'loft_sections', { sectionIds, startCondition: { type: 'normal' }, endCondition: { type: 'normal' } }),
    );
  });
});

describe('VC-SWG-19: a ruled loft of two circles with the top seam turned by phi', () => {
  it('has the volume pi R^2 h (1 - (1 - cos phi) / 3) for 0, 60, 90, 120 and 180 degrees', () => {
    const values = swgCase('VC-SWG-19').values as Record<string, number>;
    for (const degrees of [0, 60, 90, 120, 180]) {
      const { entity } = loft(empty, {
        sections: [
          { center: [0, 0, 0], radius: 10 },
          { center: [0, 0, 50], radius: 10, rotation: [0, 0, (degrees * Math.PI) / 180] },
        ],
        ruled: true,
        alignment: 'none',
      });
      expect(relError(loftFacesVolume(entity), values[`ruled_circles_twist_${degrees}deg`] as number), `${degrees} deg`).toBeLessThan(1e-6);
    }
  });
});

describe('loft_sections — alignment, closed loft, guides', () => {
  const { doc, ids } = planCircles();
  it('VC-SWG-36: squares one corner apart twist to 2/3 of the prism (none) and restore it (auto)', () => {
    const squareAt = (z: number, start: number): Record<string, unknown> => {
      const corners = [
        [5, -5],
        [5, 5],
        [-5, 5],
        [-5, -5],
      ];
      const rotated = corners.map((_, i) => corners[(i + start) % 4] as number[]);
      return { section: rotated, center: [0, 0, z] };
    };
    const none = loft(empty, { sections: [squareAt(0, 0), squareAt(50, 1)], ruled: true, alignment: 'none' });
    expect(relError(loftFacesVolume(none.entity), swgValue('VC-SWG-36', 'square_seam_off_by_one_corner'))).toBeLessThan(1e-6);
    expect(none.data['seamTwistMaxRad']).toBeGreaterThan(1.5);
    const auto = loft(empty, { sections: [squareAt(0, 0), squareAt(50, 1)], ruled: true, alignment: 'auto' });
    expect(relError(loftFacesVolume(auto.entity), 5000)).toBeLessThan(1e-6);
    expect(auto.data['seamTwistMaxRad']).toBeLessThan(1e-6);
  });
  it('explicit seams rotate a section start by a curve-parameter fraction', () => {
    const { data } = loft(doc, { sectionIds: [ids['c0'], ids['c1']], ruled: true, seams: [0, 0.25] });
    expect(data['seamTwistMaxRad']).toBeGreaterThan(1.5);
  });
  it('a closed loft through eight rings is a periodic skin without caps (a torus-like duct)', () => {
    const ring = (angle: number): Record<string, unknown> => ({
      center: [60 * Math.cos(angle), 60 * Math.sin(angle), 0],
      rotation: composeEulerXYZ([0, 0, angle], [Math.PI / 2, 0, 0]),
      radius: 8,
    });
    const closed = loft(empty, { sections: Array.from({ length: 8 }, (_, k) => ring((k * Math.PI) / 4)), closed: true });
    expect(closed.entity.closed).toBe(true);
    const volume = loftFacesVolume(closed.entity);
    expect(relError(volume, 2 * Math.PI * Math.PI * 60 * 64)).toBeLessThan(0.03);
    // the closing pair is part of the seam twist and the periodic skin is tangent-continuous across its seam
    expect(closed.data['seamTwistMaxRad']).toBeLessThan(0.05);
    expect(closed.data['closureJumpRad']).toBeLessThan(1e-3);
    const check = execute(closed.doc, 'check_sweep_loft', { ids: [closed.entity.id] });
    expect(JSON.stringify(check.data)).not.toContain('SWG_CHECK_LOFT_CLOSURE_G1');
  });
  it('the seam twist of a closed loft includes the closing pair (last, first)', () => {
    const ringAt = (degrees: number): Array<[number, number, number]> =>
      Array.from({ length: 16 }, (_, k) => {
        const angle = ((degrees + (k * 360) / 16) * Math.PI) / 180;
        return [Math.cos(angle), Math.sin(angle), 0];
      });
    const rings = [ringAt(0), ringAt(100), ringAt(200)];
    expect(seamTwist(rings, true).value).toBeGreaterThan(seamTwist(rings, false).value + 0.5);
  });
  it('a closed loft needs three sections', () => {
    const result = execute(doc, 'loft_sections', { sectionIds: [ids['c0'], ids['c1']], closed: true });
    expectNoOp(result, doc, 'SWG_LOFT_CLOSED_TOO_FEW');
  });
  it('a centreline loft takes exactly two sections and a centreline that meets them', () => {
    const three = execute(doc, 'loft_sections', { sectionIds: [ids['c0'], ids['c1'], ids['c0']], centerlineId: ids['centreline'] });
    expect(three.error?.code).toBe('SWG_PARAM_INVALID');
    const misses = execute(doc, 'loft_sections', { sectionIds: [ids['c0'], ids['c1']], centerlineId: ids['centreline'] });
    expect(misses.error?.code).toBe('SWG_LOFT_CENTERLINE_MISSES');
    const unknown = execute(doc, 'loft_sections', { sectionIds: [ids['c0'], ids['c1']], centerlineId: 'nope' });
    expect(unknown.error?.code).toBe('SWG_LOFT_CENTERLINE_MISSES');
  });
  it('guides make a Gordon loft that contains them; a guide missing a section is refused', () => {
    const guide = execute(doc, 'interpolate_curve', {
      points: [
        [10, 0, 0],
        [7.5, 0, 25],
        [5, 0, 50],
      ],
      degree: 2,
    });
    const gid = guide.affected[0] as string;
    const gordon = execute(guide.document, 'loft_sections', { sectionIds: [ids['c0'], ids['c1']], guideIds: [gid] });
    expect(gordon.affected, gordon.summary).toHaveLength(1);
    expect((gordon.data as { guideDeviation: number }).guideDeviation).toBeLessThan(1e-3);
    const far = execute(guide.document, 'interpolate_curve', {
      points: [
        [30, 0, 0],
        [30, 0, 50],
      ],
      degree: 1,
    });
    const missing = execute(far.document, 'loft_sections', { sectionIds: [ids['c0'], ids['c1']], guideIds: [far.affected[0]] });
    expect(missing.error?.code).toBe('SRF_LOFT_GUIDE_MISSES_SECTION');
    const bad = execute(guide.document, 'loft_sections', { sectionIds: [ids['c0'], ids['c1']], guideIds: ['nope'] });
    expect(bad.error?.code).toBe('SWG_PARAM_INVALID');
  });
});
