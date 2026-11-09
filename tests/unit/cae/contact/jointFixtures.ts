/**
 * Fixture of the PHY-06 M4 joint results: a bolt + plate joint with a pair, a preload step and a service step whose increments follow a linear joint
 * (N = P0 + 0.2 L while the clamp zone is closed, then the bolt takes the whole increment), the reaction of the top constraint as the probe load.
 */
import type { FeResultsArtifact } from '@core/model/analysis';
import { safeName } from '@cae/decks/context';
import { must } from './support';
import { bolted, contactBlock, frdSet, sectionParams, solveBolted, stressBlock, type Bolted } from './boltSupport';

export const NPHI = 0.2;
export const PRELOAD = 1000;

export interface Increment {
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
export const rowsOf = (pressures: readonly number[]): Increment[] => {
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

export interface Jointed {
  readonly b: Bolted;
  readonly doc: ReturnType<typeof solveBolted>['doc'];
  readonly unsolved: ReturnType<typeof solveBolted>['doc'];
  readonly ctx: ReturnType<typeof solveBolted>['ctx'];
  readonly boltId: string;
  readonly probeId: string;
  readonly serviceId: string;
}

export function joint(
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
