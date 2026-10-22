/** SWG M1: twist / scale / area / stretch laws, station blend and orientation modes of sweep_profile (validation VC-SWG-03..07, 09..11, 15, 27, 38). */
import { describe, it, expect } from 'vitest';
import { type CadDocument, type SweepEntity, createEmptyDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { sweepTriangles } from '@core/geometry/sweep';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { docWith, volumeOf } from '../../helpers/fixtureDocument';
import { relError, runSwgPlan, swgPlan, swgValue } from '../../helpers/swgPack';
import { xyz } from '../../helpers/xy';

const empty = createEmptyDocument();
const SQUARE = [
  [-5, -5],
  [5, -5],
  [5, 5],
  [-5, 5],
];
const BAR = xyz(0, 0, 0, 0, 0, 100);
const MESH = 0.005;

function sweep(params: Record<string, unknown>, doc: CadDocument = empty): { doc: CadDocument; entity: SweepEntity } {
  const result = execute(doc, 'sweep_profile', params);
  expect(result.affected, result.summary).toHaveLength(1);
  return { doc: result.document, entity: result.document.entities[result.affected[0] as string] as SweepEntity };
}

function refused(params: Record<string, unknown>, code: string, doc: CadDocument = empty): void {
  const result = execute(doc, 'sweep_profile', params);
  expectNoOp(result, doc, code);
  expect(result.error?.code).toBe(code);
}

describe('sweep_profile laws — the target plan (VC-SWG-03..07, 09..11, 15)', () => {
  const { steps, volumeOf: planVolume } = runSwgPlan(swgPlan('target_twist_scale_orientation'));
  it('every step of the pack plan succeeds', () => {
    expect(steps.filter((s) => !s.ok).map((s) => s.summary)).toEqual([]);
  });
  it('VC-SWG-03: twisting a square bar keeps its volume (Cavalieri), 90 deg / 360 deg / S-curve 180 deg', () => {
    for (const [alias, key] of [
      ['bar90', 'linear_0_to_90deg'],
      ['bar360', 'linear_0_to_360deg'],
      ['barS', 'scurve_0_to_180deg'],
    ] as const)
      expect(relError(planVolume(alias), swgValue('VC-SWG-03', key)), alias).toBeLessThan(MESH);
  });
  it('VC-SWG-05 / 07: a round section with a linear or expression scale law has the closed-form volume', () => {
    expect(relError(planVolume('cone'), swgValue('VC-SWG-05', 'linear_1_to_0.5_straight'))).toBeLessThan(1e-9);
    expect(relError(planVolume('wavy'), swgValue('VC-SWG-07', 'expression_1_plus_0.25sin2pit'))).toBeLessThan(1e-9);
  });
  it('VC-SWG-10: an area law is not a scale law (6 250, not 5 833.33)', () => {
    expect(relError(planVolume('areaLaw'), swgValue('VC-SWG-10', 'area_law_linear_100_to_25'))).toBeLessThan(MESH);
  });
  it('VC-SWG-11: a linear station blend is evaluated per arc length (the frustum of the ring-sampled circle)', () => {
    const frustum = swgValue('VC-SWG-11', 'linear_1_to_0.5_straight');
    expect(relError(planVolume('linearStations'), frustum)).toBeLessThan(2e-3);
  });
  it('VC-SWG-09: a square on a quarter arc with a linear scale law', () => {
    expect(relError(planVolume('vane'), swgValue('VC-SWG-09', 'linear_1_to_0.5_quarter_arc_square'))).toBeLessThan(MESH);
  });
  it('VC-SWG-15: fixed keeps the section plane (V = A L cos 45 deg); minimal keeps it normal to the path', () => {
    expect(relError(planVolume('oblique'), swgValue('VC-SWG-15', 'fixed_plane_oblique'))).toBeLessThan(1e-9);
    const normal = sweep({ path: xyz(0, 0, 0, 70.710678119, 0, 70.710678119), radius: 10 });
    expect(relError(volumeOf(normal.entity), swgValue('VC-SWG-15', 'normal_to_path'))).toBeLessThan(1e-9);
  });
});

describe('sweep_profile laws — more cases', () => {
  it('VC-SWG-06: an S-curve scale law (round: closed form; square: mesh)', () => {
    const reference = swgValue('VC-SWG-06', 'smoothstep_1_to_0.5_straight');
    const round = sweep({ path: BAR, radius: 10, scale: { type: 's_curve', start: 1, end: 0.5 } });
    expect(relError(volumeOf(round.entity), reference)).toBeLessThan(1e-9);
    const square = sweep({ path: BAR, section: SQUARE, scale: { type: 's_curve', start: 1, end: 0.5 } });
    expect(relError(volumeOf(square.entity), (reference / (Math.PI * 100)) * 100)).toBeLessThan(MESH);
  });
  it('VC-SWG-11: stations blend smoothly by default and linearly on request, per arc length', () => {
    const stations = [
      { at: 0, radius: 10 },
      { at: 1, radius: 5 },
    ];
    const smooth = volumeOf(sweep({ path: BAR, stations, stationBlend: 'smooth' }).entity);
    const linear = volumeOf(sweep({ path: BAR, stations, stationBlend: 'linear' }).entity);
    expect(relError(smooth, swgValue('VC-SWG-11', 'smoothstep_1_to_0.5_straight'))).toBeLessThan(2e-3);
    expect(relError(linear, swgValue('VC-SWG-11', 'linear_1_to_0.5_straight'))).toBeLessThan(2e-3);
  });
  it('VC-SWG-04: an off-centre rectangle keeps its volume when twisted 180 deg about the path', () => {
    const rectangle = [
      [-4, -2.5],
      [16, -2.5],
      [16, 2.5],
      [-4, 2.5],
    ];
    const { entity } = sweep({ path: BAR, section: rectangle, twist: { type: 'linear', start: 0, end: Math.PI } });
    expect(relError(volumeOf(entity), swgValue('VC-SWG-04', 'offset_rect_linear_0_to_180deg'))).toBeLessThan(MESH);
  });
  it('stretch scales the section axes separately', () => {
    const { entity } = sweep({
      path: BAR,
      section: SQUARE,
      stretch: { x: { type: 'constant', value: 2 }, y: { type: 'constant', value: 0.5 } },
    });
    expect(relError(volumeOf(entity), 10000)).toBeLessThan(1e-9);
    const bounds = sweepTriangles(entity).flat();
    expect(Math.max(...bounds.map((p) => p[0]))).toBeCloseTo(10, 9);
    expect(Math.max(...bounds.map((p) => p[1]))).toBeCloseTo(2.5, 9);
  });
  it('twistTurns is a linear twist of whole turns; it is stored as the law', () => {
    const { entity } = sweep({ path: BAR, section: SQUARE, twistTurns: 1 });
    expect(entity.twist).toEqual({ type: 'linear', start: 0, end: 2 * Math.PI });
  });
  it('VC-SWG-38 (today): a round corner of bend 30 on an L path, circle r 5, has the Pappus volume', () => {
    const { entity } = sweep({ path: xyz(0, 0, 0, 100, 0, 0, 100, 100, 0), radius: 5, bendRadius: 30 });
    expect(relError(volumeOf(entity), swgValue('VC-SWG-38', 'l_path_round_corner'))).toBeLessThan(1e-9);
  });
  it('binormal keeps the section y axis toward the reference direction', () => {
    const binormal = sweep({ path: BAR, section: SQUARE, orientation: { mode: 'binormal', direction: [1, 0, 0] } });
    expect(relError(volumeOf(binormal.entity), 10000)).toBeLessThan(MESH);
    const ring = sweepTriangles(binormal.entity).flat();
    expect(Math.max(...ring.map((p) => p[0]))).toBeCloseTo(5, 9);
  });
  it('frenet is refused on a polyline path whose straight runs have no curvature normal', () => {
    refused(
      { path: xyz(0, 0, 0, 50, 0, 0, 50, 50, 0), radius: 2, bendRadius: 20, orientation: { mode: 'frenet' } },
      'SWG_FRAME_DEGENERATE',
    );
  });
  it('frenet follows the curvature normal of an arc path (section x toward the centre)', () => {
    const doc = docWith({ id: 'arc', kind: 'arc', center: [0, 0], radius: 50, startAngle: 0, endAngle: Math.PI / 2 });
    const { entity } = sweep({ pathId: 'arc', section: SQUARE, orientation: { mode: 'frenet' } }, doc);
    expect(entity.orientation).toEqual({ mode: 'frenet' });
    const volume = volumeOf(entity);
    expect(relError(volume, 100 * 50 * (Math.PI / 2))).toBeLessThan(0.01);
  });
  it('a closed ring accepts a whole-turn twist (circle: any twist; square: a quarter turn is a symmetry)', () => {
    const ring = xyz(0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0);
    expect(sweep({ path: ring, closed: true, section: SQUARE, bendRadius: 20, twistTurns: 1 }).entity.twist).toBeDefined();
    expect(
      sweep({ path: ring, closed: true, section: SQUARE, bendRadius: 20, twist: { type: 'linear', start: 0, end: Math.PI / 2 } }).entity
        .twist,
    ).toBeDefined();
    expect(
      sweep({ path: ring, closed: true, radius: 3, bendRadius: 20, twist: { type: 'linear', start: 0, end: 1.234 } }).entity.twist,
    ).toBeDefined();
  });
});

describe('sweep_profile laws — refusals with stable codes (VC-SWG-27)', () => {
  it('SWG_LAW_NONPOSITIVE: a scale law reaching a negative value', () => {
    refused({ path: BAR, radius: 5, scale: { type: 'linear', start: 1, end: -0.5 } }, 'SWG_LAW_NONPOSITIVE');
    refused({ path: BAR, radius: 5, area: { type: 'linear', start: 10, end: 0 } }, 'SWG_LAW_NONPOSITIVE');
    refused({ path: BAR, radius: 5, stretch: { x: { type: 'constant', value: 0 } } }, 'SWG_LAW_NONPOSITIVE');
  });
  it('SWG_LAW_INVALID: an unordered table, an incomplete law, a stray stationBlend', () => {
    refused(
      {
        path: BAR,
        radius: 5,
        twist: {
          type: 'table',
          points: [
            [0, 0],
            [0.5, 1],
            [0.4, 2],
          ],
        },
      },
      'SWG_LAW_INVALID',
    );
    refused({ path: BAR, radius: 5, twist: { type: 'linear', start: 0 } }, 'SWG_LAW_INVALID');
    refused({ path: BAR, radius: 5, twist: { type: 'constant' } }, 'SWG_LAW_INVALID');
    refused({ path: BAR, radius: 5, twist: { type: 'expression' } }, 'SWG_LAW_INVALID');
    refused({ path: BAR, radius: 5, twist: { type: 'table' } }, 'SWG_LAW_INVALID');
    refused({ path: BAR, radius: 5, twist: { type: 'expression', expression: 'foo(' } }, 'SWG_LAW_INVALID');
    refused({ path: BAR, radius: 5, stationBlend: 'linear' }, 'SWG_LAW_INVALID');
  });
  it('SWG_LAW_EXCLUSIVE: scale with area, twist with twistTurns, area with stations', () => {
    const one = { type: 'constant', value: 1 };
    refused({ path: BAR, radius: 5, scale: one, area: one }, 'SWG_LAW_EXCLUSIVE');
    refused({ path: BAR, radius: 5, twist: one, twistTurns: 1 }, 'SWG_LAW_EXCLUSIVE');
    refused(
      {
        path: BAR,
        area: one,
        stations: [
          { at: 0, radius: 1 },
          { at: 1, radius: 2 },
        ],
      },
      'SWG_LAW_EXCLUSIVE',
    );
  });
  it('SWG_CLOSED_TWIST_NOT_PERIODIC: 100 deg of twist on a closed square-section ring', () => {
    const ring = xyz(0, 0, 0, 100, 0, 0, 100, 100, 0, 0, 100, 0);
    refused(
      { path: ring, closed: true, section: SQUARE, bendRadius: 20, twist: { type: 'linear', start: 0, end: 1.745329252 } },
      'SWG_CLOSED_TWIST_NOT_PERIODIC',
    );
  });
  it('SWG_FRAME_DEGENERATE: frenet on a straight run, fixed along its plane, binormal along its direction, a zero direction', () => {
    refused({ path: BAR, radius: 5, orientation: { mode: 'frenet' } }, 'SWG_FRAME_DEGENERATE');
    refused({ path: xyz(0, 0, 0, 100, 0, 0), radius: 5, orientation: { mode: 'fixed' } }, 'SWG_FRAME_DEGENERATE');
    refused({ path: BAR, radius: 5, orientation: { mode: 'binormal', direction: [0, 0, 1] } }, 'SWG_FRAME_DEGENERATE');
    refused({ path: BAR, radius: 5, orientation: { mode: 'binormal' } }, 'SWG_FRAME_DEGENERATE');
    refused({ path: BAR, radius: 5, orientation: { mode: 'fixed', direction: [0, 0, 0] } }, 'SWG_FRAME_DEGENERATE');
  });
  it('SWG_SELF_INTERSECTION_LOCAL: a section wider than the bend, also once the scale law has grown it', () => {
    const arc = xyz(0, 0, 0, 50, 0, 0, 50, 50, 0);
    refused({ path: arc, radius: 6, bendRadius: 5 }, 'SWG_SELF_INTERSECTION_LOCAL');
    refused({ path: arc, radius: 3, bendRadius: 5, scale: { type: 'linear', start: 1, end: 2 } }, 'SWG_SELF_INTERSECTION_LOCAL');
  });
  it('SWG_PATH_INVALID / SWG_PATH_NOT_G1 for bad paths, a duplicate id stays a plain no-op', () => {
    refused({ radius: 5 }, 'SWG_PATH_INVALID');
    refused({ path: xyz(0, 0, 0, 0, 0, 0), radius: 5 }, 'SWG_PATH_INVALID');
    refused({ path: xyz(0, 0, 0, 10, 0, 0, 10, 10, 0), radius: 1, bendRadius: 0.01, smooth: false }, 'SWG_SELF_INTERSECTION_LOCAL');
    const { doc } = sweep({ path: BAR, radius: 5, id: 'dup' });
    expectNoOp(execute(doc, 'sweep_profile', { path: BAR, radius: 5, id: 'dup' }), doc, 'already exists');
  });
});

describe('sweep_profile laws — parametric history (VC-SWG-31)', () => {
  it('editing a law value in history re-evaluates the sweep with the same id; replay is stable', () => {
    const built = execute(empty, 'sweep_profile', { path: BAR, radius: 10, scale: { type: 'linear', start: 1, end: 0.5 } });
    const id = built.affected[0] as string;
    const step = built.document.featureHistory?.[0];
    expect(step).toBeDefined();
    const edited = execute(built.document, 'edit_step_params', {
      stepId: (step as { id: string }).id,
      params: { path: BAR, radius: 10, scale: { type: 'linear', start: 1, end: 0.25 } },
    });
    expect(edited.document.order).toEqual([id]);
    const entity = edited.document.entities[id] as SweepEntity;
    expect(entity.scale).toEqual({ type: 'linear', start: 1, end: 0.25 });
    expect(volumeOf(entity)).toBeCloseTo((Math.PI * 100 * 100 * (1 + 0.25 + 0.0625)) / 3, 6);
    const replayed = execute(edited.document, 'replay_history', {});
    expect(replayed.document.entities[id]).toEqual(entity);
  });
});

describe('sweep_profile laws — purity and defaults', () => {
  it('is pure', () => {
    expectPure(empty, () =>
      execute(empty, 'sweep_profile', { path: BAR, section: SQUARE, twistTurns: 1, scale: { type: 'linear', start: 1, end: 2 } }),
    );
  });
  it('without a law, orientation or blend param the entity holds none of the new fields (bit-identical sweep)', () => {
    const { entity } = sweep({ path: BAR, radius: 3 });
    expect(Object.keys(entity).filter((k) => ['twist', 'scale', 'area', 'stretch', 'orientation', 'stationBlend'].includes(k))).toEqual([]);
  });
});
