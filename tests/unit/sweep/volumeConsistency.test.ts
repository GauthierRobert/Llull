/** DES-2c: the volumeConsistencyRel check of check_sweep_loft (TECHNICAL_SPEC 5.4): exact volume against the integral of the section area along the path. */
import { describe, it, expect } from 'vitest';
import { createEmptyDocument, type CadDocument, type SweepEntity } from '@core/model/types';
import { sweepConsistencyVolume } from '@core/geometry/sweepEval/volume';
import { closedFormVolume } from '@core/geometry/closedFormVolume';
import { execute } from '@core/commands/registry';
import { defaultContext } from '@core/commands/context';
import type { GeometryKernel } from '@core/geometry/kernel';
import { kernelFromOps } from '@core/geometry/shapeKernel';
import { expectNoOp, expectPure } from '../../helpers/expectNoOp';
import { TETRA } from '../../helpers/fakeKernel';
import { runSwgPlan, swgPlan, swgValue } from '../../helpers/swgPack';
import { xyz } from '../../helpers/xy';

const empty = createEmptyDocument();

type Ops = Parameters<typeof kernelFromOps<{ mesh: typeof TETRA }>>[0];

const baseOps = (): Ops => ({
  name: 'occt',
  solid: () => ({ mesh: TETRA }),
  boolean: () => null,
  fillet: () => null,
  blend: () => null,
  chamfer: () => null,
  shell: () => null,
  place: (shape) => shape,
  scale: (shape) => shape,
  tessellate: (shape) => shape.mesh,
  topology: () => null,
  exportStep: () => null,
  release: () => undefined,
});

/** A kernel whose every shape measures `volume()` (the exact port the check reads); a null volume = the kernel cannot integrate. */
const volumeKernel = (volume: () => number | null): GeometryKernel =>
  kernelFromOps({
    ...baseOps(),
    massProperties: () => {
      const v = volume();
      return v === null
        ? null
        : {
            volume: v,
            area: 1,
            centroid: [0, 0, 0],
            inertiaAtCentroid: [1, 0, 0, 1, 0, 1] as never,
            bounds: { min: [0, 0, 0], max: [1, 1, 1] },
          };
    },
  });

const withKernel = (kernel: GeometryKernel): ReturnType<typeof defaultContext> => ({ ...defaultContext(), kernel });

interface CheckData {
  status: string;
  findings: Array<{ code: string; severity: string; value: number; limit: number; entityId: string; message: string }>;
  volumeChecks: Array<{ entityId: string; expected: number; measured: number; relativeDeviation: number }>;
  tolerances: Record<string, { value: number; defaulted: boolean; source: string }>;
}

function sweep(params: Record<string, unknown>, doc: CadDocument = empty): { doc: CadDocument; id: string } {
  const made = execute(doc, 'sweep_profile', params);
  expect(made.affected, made.summary).toHaveLength(1);
  return { doc: made.document, id: made.affected[0] as string };
}

const STRAIGHT = xyz(0, 0, 0, 0, 0, 100);
const TUBE = Math.PI * 4 * 100;

describe('check_sweep_loft volumeConsistencyRel', () => {
  it('passes when the exact volume equals the integral of the section area (round section, closed form)', () => {
    const { doc, id } = sweep({ path: STRAIGHT, radius: 2 });
    const result = execute(doc, 'check_sweep_loft', { ids: [id] }, withKernel(volumeKernel(() => TUBE * (1 + 5e-5))));
    const data = result.data as CheckData;
    expect(data.status).toBe('pass');
    expect(data.volumeChecks).toHaveLength(1);
    expect(data.volumeChecks[0]?.expected).toBeCloseTo(TUBE, 6);
    expect(data.volumeChecks[0]?.relativeDeviation).toBeCloseTo(5e-5, 9);
    expect(data.tolerances['volumeConsistencyRel']).toMatchObject({ value: 1e-4, defaulted: true });
  });
  it('fails with SWG_CHECK_VOLUME_MISMATCH on a deficit above the limit, and the limit is a parameter', () => {
    const { doc, id } = sweep({ path: STRAIGHT, radius: 2 });
    const kernel = volumeKernel(() => TUBE * 0.9);
    const failed = execute(doc, 'check_sweep_loft', { ids: [id] }, withKernel(kernel)).data as CheckData;
    expect(failed.status).toBe('fail');
    const finding = failed.findings.find((f) => f.code === 'SWG_CHECK_VOLUME_MISMATCH');
    expect(finding).toMatchObject({ severity: 'fail', entityId: id, limit: 1e-4 });
    expect(finding?.value).toBeCloseTo(0.1, 9);
    expect(finding?.message).toContain('deficit');
    const loose = execute(doc, 'check_sweep_loft', { ids: [id], volumeConsistencyRel: 0.2 }, withKernel(kernel)).data as CheckData;
    expect(loose.status).toBe('pass');
    expect(loose.tolerances['volumeConsistencyRel']).toMatchObject({ value: 0.2, defaulted: false });
    const surplus = execute(doc, 'check_sweep_loft', { ids: [id] }, withKernel(volumeKernel(() => TUBE * 1.1))).data as CheckData;
    expect(surplus.findings.find((f) => f.code === 'SWG_CHECK_VOLUME_MISMATCH')?.message).toContain('surplus');
  });
  it('a polygon section with a scale law is compared with A x the integral of s^2 (VC-SWG-10 area law)', () => {
    const square = [
      [-5, -5],
      [5, -5],
      [5, 5],
      [-5, 5],
    ];
    const { doc, id } = sweep({ path: STRAIGHT, section: square, area: { type: 'linear', start: 100, end: 25 } });
    const ok = execute(doc, 'check_sweep_loft', { ids: [id] }, withKernel(volumeKernel(() => 6250 * (1 - 4e-5))));
    expect((ok.data as CheckData).volumeChecks[0]?.expected).toBeCloseTo(6250, 6);
    expect((ok.data as CheckData).status).toBe('pass');
    const bad = execute(doc, 'check_sweep_loft', { ids: [id] }, withKernel(volumeKernel(() => 5833.33)));
    expect((bad.data as CheckData).findings.map((f) => f.code)).toContain('SWG_CHECK_VOLUME_MISMATCH');
    const scaled = sweep({ path: STRAIGHT, section: square, scale: { type: 'linear', start: 1, end: 0.5 } });
    const volume = (100 * 100 * (1 + 0.5 + 0.25)) / 3;
    const checked = execute(scaled.doc, 'check_sweep_loft', { ids: [scaled.id] }, withKernel(volumeKernel(() => volume)));
    expect((checked.data as CheckData).volumeChecks[0]?.expected).toBeCloseTo(volume, 6);
  });
  it('a sweep along one rail in scale mode is integrated along its frames (VC-SWG-35)', () => {
    const plan = swgPlan('target_rails_and_surface_mode').slice(0, 10);
    const run = runSwgPlan(plan);
    const id = run.steps[9]?.affected[0] as string;
    const expected = swgValue('VC-SWG-35', 'linear_1_to_0.5_straight');
    const result = execute(run.document, 'check_sweep_loft', { ids: [id] }, withKernel(volumeKernel(() => expected)));
    const check = (result.data as CheckData).volumeChecks[0];
    expect(check?.entityId).toBe(id);
    expect(Math.abs(check?.relativeDeviation ?? 1)).toBeLessThan(1e-4);
  });
  it('measures nothing without an exact kernel, or when the section is not normal to the path and centred on it', () => {
    const { doc, id } = sweep({ path: STRAIGHT, radius: 2 });
    const none = execute(doc, 'check_sweep_loft', { ids: [id] }, withKernel(volumeKernel(() => TUBE * 0.5)));
    expect((none.data as CheckData).volumeChecks).toHaveLength(1);
    expect((execute(doc, 'check_sweep_loft', { ids: [id] }).data as CheckData).volumeChecks).toEqual([]);
    const noPort = kernelFromOps(baseOps());
    expect((execute(doc, 'check_sweep_loft', { ids: [id] }, withKernel(noPort)).data as CheckData).volumeChecks).toEqual([]);
    const refusedBuild = execute(doc, 'check_sweep_loft', { ids: [id] }, withKernel(volumeKernel(() => null)));
    expect((refusedBuild.data as CheckData).volumeChecks).toEqual([]);
    const half = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    // an off-centre profile on a straight path has V = A L (no curvature, no Pappus term): it is measured
    const offCentre = sweep({ path: STRAIGHT, section: half });
    const onStraight = execute(offCentre.doc, 'check_sweep_loft', { ids: [offCentre.id] }, withKernel(volumeKernel(() => 10000)));
    expect((onStraight.data as CheckData).volumeChecks[0]?.expected).toBeCloseTo(10000, 6);
    const stations = sweep({
      path: STRAIGHT,
      stations: [
        { at: 0, radius: 5 },
        { at: 1, radius: 2 },
      ],
    });
    const fixed = sweep({ path: xyz(0, 0, 0, 0, 0, 100), radius: 2, orientation: { mode: 'fixed' } });
    const stretched = sweep({ path: STRAIGHT, radius: 2, stretch: { x: { type: 'constant', value: 2 } } });
    for (const other of [stations, fixed, stretched]) {
      const result = execute(other.doc, 'check_sweep_loft', { ids: [other.id] }, withKernel(volumeKernel(() => 123)));
      expect((result.data as CheckData).volumeChecks, other.id).toEqual([]);
    }
  });
  it('has no premise for a mitre with a law, nor for rails whose laws cannot be evaluated', () => {
    const mitred = sweep({
      path: xyz(0, 0, 0, 100, 0, 0, 100, 100, 0),
      section: [
        [-5, -5],
        [5, -5],
        [5, 5],
        [-5, 5],
      ],
      corners: 'miter',
      scale: { type: 'linear', start: 1, end: 1 },
    });
    expect(sweepConsistencyVolume(mitred.doc.entities[mitred.id] as SweepEntity)).toBeNull();
    const run = runSwgPlan(swgPlan('target_rails_and_surface_mode').slice(0, 10));
    const railed = run.document.entities[run.steps[9]?.affected[0] as string] as SweepEntity;
    expect(sweepConsistencyVolume(railed)).toBeGreaterThan(0);
    expect(sweepConsistencyVolume({ ...railed, scale: { type: 'constant', value: -1 } })).toBeNull();
  });
  it('rails keep the premise only when they leave the section centred and normal: translation or off-centre profiles are integrated, curved profiles and a fixed plane give null', () => {
    const run = runSwgPlan(swgPlan('target_rails_and_surface_mode').slice(0, 10));
    const entity = (step: number): SweepEntity => run.document.entities[run.steps[step]?.affected[0] as string] as SweepEntity;
    const two = entity(3);
    const one = entity(9);
    expect(sweepConsistencyVolume(two)).toBeGreaterThan(0);
    expect(sweepConsistencyVolume(one)).toBeGreaterThan(0);
    // anchors that are not symmetric about the section centre: the two-rail map translates the centroid
    const shifted = {
      ...two,
      anchors: [
        [10, 0],
        [-4, 0],
      ],
    } as SweepEntity;
    // on a straight path a translation of the centroid does not change the volume (no curvature, no Pappus term): the premise holds, curved paths are judged below
    expect(sweepConsistencyVolume(shifted)).toBeGreaterThan(0);
    const offCentre = {
      ...one,
      section: {
        shape: 'profile',
        profile: [
          [2, -3],
          [8, -3],
          [8, 3],
          [2, 3],
        ],
      },
    } as SweepEntity;
    expect(sweepConsistencyVolume(offCentre)).toBeGreaterThan(0);
    const rounded = {
      ...one,
      section: {
        shape: 'profile',
        profile: [
          [-5, -3],
          [5, -3],
          [5, 3],
          [-5, 3],
        ],
        curves: [
          {
            type: 'line',
            points: [
              [-5, -3],
              [5, -3],
            ],
          },
          {
            type: 'arc',
            points: [
              [5, -3],
              [6, 0],
              [5, 3],
            ],
          },
          {
            type: 'line',
            points: [
              [5, 3],
              [-5, 3],
            ],
          },
          {
            type: 'arc',
            points: [
              [-5, 3],
              [-6, 0],
              [-5, -3],
            ],
          },
        ],
      },
    } as unknown as SweepEntity;
    expect(sweepConsistencyVolume(rounded)).toBeNull();
    const fixed = { ...one, orientation: { mode: 'fixed' } } as SweepEntity;
    expect(sweepConsistencyVolume(fixed)).toBeNull();
    expect(closedFormVolume(fixed)?.analytic).toBe(false);
    expect(closedFormVolume(shifted)?.analytic).toBe(true);
    expect(closedFormVolume(one)?.analytic).toBe(true);
    expect(closedFormVolume(two)?.analytic).toBe(true);
  });
  it('refuses a non-positive volumeConsistencyRel and is pure', () => {
    const { doc, id } = sweep({ path: STRAIGHT, radius: 2 });
    expectNoOp(execute(doc, 'check_sweep_loft', { ids: [id], volumeConsistencyRel: 0 }), doc, 'SWG_PARAM_INVALID');
    expectPure(doc, () => execute(doc, 'check_sweep_loft', { ids: [id] }, withKernel(volumeKernel(() => TUBE))));
  });
});

describe('rails on a bend: the exact Pappus integral, whatever the translation of the section centroid', () => {
  const R = 50;
  /** A quarter arc R 50 (centre origin, counter-clockwise): the section x axis points to the centre, so offset +d is radius 50 - d. */
  const bend = (): { doc: CadDocument; id: string } => {
    const arc = execute(empty, 'draw_arc', { center: [0, 0], radius: R, startAngle: 0, endAngle: Math.PI / 2 });
    return { doc: arc.document, id: arc.affected[0] as string };
  };
  /** An exact rail: the quarter circle of the given radius at height z as a rational quadratic. */
  const railExact = (doc: CadDocument, radius: number, z: number): { doc: CadDocument; id: string } => {
    const made = execute(doc, 'create_nurbs_curve', {
      degree: 2,
      poles: [
        [radius, 0, z],
        [radius, radius, z],
        [0, radius, z],
      ],
      weights: [1, Math.SQRT1_2, 1],
      knots: [0, 1],
      multiplicities: [3, 3],
    });
    expect(made.affected, made.summary).toHaveLength(1);
    return { doc: made.document, id: made.affected[0] as string };
  };
  /** The same rail interpolated through ten points (a cubic): it deviates from the circle by about 1e-3. */
  const railInterpolated = (doc: CadDocument, radius: number, z: number): { doc: CadDocument; id: string } => {
    const points = Array.from({ length: 10 }, (_, k) => {
      const angle = (k / 9) * (Math.PI / 2);
      return [radius * Math.cos(angle), radius * Math.sin(angle), z];
    });
    const made = execute(doc, 'interpolate_curve', { points, degree: 3 });
    expect(made.affected, made.summary).toHaveLength(1);
    return { doc: made.document, id: made.affected[0] as string };
  };
  const railed = (
    makeRail: typeof railExact,
    rails: Array<[number, number]>,
    anchors: number[][],
    extra: Record<string, unknown> = {},
  ): { doc: CadDocument; entity: SweepEntity } => {
    const path = bend();
    let doc = path.doc;
    const ids: string[] = [];
    for (const [radius, z] of rails) {
      const made = makeRail(doc, radius, z);
      doc = made.doc;
      ids.push(made.id);
    }
    const made = execute(doc, 'sweep_profile', { pathId: path.id, guideIds: ids, guideMode: 'scale', radius: 2, anchors, ...extra });
    expect(made.affected, made.summary).toHaveLength(1);
    return { doc: made.document, entity: made.document.entities[made.affected[0] as string] as SweepEntity };
  };
  const method = (doc: CadDocument, id: string): string =>
    (execute(doc, 'mass_properties', { entityId: id }).data as { method: string }).method;
  const checked = (doc: CadDocument, id: string, exact: number, volumeConsistencyRel: number): CheckData =>
    execute(doc, 'check_sweep_loft', { ids: [id], volumeConsistencyRel }, withKernel(volumeKernel(() => exact))).data as CheckData;
  /** Circle r 2 swept a quarter turn with its centre at radius `centre`: Pappus, V = A x angle x centre. */
  const pappus = (centre: number): number => Math.PI * 4 * (Math.PI / 2) * centre;

  it('two rails on the +N side translate the centroid by 2: the expectation is the exact Pappus volume, and a kernel returning it passes at 1e-7', () => {
    // anchors (2, 0) and (2, 1) asked of rails at offsets (4, 0) and (4, 1): the map is a translation of 2 toward the centre, the circle's centre sits at radius 48
    const { doc, entity } = railed(
      railExact,
      [
        [46, 0],
        [46, 1],
      ],
      [
        [2, 0],
        [2, 1],
      ],
    );
    const expected = sweepConsistencyVolume(entity);
    expect(relative(expected as number, pappus(48))).toBeLessThan(1e-9);
    const data = checked(doc, entity.id, pappus(48), 1e-7);
    expect(data.volumeChecks).toHaveLength(1);
    expect(data.findings.map((f) => f.code)).not.toContain('SWG_CHECK_VOLUME_MISMATCH');
    // the unshifted volume A x L would be 4 % off: a kernel returning it is a mismatch
    expect(checked(doc, entity.id, pappus(50), 1e-4).findings.map((f) => f.code)).toContain('SWG_CHECK_VOLUME_MISMATCH');
    expect(closedFormVolume(entity)?.analytic).toBe(true);
    expect(relative(closedFormVolume(entity)?.volume as number, pappus(48))).toBeLessThan(1e-9);
    expect(method(doc, entity.id)).toBe('closed-form');
  });
  it('two rails mirrored about the path keep the centroid: exact rails pass a tolerance of 1e-7 against the exact volume', () => {
    const { doc, entity } = railed(
      railExact,
      [
        [48, 0],
        [52, 0],
      ],
      [
        [2, 0],
        [-2, 0],
      ],
    );
    expect(relative(sweepConsistencyVolume(entity) as number, pappus(50))).toBeLessThan(1e-9);
    const data = checked(doc, entity.id, pappus(50), 1e-7);
    expect(data.volumeChecks).toHaveLength(1);
    expect(data.findings.map((f) => f.code)).not.toContain('SWG_CHECK_VOLUME_MISMATCH');
  });
  it('rails interpolated through ten points (centroid noise 1e-3): the expectation follows the real rails, within 5e-5 of the ideal volume', () => {
    const { doc, entity } = railed(
      railInterpolated,
      [
        [48, 0],
        [52, 0],
      ],
      [
        [2, 0],
        [-2, 0],
      ],
    );
    const expected = sweepConsistencyVolume(entity) as number;
    // the 5e-5 gap is the cubic rails' departure from a circle, not the integral's error: do not tighten it
    expect(relative(expected, pappus(50))).toBeLessThan(5e-5);
    // a kernel that measures the real solid agrees at 1e-7; the ideal circle volume differs by the rails' own error (reported, not hidden)
    expect(checked(doc, entity.id, expected, 1e-7).findings.map((f) => f.code)).not.toContain('SWG_CHECK_VOLUME_MISMATCH');
    expect(checked(doc, entity.id, pappus(50), 1e-7).volumeChecks[0]?.relativeDeviation).toBeDefined();
  });
  it('one rail with an off-centre profile on the bend: the centroid at 3 gives A x angle x (50 - 3)', () => {
    const base = railed(railExact, [[48, 0]], [[2, 0]]);
    const profile = [
      [1, -2],
      [5, -2],
      [5, 2],
      [1, 2],
    ];
    const offCentre = { ...base.entity, section: { shape: 'profile', profile } } as unknown as SweepEntity;
    expect(relative(sweepConsistencyVolume(offCentre) as number, 16 * (Math.PI / 2) * 47)).toBeLessThan(1e-6);
  });
  it('one rail with a fixed section plane is not normal to the path: no premise, mesh volume', () => {
    const { doc, entity } = railed(railExact, [[48, 0]], [[2, 0]], { orientation: { mode: 'fixed', direction: [-1, 1, 0] } });
    expect(sweepConsistencyVolume(entity)).toBeNull();
    expect(closedFormVolume(entity)?.analytic).toBe(false);
    expect(method(doc, entity.id)).not.toBe('closed-form');
  });
  it('one rail with arc edges has no premise', () => {
    const base = railed(railExact, [[48, 0]], [[2, 0]]);
    expect(sweepConsistencyVolume(base.entity)).toBeGreaterThan(0);
    const rounded = {
      ...base.entity,
      section: {
        shape: 'profile',
        profile: [
          [-4, -2],
          [4, -2],
          [4, 2],
          [-4, 2],
        ],
        curves: [
          {
            type: 'line',
            points: [
              [-4, -2],
              [4, -2],
            ],
          },
          {
            type: 'arc',
            points: [
              [4, -2],
              [5, 0],
              [4, 2],
            ],
          },
          {
            type: 'line',
            points: [
              [4, 2],
              [-4, 2],
            ],
          },
          {
            type: 'arc',
            points: [
              [-4, 2],
              [-5, 0],
              [-4, -2],
            ],
          },
        ],
      },
    } as unknown as SweepEntity;
    expect(sweepConsistencyVolume(rounded)).toBeNull();
  });
});

const relative = (value: number, reference: number): number => Math.abs(value - reference) / Math.abs(reference);
