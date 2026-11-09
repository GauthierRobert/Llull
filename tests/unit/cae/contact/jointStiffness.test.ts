/**
 * PHY-06 M4 joint_stiffness_from_fe (FR-CNT-07): n*phi = d(bolt force) / d(applied load) over the unseparated increments of a step.
 * Oracle: the synthetic joint is linear, N = P0 + (n phi) L with n phi = 0.2 until the clamp zone opens, then the bolt takes 0.8 of the load; the
 * least-squares slope over the unseparated increments is exactly 0.2, over all increments it is not.
 */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import type { FeResultsArtifact } from '@core/model/analysis';
import { safeName } from '@cae/decks/context';
import { must } from './support';
import { bolted, contactBlock, frdSet, sectionParams, solveBolted, stressBlock, type Bolted } from './boltSupport';

const NPHI = 0.2;
const PRELOAD = 1000;

interface Increment {
  readonly step: number;
  /** Increment number within its step. */
  readonly increment: number;
  readonly time: number;
  readonly load: number;
  /** Bolt force N (area 1: the section stress equals it). */
  readonly force: number;
  readonly pressure: number;
}

/** P0 + 0.2 L while closed, then 0.8 more per unit of load once open (the bolt carries the whole increment). */
const rowsOf = (pressures: readonly number[]): Increment[] => {
  const loads = [0, 100, 200, 300, 400];
  let force = PRELOAD;
  return [
    { step: 1, increment: 1, time: 0.5, load: 0, force: PRELOAD, pressure: 0 },
    ...loads.map((load, index) => {
      const pressure = pressures[index] ?? 0;
      const previous = loads[index - 1] ?? 0;
      force += index === 0 ? 0 : (pressure > 0 ? NPHI : 1) * (load - previous);
      return { step: index === 0 ? 1 : 2, increment: index === 0 ? 2 : index, time: 1 + index * 0.25, load, force, pressure };
    }),
  ];
};

interface Jointed {
  readonly b: Bolted;
  readonly doc: ReturnType<typeof solveBolted>['doc'];
  readonly unsolved: ReturnType<typeof solveBolted>['doc'];
  readonly ctx: ReturnType<typeof solveBolted>['ctx'];
  readonly boltId: string;
  readonly probeId: string;
  readonly serviceId: string;
}

function joint(
  pressures: readonly number[],
  options: { readonly tables?: boolean; readonly load?: (increment: Increment) => number } = {},
): Jointed {
  const base = bolted({ pair: true });
  const second = must(base.doc, 'add_analysis_step', {
    analysisId: base.analysisId,
    name: 'service',
    multipliers: {},
    control: { kind: 'load', initialIncrement: 0.25, minIncrement: 0.001, maxIncrement: 0.25, maxIncrements: 20 },
  });
  const b: Bolted = { ...base, doc: second.doc };
  const added = must(b.doc, 'add_bolt_pretension', sectionParams(b, { preload: { kind: 'force', value: PRELOAD } }));
  const probe = must(added.doc, 'add_curve_probe', {
    analysisId: b.analysisId,
    name: 'pull',
    load: { kind: 'reaction', constraintId: b.topId, component: 'z' },
    displacement: { point: [0.5, 0.5, 5], dof: 'uz' },
  });
  const increments = rowsOf(pressures);
  const frd = increments
    .map((row) => frdSet(row.step, row.time, [stressBlock(() => [0, 0, row.force, 0, 0, 0]), contactBlock(row.pressure)], row.increment))
    .join('\n');
  const probeId = probe.affected[0] ?? '';
  const loadOf = options.load ?? ((row: Increment) => row.load);
  const dat: FeResultsArtifact['dat'] = {
    tables:
      options.tables === false
        ? []
        : increments.flatMap((row) => [
            {
              title: `total force (fx,fy,fz) for set ${safeName(`C_${b.topId}`)} and time ${row.time}`,
              time: row.time,
              rows: [[0, 0, -loadOf(row)]],
            },
            {
              title: `displacements (vx,vy,vz) for set ${safeName(`N_${probeId}`)} and time ${row.time}`,
              time: row.time,
              rows: [[1, 0, 0, 0.001 * row.load]],
            },
          ]),
  };
  const solved = solveBolted(b, probe.doc, frd, dat);
  return {
    b,
    doc: solved.doc,
    unsolved: probe.doc,
    ctx: solved.ctx,
    boltId: added.affected[1] ?? '',
    probeId,
    serviceId: second.affected[0] ?? '',
  };
}

const query = (j: Jointed, extra: Record<string, unknown> = {}): ReturnType<typeof execute> =>
  execute(
    j.doc,
    'joint_stiffness_from_fe',
    { analysisId: j.b.analysisId, pretension: j.boltId, loadProbe: 'pull', stepId: j.serviceId, ...extra },
    j.ctx,
  );

type Data = {
  nPhi: number;
  secant: number;
  r2: number;
  phi: number | null;
  range: { points: number; fromTime: number; toTime: number; load: number[]; boltForce: number[]; startsFromPreviousStep: boolean };
  separatedAt: number | null;
  warnings: string[];
};

describe('joint_stiffness_from_fe', () => {
  it('returns n*phi = 0.2 from the unseparated increments only (the post-separation increments, where the bolt takes the whole load, are excluded), is pure', () => {
    const j = joint([5, 5, 5, 0, 0]);
    const before = structuredClone(j.doc);
    const result = query(j);
    expect(result.error).toBeUndefined();
    expect(j.doc).toEqual(before);
    expect(result.affected).toEqual([]);
    const data = result.data as Data;
    expect(data.nPhi).toBeCloseTo(NPHI, 12);
    expect(data.secant).toBeCloseTo(NPHI, 12);
    expect(data.r2).toBeCloseTo(1, 12);
    expect(data.separatedAt).toBe(1.75);
    expect(data.range).toMatchObject({ points: 3, fromTime: 1, toTime: 1.5, load: [0, 200], startsFromPreviousStep: true });
    expect(data.range.boltForce[0]).toBeCloseTo(PRELOAD, 9);
    expect(data.range.boltForce[1]).toBeCloseTo(PRELOAD + 40, 9);
    expect(result.summary).toContain('nPhi = 0.2');
    expect(result.summary).toContain('separates at time 1.75');
    expect(result.summary).toContain('not approved');
    expect((result.data as { reviewRequired: boolean }).reviewRequired).toBe(true);
  });

  it('uses every increment when the joint never separates, and reports phi = nPhi / n for a loading-plane factor', () => {
    const j = joint([5, 5, 5, 5, 5]);
    const data = query(j, { loadingPlaneFactor: 0.5 }).data as Data;
    expect(data.nPhi).toBeCloseTo(NPHI, 12);
    expect(data.range.points).toBe(5);
    expect(data.separatedAt).toBeNull();
    expect(data.phi).toBeCloseTo(0.4, 12);
  });

  it('with the separation ignored the slope would be wrong: the all-increment fit of the same data is not 0.2', () => {
    const closed = query(joint([5, 5, 5, 5, 5])).data as Data;
    const open = query(joint([5, 5, 5, 0, 0])).data as Data;
    expect(closed.nPhi).toBeCloseTo(NPHI, 12);
    expect(open.nPhi).toBeCloseTo(NPHI, 12);
    // the force series of the separating joint, fitted over all five increments (what a reader without the separation rule would report)
    const rows = rowsOf([5, 5, 5, 0, 0]).slice(1);
    const meanL = rows.reduce((s, r) => s + r.load, 0) / rows.length;
    const meanN = rows.reduce((s, r) => s + r.force, 0) / rows.length;
    const slope = rows.reduce((s, r) => s + (r.load - meanL) * (r.force - meanN), 0) / rows.reduce((s, r) => s + (r.load - meanL) ** 2, 0);
    expect(slope).toBeGreaterThan(0.35);
  });

  it('takes a reaction probe with the sign flipped: a reaction that has the sign of the load gives a negative n*phi and a warning', () => {
    const data = query(joint([5, 5, 5, 5, 5], { load: (row) => -row.load })).data as Data;
    expect(data.nPhi).toBeCloseTo(-NPHI, 12);
    expect(data.warnings.join(' ')).not.toContain('not linear');
    const strong = query(joint([5, 5, 5, 5, 5], { load: (row) => row.load / 10 })).data as Data;
    expect(strong.nPhi).toBeCloseTo(2, 12);
    expect(strong.warnings.join(' ')).toContain('outside [0, 1]');
  });

  it('warns when the force-load relation is not linear over the range', () => {
    const bent = joint([5, 5, 5, 5, 5], { load: (row) => row.load * (1 + row.load / 400) });
    expect((query(bent).data as Data).warnings.join(' ')).toContain('not linear');
  });

  it.each([
    ['unknown bolt', { pretension: 'nope' }, 'CNT_PRETENSION_NOT_FOUND'],
    ['unknown probe', { loadProbe: 'nope' }, 'CNT_INPUT_INVALID'],
    ['unknown step', { stepId: 'nope' }, 'NLS_STEP_NOT_FOUND'],
    ['unknown analysis', { analysisId: 'nope' }, 'FEA_ANALYSIS_NOT_FOUND'],
  ])('refuses %s with %s', (_label, extra, code) => {
    const j = joint([5, 5, 5, 5, 5]);
    expect(query(j, extra).error?.code).toBe(code);
  });

  it('refuses the preload step (the force there is the tightening)', () => {
    const j = joint([5, 5, 5, 5, 5]);
    expect(query(j, { stepId: j.b.stepId }).error?.code).toBe('CNT_INPUT_INVALID');
  });

  it('refuses CNT_SEPARATED when the clamp zone is open from the first increment of the step', () => {
    const j = joint([5, 0, 0, 0, 0]);
    const result = query(j);
    expect(result.error?.code).toBe('CNT_SEPARATED');
    expect(result.summary).toContain('open from time 1.25');
  });

  it('refuses a step whose increments have no probe load (tables absent) and a load that does not change', () => {
    const bare = joint([5, 5, 5, 5, 5], { tables: false });
    expect(query(bare).error?.code).toBe('CNT_INPUT_INVALID');
    const flat = joint([5, 5, 5, 5, 5], { load: () => 7 });
    expect(query(flat).error?.code).toBe('CNT_INPUT_INVALID');
    expect(query(flat).summary).toContain('does not change');
  });

  it('refuses an analysis without verified results (FEA_RESULTS_MISSING) and a stale one', () => {
    const j = joint([5, 5, 5, 5, 5]);
    const base = { analysisId: j.b.analysisId, pretension: j.boltId, loadProbe: 'pull', stepId: j.serviceId };
    expect(execute(j.unsolved, 'joint_stiffness_from_fe', base).error?.code).toBe('FEA_RESULTS_MISSING');
    const changed = must(
      j.doc,
      'add_bolt_pretension',
      sectionParams(j.b, { name: 'other', section: { point: [0.5, 0.5, 3], normal: [0, 0, 1] } }),
    );
    expect(execute(changed.doc, 'joint_stiffness_from_fe', base, j.ctx).error?.code).toBe('FEA_RESULTS_STALE');
  });

  it('refuses a probe that plots a non-force load', () => {
    const j = joint([5, 5, 5, 5, 5]);
    const load = must(j.unsolved, 'add_fea_load', {
      analysisId: j.b.analysisId,
      name: 'p',
      kind: 'pressure',
      loadCase: 'LC1',
      magnitude: 1,
      target: { entityId: j.b.plate, facesNear: [[0.5, 0.5, 5]] },
    });
    const probe = must(load.doc, 'add_curve_probe', {
      analysisId: j.b.analysisId,
      name: 'press',
      load: { kind: 'load', loadId: load.affected[1] ?? load.affected[0] ?? '' },
      displacement: { point: [0.5, 0.5, 5], dof: 'uz' },
    });
    const result = execute(probe.doc, 'joint_stiffness_from_fe', {
      analysisId: j.b.analysisId,
      pretension: j.boltId,
      loadProbe: 'press',
      stepId: j.serviceId,
    });
    expect(result.error?.code).toBe('CNT_INPUT_INVALID');
    expect(result.summary).toContain('not a force');
  });
});
