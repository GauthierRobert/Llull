/**
 * VC-SWG-32 as ONE table (validation README 3 and 5): every volume case of the pack, built through the commands and measured by `mass_properties` on the
 * mesh path (no exact kernel installed: the in-process Manifold-class evaluation), against the closed forms of `expected_results.json` within the pack's
 * `meshKernelRel` (5e-3). The table is complete by construction: a volume case of the pack with no row and no stated exemption fails the test.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { execute } from '@core/commands/registry';
import { relError, runSwgPlan, swgCase, swgPlan, swgValue } from '../../helpers/swgPack';
import { volumeOf } from '../../helpers/fixtureDocument';
import { xyz } from '../../helpers/xy';

const empty = createEmptyDocument();
const BAR = xyz(0, 0, 0, 0, 0, 100);
const SQUARE = [
  [-5, -5],
  [5, -5],
  [5, 5],
  [-5, 5],
];

/** Volume of the single entity a command creates in `doc`. */
function built(command: string, params: Record<string, unknown>, doc: CadDocument = empty): number {
  const made = execute(doc, command, params);
  expect(made.affected, made.summary).toHaveLength(1);
  return volumeOf(made.document, made.affected[0] as string);
}

const plan = (name: string): ReturnType<typeof runSwgPlan> => runSwgPlan(swgPlan(name));
const twist = plan('target_twist_scale_orientation');
const helix = plan('target_helix_spring_thread');
const rails = plan('target_rails_and_surface_mode');
const lofts = plan('target_loft_conditions_alignment');
const baseline = plan('baseline_today_sweeps_lofts');

interface Row {
  readonly vc: string;
  readonly key: string;
  readonly measured: () => number;
}

const ruledCircles = (degrees: number): number =>
  built('loft_sections', {
    sections: [
      { center: [0, 0, 0], radius: 10 },
      { center: [0, 0, 50], radius: 10, rotation: [0, 0, (degrees * Math.PI) / 180] },
    ],
    ruled: true,
    alignment: 'none',
  });

/** A closed degree-1 NURBS square (side `half` * 2) at height z whose first pole is the corner `start` (0..3 counter-clockwise from (+, -)). */
function squareCurve(doc: CadDocument, half: number, z: number, start: number): { doc: CadDocument; id: string } {
  const corners = [
    [half, -half],
    [half, half],
    [-half, half],
    [-half, -half],
  ];
  const ring = [0, 1, 2, 3, 4].map((i) => [...(corners[(i + start) % 4] as number[]), z]);
  const made = execute(doc, 'create_nurbs_curve', { degree: 1, poles: ring });
  return { doc: made.document, id: made.affected[0] as string };
}

/** Two squares, the top one's first pole one corner on, lofted ruled with `alignment` (exact degree-1 sections: the mesh path is exact too). */
function squareLoft(alignment: string): number {
  const bottom = squareCurve(empty, 5, 0, 0);
  const top = squareCurve(bottom.doc, 5, 50, 1);
  return built('loft_sections', { sectionIds: [bottom.id, top.id], ruled: true, alignment }, top.doc);
}

/** VC-SWG-37: a square 20 at z = 0 and a circle r 10 at z = 50 (nurbs sections), ruled, seams aligned, coupled by arc length. */
function squareToCircle(): number {
  const square = squareCurve(empty, 10, 0, 0);
  const r = 10;
  const circle = execute(square.doc, 'create_nurbs_curve', {
    degree: 2,
    poles: [
      [r, 0, 50],
      [r, r, 50],
      [0, r, 50],
      [-r, r, 50],
      [-r, 0, 50],
      [-r, -r, 50],
      [0, -r, 50],
      [r, -r, 50],
      [r, 0, 50],
    ],
    weights: [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1],
    knots: [0, 0.25, 0.5, 0.75, 1],
    multiplicities: [3, 2, 2, 2, 3],
  });
  return built(
    'loft_sections',
    { sectionIds: [square.id, circle.affected[0]], ruled: true, alignment: 'auto', coupling: 'arc_length' },
    circle.document,
  );
}

/** A quarter arc R 50 (the path of VC-SWG-02/09). */
function quarterArc(): { doc: CadDocument; id: string } {
  const arc = execute(empty, 'draw_arc', { center: [0, 0], radius: 50, startAngle: 0, endAngle: Math.PI / 2 });
  return { doc: arc.document, id: arc.affected[0] as string };
}

/** The table: one row per volume value of the pack. */
const ROWS: readonly Row[] = [
  { vc: 'VC-SWG-01', key: 'torus_sweep', measured: () => baseline.volumeOf('torus') },
  {
    vc: 'VC-SWG-02',
    key: 'quarter_torus_sweep',
    measured: () => {
      const arc = quarterArc();
      return built('sweep_profile', { pathId: arc.id, radius: 10 }, arc.doc);
    },
  },
  {
    vc: 'VC-SWG-02',
    key: 'offset_square_on_arc',
    measured: () => {
      const arc = quarterArc();
      const section = [
        [0, -5],
        [10, -5],
        [10, 5],
        [0, 5],
      ];
      return built('sweep_profile', { pathId: arc.id, section }, arc.doc);
    },
  },
  { vc: 'VC-SWG-03', key: 'linear_0_to_90deg', measured: () => twist.volumeOf('bar90') },
  { vc: 'VC-SWG-03', key: 'linear_0_to_360deg', measured: () => twist.volumeOf('bar360') },
  { vc: 'VC-SWG-03', key: 'scurve_0_to_180deg', measured: () => twist.volumeOf('barS') },
  {
    vc: 'VC-SWG-04',
    key: 'offset_rect_linear_0_to_180deg',
    measured: () =>
      built('sweep_profile', {
        path: BAR,
        section: [
          [-4, -2.5],
          [16, -2.5],
          [16, 2.5],
          [-4, 2.5],
        ],
        twist: { type: 'linear', start: 0, end: Math.PI },
      }),
  },
  {
    vc: 'VC-SWG-04',
    key: 'helix_linear_0_to_720deg',
    measured: () => {
      const path = execute(empty, 'add_helix', { radius: 20, pitch: 10, turns: 3 });
      return built(
        'sweep_profile',
        { pathId: path.affected[0], section: SQUARE, twist: { type: 'linear', start: 0, end: 4 * Math.PI } },
        path.document,
      );
    },
  },
  { vc: 'VC-SWG-05', key: 'linear_1_to_0.5_straight', measured: () => twist.volumeOf('cone') },
  {
    vc: 'VC-SWG-06',
    key: 'smoothstep_1_to_0.5_straight',
    measured: () => built('sweep_profile', { path: BAR, radius: 10, scale: { type: 's_curve', start: 1, end: 0.5 } }),
  },
  { vc: 'VC-SWG-07', key: 'expression_1_plus_0.25sin2pit', measured: () => twist.volumeOf('wavy') },
  { vc: 'VC-SWG-09', key: 'linear_1_to_0.5_quarter_arc_square', measured: () => twist.volumeOf('vane') },
  { vc: 'VC-SWG-10', key: 'area_law_linear_100_to_25', measured: () => twist.volumeOf('areaLaw') },
  { vc: 'VC-SWG-11', key: 'linear_1_to_0.5_straight', measured: () => twist.volumeOf('linearStations') },
  {
    vc: 'VC-SWG-11',
    key: 'smoothstep_1_to_0.5_straight',
    measured: () =>
      built('sweep_profile', {
        path: BAR,
        stations: [
          { at: 0, radius: 10 },
          { at: 1, radius: 5 },
        ],
        stationBlend: 'smooth',
      }),
  },
  { vc: 'VC-SWG-12', key: 'round_tube_on_helix', measured: () => helix.volumeOf('tube') },
  { vc: 'VC-SWG-13', key: 'screw_rectangle_pitch10', measured: () => helix.volumeOf('screw10') },
  { vc: 'VC-SWG-13', key: 'screw_rectangle_pitch5', measured: () => helix.volumeOf('screw5') },
  { vc: 'VC-SWG-14', key: 'conical_helix_tube', measured: () => helix.volumeOf('conicalTube') },
  {
    vc: 'VC-SWG-15',
    key: 'normal_to_path',
    measured: () => built('sweep_profile', { path: xyz(0, 0, 0, 70.710678119, 0, 70.710678119), radius: 10 }),
  },
  { vc: 'VC-SWG-15', key: 'fixed_plane_oblique', measured: () => twist.volumeOf('oblique') },
  { vc: 'VC-SWG-16', key: 'two_rails_uniform_scale', measured: () => rails.volumeOf('twoRail') },
  { vc: 'VC-SWG-17', key: 'two_rails_maintain_height', measured: () => rails.volumeOf('twoRailHeight') },
  { vc: 'VC-SWG-19', key: 'ruled_circles_twist_0deg', measured: () => lofts.volumeOf('cylinderAligned') },
  { vc: 'VC-SWG-19', key: 'ruled_circles_twist_60deg', measured: () => ruledCircles(60) },
  { vc: 'VC-SWG-19', key: 'ruled_circles_twist_90deg', measured: () => lofts.volumeOf('hyperboloid90') },
  { vc: 'VC-SWG-19', key: 'ruled_circles_twist_120deg', measured: () => ruledCircles(120) },
  { vc: 'VC-SWG-19', key: 'ruled_circles_twist_180deg', measured: () => ruledCircles(180) },
  { vc: 'VC-SWG-21', key: 'normal_both_ends_m1', measured: () => lofts.volumeOf('bottle') },
  { vc: 'VC-SWG-22', key: 'normal_both_ends_m2', measured: () => lofts.volumeOf('bottle2') },
  { vc: 'VC-SWG-22', key: 'centreline_quarter_arc', measured: () => lofts.volumeOf('elbowLoft') },
  { vc: 'VC-SWG-35', key: 'linear_1_to_0.5_straight', measured: () => rails.volumeOf('oneRail') },
  { vc: 'VC-SWG-36', key: 'square_seam_off_by_one_corner', measured: () => squareLoft('none') },
  { vc: 'VC-SWG-37', key: 'ruled_square20_to_circle10_arc_length', measured: squareToCircle },
  {
    vc: 'VC-SWG-38',
    key: 'l_path_round_corner',
    measured: () => built('sweep_profile', { path: xyz(0, 0, 0, 100, 0, 0, 100, 100, 0), radius: 5, bendRadius: 30 }),
  },
  {
    vc: 'VC-SWG-38',
    key: 'l_path_miter_corner',
    measured: () => built('sweep_profile', { path: xyz(0, 0, 0, 100, 0, 0, 100, 100, 0), radius: 5, corners: 'miter' }),
  },
];

/** Volume values of the pack this table does not measure on the mesh path, with the reason (each is gated elsewhere). */
const EXEMPT: Readonly<Record<string, string>> = {};

interface PackCase {
  readonly vc: string;
  readonly metric?: string;
  readonly values?: Record<string, number>;
  readonly tolerance?: { readonly meshKernelRel?: number };
}

const PACK = resolve(import.meta.dirname, '../../../docs/design/02-sweep-loft-guides/validation/expected_results.json');
const pack = (JSON.parse(readFileSync(PACK, 'utf8')) as { cases: PackCase[] }).cases;

describe('VC-SWG-32: every volume case of the pack on the mesh path, within meshKernelRel', () => {
  it.each(ROWS.map((row) => [`${row.vc} ${row.key}`, row] as const))('%s', (_label, row) => {
    const limit = swgCase(row.vc)['tolerance'] as { meshKernelRel: number };
    expect(limit.meshKernelRel).toBe(5e-3);
    expect(relError(row.measured(), swgValue(row.vc, row.key))).toBeLessThan(limit.meshKernelRel);
  });
  it('the table covers every volume value of the pack (or states why not)', () => {
    const wanted = pack
      .filter((c) => c.metric === 'volume' && c.tolerance?.meshKernelRel !== undefined)
      .flatMap((c) => Object.keys(c.values ?? {}).map((key) => `${c.vc} ${key}`));
    const rows = new Set(ROWS.map((row) => `${row.vc} ${row.key}`));
    expect(wanted.filter((id) => !rows.has(id) && EXEMPT[id] === undefined)).toEqual([]);
    expect(ROWS.every((row) => wanted.includes(`${row.vc} ${row.key}`))).toBe(true);
  });
});
