/** beam_large_deflection: equilibrium path of a 2D frame with the native corotational beam solver (PHY-05 FR-NLS-12, TR-NLS-20). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { refuseNls } from '../codes';
import { DOF_OFFSET, beamFrameShape, buildFrame, type BeamFrameInput } from './frameInput';
import { MAX_ITERATIONS, RESIDUAL_TOLERANCE, arcLengthPath, loadControlPath, type PathPoint, type PathResult } from './pathFollowing';

/** Element i of a numeric array; 0 for an index past the end (noUncheckedIndexedAccess identity, never an engineering default). */
const at = (values: ArrayLike<number>, index: number): number => values[index] ?? 0;

const spread = (series: readonly number[]): number =>
  series.reduce((max, v) => Math.max(max, v), -Infinity) - series.reduce((min, v) => Math.min(min, v), Infinity);

/** Stand-in for an index past the end of the path (never reached: indices come from the path itself). */
const ORIGIN: PathPoint = { loadFactor: 0, u: new Float64Array(0) };

const NAME = 'beam_large_deflection';
/** Most path points and limit / turning points returned (AF-12). */
const MAX_PATH_POINTS = 2000;
const MAX_MARKS = 50;

type Dof = BeamFrameInput['report']['dofs'][number];

interface Mark {
  readonly step: number;
  readonly loadFactor: number;
  readonly u: Readonly<Partial<Record<Dof, number>>>;
}

interface LimitPoint extends Mark {
  readonly kind: 'max' | 'min';
  /** Vertex of the parabola through the three samples around the extremum, in (primary dof, load factor). */
  readonly refined: { readonly loadFactor: number; readonly dof: Dof; readonly displacement: number } | null;
}

/** Parabola vertex through three (x, y) samples, null when the samples do not define one. */
function vertex(points: readonly (readonly [number, number])[]): readonly [number, number] | null {
  const [[x0, y0] = [0, 0], [x1, y1] = [0, 0], [x2, y2] = [0, 0]] = points;
  const d = (x0 - x1) * (x0 - x2) * (x1 - x2);
  if (d === 0) return null;
  const a = (x2 * (y1 - y0) + x1 * (y0 - y2) + x0 * (y2 - y1)) / d;
  const b = (x2 * x2 * (y0 - y1) + x1 * x1 * (y2 - y0) + x0 * x0 * (y1 - y2)) / d;
  const c = y0 - a * x0 * x0 - b * x0;
  if (a === 0 || !Number.isFinite(a)) return null;
  return [-b / (2 * a), c - (b * b) / (4 * a)];
}

/**
 * Load-factor extrema of the path (first maximum = limit load; generator rule: lambda[i] >= lambda[i-1] and lambda[i+1] < lambda[i]),
 * refined as in generate_nls_reference.py by a parabola in (displacement, load factor) over the primary dof (report.dofs[0]).
 */
function limitPoints(
  path: readonly PathPoint[],
  values: (point: PathPoint, dof: Dof) => number,
  dof: Dof | undefined,
  mark: (step: number) => Mark,
): LimitPoint[] {
  const found: LimitPoint[] = [];
  for (let i = 1; i + 1 < path.length && found.length < MAX_MARKS; i++) {
    const [before, here, after] = [path[i - 1], path[i], path[i + 1]];
    if (before === undefined || here === undefined || after === undefined) continue;
    const max = here.loadFactor >= before.loadFactor && after.loadFactor < here.loadFactor;
    const min = here.loadFactor <= before.loadFactor && after.loadFactor > here.loadFactor;
    if (!max && !min) continue;
    const top = dof === undefined ? null : vertex([before, here, after].map((point) => [values(point, dof), point.loadFactor] as const));
    found.push({
      kind: max ? 'max' : 'min',
      ...mark(i),
      refined: top === null || dof === undefined ? null : { loadFactor: top[1], dof, displacement: top[0] },
    });
  }
  return found;
}

/** Steps where `dof` reverses direction (displacement limit points), ignoring changes below 1e-12 of its range. */
function turningPoints(series: readonly number[]): number[] {
  const range = spread(series);
  const noise = 1e-12 * Math.max(range, Number.MIN_VALUE);
  const turns: number[] = [];
  let direction = 0;
  for (let i = 1; i < series.length; i++) {
    const delta = at(series, i) - at(series, i - 1);
    if (Math.abs(delta) <= noise) continue;
    const sign = Math.sign(delta);
    if (direction !== 0 && sign !== direction) turns.push(i - 1);
    direction = sign;
  }
  return turns;
}

const STOP_TEXT: Readonly<Record<PathResult['outcome'], string>> = {
  finished: 'all steps done',
  stopped: 'stop rule met',
  not_converged: 'NLS_NOT_CONVERGED: a step did not converge (path up to the last converged step)',
  singular: 'singular',
};

/**
 * @affects nothing (read-only query; data = path, limit points, snap-back flag)
 * @invariant pure and deterministic (same arithmetic order as validation/generate_nls_reference.py); output bounded to 2000 path points and
 *   50 limit / turning points; reviewRequired always true
 * @failure invalid frame (unknown node, zero-length member, non-positive section, zero load, bad stop / report, too much work) ->
 *   NLS_FRAME_INVALID; no equilibrium from the first step (mechanism: supports do not stop rigid-body motion) -> NLS_NOT_CONVERGED (refusals);
 *   a later step not converging returns the path so far with converged false and stopCode NLS_NOT_CONVERGED
 */
export const beamLargeDeflection = defineCommand({
  name: NAME,
  description:
    "Large-deflection equilibrium path of a plane (x-y) frame of straight elastic beams with llull's native solver: 2D corotational " +
    'Euler-Bernoulli elements (Crisfield), spherical arc-length (control.kind arc_length: passes limit points, snap-through and snap-back, ' +
    'which CalculiX cannot) or load-control Newton (kind load: monotone problems). Units are whatever consistent set you give (labels only). ' +
    'Loads are fixed-direction reference loads scaled by the load factor. Returns data.path [{ step, loadFactor, u: { ux, uy, rz } }] of ' +
    'report.node (every report.every steps), data.limitPoints (load-factor maxima / minima; the first max is the limit load, refined by a ' +
    'parabola in (primary dof, load factor); the primary dof is report.dofs[0], the displacement the load is plotted against), data.snapBack (true when ' +
    'the primary dof reverses direction: a displacement limit point), ' +
    'data.converged and data.stoppedBy. Elastic only (no plasticity), in-plane only. Example: NAFEMS NL7 Lee frame. Next: compare with ' +
    'nonlinear_static FE (CalculiX) or hand checks; the result is computed by llull, not approved.',
  annotations: { readOnly: true },
  params: z.object(beamFrameShape),
  run: (doc, input): CommandResult => {
    const built = buildFrame(input);
    if ('problem' in built) return refuseNls(doc, NAME, 'NLS_FRAME_INVALID', built.problem, [], [built.path]);
    const { model, reference, nodeIndex } = built;
    const { control, stop } = input;
    const watched = stop?.node === undefined || stop.dof === undefined ? null : 3 * (nodeIndex.get(stop.node) ?? 0) + DOF_OFFSET[stop.dof];
    const stopRule = (point: PathPoint): boolean =>
      (stop?.maxLoadFactor !== undefined && Math.abs(point.loadFactor) > stop.maxLoadFactor) ||
      (watched !== null && stop?.maxAbsDisplacement !== undefined && Math.abs(point.u[watched] ?? 0) > stop.maxAbsDisplacement);
    const result =
      control.kind === 'arc_length'
        ? arcLengthPath(model, reference, control.arcLength, control.maxSteps, stopRule)
        : loadControlPath(model, reference, control.increments, control.maxFactor, stopRule);
    if (result.outcome === 'singular')
      return refuseNls(
        doc,
        NAME,
        'NLS_NOT_CONVERGED',
        'no equilibrium from the first step: the tangent stiffness is singular or Newton does not converge (do the supports stop every rigid-body motion?)',
        [],
        ['supports'],
      );
    const base = 3 * (nodeIndex.get(input.report.node) ?? 0);
    const value = (point: PathPoint, dof: Dof): number => point.u[base + DOF_OFFSET[dof]] ?? 0;
    const { dofs } = input.report;
    const path = result.points;
    const steps = path.length - 1;
    const mark = (step: number): Mark => {
      const point = path[step] ?? ORIGIN;
      return {
        step,
        loadFactor: point.loadFactor,
        u: Object.fromEntries(dofs.map((dof) => [dof, value(point, dof)])) as Partial<Record<Dof, number>>,
      };
    };
    // report.every absent = every step (the documented default)
    const requested = input.report.every === undefined ? 1 : input.report.every;
    const every = Math.max(requested, Math.ceil((steps + 1) / MAX_PATH_POINTS));
    const reported = path.flatMap((_, step) => (step % every === 0 || step === steps ? [mark(step)] : []));
    const ranges = dofs.map((dof) => ({ dof, series: path.map((point) => value(point, dof)) }));
    const primary = ranges[0];
    const limits = limitPoints(path, value, primary?.dof, mark);
    const turns = (primary === undefined ? [] : turningPoints(primary.series)).slice(0, MAX_MARKS);
    const converged = result.outcome !== 'not_converged';
    const firstMax = limits.find((point) => point.kind === 'max');
    const lastFactor = (path.at(-1) ?? ORIGIN).loadFactor;
    const units = `${input.units.length}, ${input.units.force}`;
    const method =
      control.kind === 'arc_length'
        ? `arc-length ${control.arcLength} ${input.units.length}`
        : `load control, ${control.increments} increments`;
    const peak =
      firstMax === undefined
        ? 'no load-factor maximum'
        : `first limit point load factor ${significantNumber(firstMax.refined?.loadFactor ?? firstMax.loadFactor, 6)} (step ${firstMax.step})`;
    return report(
      doc,
      `${NAME}: ${input.nodes.length} node(s), ${model.elements.length} element(s), ${model.free.length} free dof(s); ${method}: ${steps} step(s) to load factor ${significantNumber(lastFactor, 6)} (${STOP_TEXT[result.outcome]}); ${peak}; ${limits.length} limit point(s); snap-back ${turns.length > 0 ? 'yes' : 'no'}; path ${reported.length} point(s) every ${every} of node ${input.report.node} (${units}). Computed by llull, not approved: needs a qualified engineer.`,
      {
        units: input.units,
        converged,
        ...(converged ? {} : { stopCode: 'NLS_NOT_CONVERGED' }),
        stoppedBy: result.outcome,
        steps,
        elements: model.elements.length,
        freeDofs: model.free.length,
        every,
        thinned: every !== requested,
        path: reported,
        limitPoints: limits,
        snapBack: turns.length > 0,
        displacementTurningPoints: turns.map((step) => ({ ...mark(step), dof: primary?.dof })),
        provenance: {
          element: '2D corotational Euler-Bernoulli beam (Crisfield), linear elastic',
          pathFollowing: control.kind === 'arc_length' ? 'spherical arc-length (psi zero), Newton corrector' : 'load-control Newton',
          tolerance: `residual norm < ${RESIDUAL_TOLERANCE} x max(1, |load factor| x |reference load|), at most ${MAX_ITERATIONS} iterations per step`,
          linearAlgebra: 'banded LU without pivoting, dofs numbered along the members',
          reference: 'docs/physics/05-nonlinear-structural/TECHNICAL_SPEC.md 5.8; validation/generate_nls_reference.py (same algorithm)',
        },
        reviewRequired: true,
        reviewReason: 'a large-deflection path may support a stability or stiffness claim',
      },
    );
  },
});
