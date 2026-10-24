import { defineCommand, vec3, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, noop } from '@core/commands/noop';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { PipeRun } from '@aec/plant/types';
import { len3, sub3 } from '@lib/vec3';
import { editRun, type EditContext, type RouteEdit } from '../editRoute';
import { angleBetweenDeg, epsilonFor, unitVector } from '../legs';
import { getPiping, refuse, runPoints } from '../model';
import { portOfRef } from '../ports';
import { deriveRun } from '../routeParts';
import { refuseDerivation, rederive } from '../runUpdate';
import { isSloped } from '../slope';
import { stretchRun, withRunStored } from '../stretch';
import { takeoffOf } from '../takeoff';
import { withDependents } from '../runLinks';

/** How far each connected end of `run` is from its port now (null for an open end) and where the port is. */
function endContext(doc: CadDocument, run: PipeRun): EditContext {
  const eps = epsilonFor(...runPoints(run));
  const side = (end: PipeRun['start']): { move: Vec3 | null; port: Vec3 | null } => {
    const port = end.ref === undefined ? null : portOfRef(doc, end.ref);
    if (port === null) return { move: null, port: null };
    const move = sub3(port.position, end.point);
    return { move: len3(move) <= eps ? [0, 0, 0] : move, port: port.position };
  };
  const [start, end] = [side(run.start), side(run.end)];
  return { startMove: start.move, endMove: end.move, startPort: start.port, endPort: end.port };
}

/** The edit the params describe, or the reason they do not. */
function editOf(
  run: PipeRun,
  p: {
    op: string;
    index: number;
    delta?: Vec3 | undefined;
    point?: Vec3 | undefined;
    length?: number | undefined;
    points?: Vec3[] | undefined;
    count?: number | undefined;
    mode?: 'orthogonal' | 'free' | undefined;
  },
): RouteEdit | { readonly path: string; readonly message: string } {
  const unused = (names: ReadonlyArray<keyof typeof p>): { path: string; message: string } | null => {
    const extra = names.find((name) => p[name] !== undefined);
    return extra === undefined ? null : { path: String(extra), message: `${String(extra)} does not apply to op ${p.op}` };
  };
  switch (p.op) {
    case 'move_pi': {
      const bad = unused(['length', 'points', 'count']);
      if (bad !== null) return bad;
      if ((p.delta === undefined) === (p.point === undefined))
        return { path: 'delta', message: 'move_pi needs exactly one of delta [dx, dy, dz] and point [x, y, z]' };
      const current = runPoints(run)[p.index + 1];
      const by = p.delta ?? (current === undefined || p.point === undefined ? ([0, 0, 0] as Vec3) : sub3(p.point, current));
      return { op: 'move_pi', index: p.index, by, mode: p.mode ?? 'orthogonal' };
    }
    case 'stretch_leg': {
      const bad = unused(['delta', 'point', 'points', 'count', 'mode']);
      if (bad !== null) return bad;
      return p.length === undefined || !(p.length > 0)
        ? { path: 'length', message: 'stretch_leg needs length > 0 (the new length of the leg between its points of intersection, mm)' }
        : { op: 'stretch_leg', index: p.index, length: p.length };
    }
    case 'insert_pi': {
      const bad = unused(['delta', 'length', 'count', 'mode']);
      if (bad !== null) return bad;
      const points = p.points ?? (p.point === undefined ? [] : [p.point]);
      return points.length === 0
        ? { path: 'points', message: 'insert_pi needs points [[x, y, z], ...] (or point) to insert into the leg, in order from its start' }
        : { op: 'insert_pi', index: p.index, points };
    }
    default: {
      const bad = unused(['delta', 'point', 'points', 'length', 'mode']);
      return bad ?? { op: 'delete_pi', index: p.index, count: p.count ?? 1 };
    }
  }
}

/** RTE_PORT_DIRECTION text when the first / last leg of `run` no longer leaves / arrives along its port direction, else null. */
function portDirectionProblem(run: PipeRun, toleranceDeg: number): { message: string; path: string } | null {
  const points = runPoints(run);
  for (const side of ['start', 'end'] as const) {
    const direction = run[side].direction;
    if (direction === undefined) continue;
    const [a, b] = side === 'start' ? [points[0], points[1]] : [points.at(-1), points.at(-2)];
    if (a === undefined || b === undefined) continue;
    const leg = unitVector(sub3(b, a));
    // A leg with a declared slope is judged on its plan direction, as route_pipe does.
    const slopeLeg = run.legSlopes?.[side === 'start' ? 0 : points.length - 2] ?? null;
    const flat = slopeLeg !== null && isSloped(leg) ? unitVector([leg[0], leg[1], 0]) : leg;
    const deviation = angleBetweenDeg(flat, unitVector(direction));
    if (deviation > toleranceDeg)
      return {
        message: `the ${side} leg now leaves ${+deviation.toFixed(4)} deg off the ${side} port direction (tolerance ${toleranceDeg} deg)`,
        path: side === 'start' ? 'legs.0' : 'legs',
      };
  }
  return null;
}

/**
 * @affects changes the stored points of intersection of 1 run (and, in step with them, the leg index / distance of its inline components and
 *   branches and its declared leg slopes); re-derives the run, stretches the branch and continuation runs attached to it, rebuilds their parts
 * @invariant `move_pi` and `stretch_leg` keep every leg direction (orthogonal stretch: the move is absorbed by parallel legs, the rest carried to the next
 *   point; a connected end never moves); components keep the distance from the end of their leg that did not move; collinear points merge
 * @failure unknown run -> RTE_UNKNOWN_RUN; bad op parameters or an index out of range -> RTE_EDIT_INVALID; a move no leg can absorb, a connected end ->
 *   RTE_STRETCH_FAILED; a vanishing leg -> RTE_ZERO_LEG; a first / last leg off its port -> RTE_PORT_DIRECTION; a run, branch or continuation that no
 *   longer derives -> its RTE_* code (angle with no spec elbow, leg too short, component does not fit ...); document unchanged
 */
export const editRoute = defineCommand({
  name: 'edit_route',
  description:
    'Edit the route of a spec-driven pipe run (route_pipe / auto_route_pipe / add_branch) and re-derive it. Legs are [start, ...pis, end]; a point of ' +
    'intersection (PI) is run.pis[index] (0 = the first interior point); a leg index is the merged-leg index of route_pipe data.legs. ops: ' +
    '"move_pi" { index, delta [dx,dy,dz] | point [x,y,z], mode } moves PI `index`; mode "orthogonal" (default) is the orthogonal stretch: every leg keeps its ' +
    'direction (and slope), the part of the move along a neighbouring leg lengthens / shortens it and the rest is carried, perpendicular, to the next ' +
    'point (a connected end never moves; with no parallel leg left the move is refused RTE_STRETCH_FAILED); mode "free" moves exactly that point, the ' +
    'two legs at it turn (their elbows must still match the spec angles, else the derivation code refuses); "stretch_leg" { index, length } sets the ' +
    'length of leg `index` by moving its end point orthogonally (a leg ending at a port cannot; stretch an earlier leg); "insert_pi" { index, points ' +
    '[[x,y,z]...] } adds points of intersection into leg `index` (give all the points of a jog at once so every elbow is valid); "delete_pi" { index, ' +
    'count } removes `count` PIs from `index` (the legs between merge into one straight leg). Collinear points merge. Inline components and branches ' +
    'keep the distance from the end of their leg that did not move and are re-indexed when legs merge or split (data.remapped lists them); one on a ' +
    'leg the edit removes, or that would leave its leg, refuses the edit (move it first). Branch runs and runs continuing from this one are ' +
    'stretched with it; if one cannot follow the edit is refused. Works on a run broken by a moved port: the ends then follow their ports as part of ' +
    'the edit. Returns the run id (affected[0]) and the stretched dependents; data = { runId, op, pis, legs (index, direction, lengthMm, cutLengthsMm, ' +
    'dropMm / slopeDeg on sloped legs), legChanges, remapped, dependents, pipePieces, totalPipeMm, centrelineLengthMm, warnings, unverified }. Refusals: ' +
    'RTE_UNITS_UNSUPPORTED, RTE_UNKNOWN_RUN, RTE_EDIT_INVALID, RTE_STRETCH_FAILED, RTE_ZERO_LEG, RTE_PORT_DIRECTION and any derivation code ' +
    '(RTE_NO_FITTING_FOR_ANGLE, RTE_SEGMENT_TOO_SHORT, RTE_INLINE_DOES_NOT_FIT, RTE_BRANCH_ON_FITTING ...). Next: piping_takeoff, check_piping.',
  params: z.object({
    runId: z.string().describe('Pipe run id (affected[0] of route_pipe / auto_route_pipe / add_branch).'),
    op: z.enum(['move_pi', 'stretch_leg', 'insert_pi', 'delete_pi']).describe('The edit: move_pi, stretch_leg, insert_pi or delete_pi.'),
    index: z
      .number()
      .int()
      .min(0)
      .describe(
        'move_pi / delete_pi: index of the PI in run.pis (0 = first). stretch_leg / insert_pi: index of the leg (0 = first, route_pipe data.legs).',
      ),
    delta: vec3('move_pi: displacement [dx, dy, dz] of the PI, mm. Give this or point.').optional(),
    point: vec3(
      'move_pi: new position [x, y, z] of the PI, mm. Give this or delta. insert_pi: a single point to insert (or use points).',
    ).optional(),
    length: z
      .number()
      .positive()
      .optional()
      .describe('stretch_leg: the new length of the leg between its points of intersection, mm (> 0).'),
    points: z
      .array(vec3('Point of intersection [x, y, z], mm.'))
      .optional()
      .describe('insert_pi: points of intersection to add into the leg, in order from its start, mm.'),
    count: z.number().int().min(1).optional().describe('delete_pi: how many consecutive PIs to remove from index (default 1).'),
    mode: z
      .enum(['orthogonal', 'free'])
      .optional()
      .describe('move_pi: "orthogonal" (default) keeps every leg direction; "free" moves only that point and turns the two legs at it.'),
  }),
  run: (doc, params): CommandResult => {
    if (doc.units !== 'mm')
      return refuse(
        doc,
        'edit_route',
        'RTE_UNITS_UNSUPPORTED',
        `plant lengths and catalogue dimensions are mm; this document is in ${doc.units}`,
      );
    const piping = getPiping(doc);
    const run = piping.runs[params.runId];
    if (run === undefined) return refuse(doc, 'edit_route', 'RTE_UNKNOWN_RUN', `no pipe run "${params.runId}"`, [], ['runId']);
    const edit = editOf(run, params);
    if ('message' in edit) return refuse(doc, 'edit_route', 'RTE_EDIT_INVALID', edit.message, [run.id], [edit.path]);
    const edited = editRun(run, edit, endContext(doc, run));
    if (!edited.ok) return refuse(doc, 'edit_route', edited.code, edited.message, [run.id], [...edited.paths], edited.detail);
    const { broken, ...stored } = edited.run;
    void broken;
    if (run.broken === undefined && JSON.stringify(stored) === JSON.stringify(run))
      return noop(doc, `edit_route: no change: the edit leaves run ${run.id} as it is (collinear points merge).`);
    let working = withRunStored(doc, stored);
    const derived = deriveRun(working, stored);
    if (!derived.ok)
      return refuse(doc, 'edit_route', derived.code, derived.message, [run.id, ...derived.ids], [...derived.paths], derived.detail);
    const portProblem = portDirectionProblem(stored, derived.angleTolerance.valueDeg);
    if (portProblem !== null) return refuse(doc, 'edit_route', 'RTE_PORT_DIRECTION', portProblem.message, [run.id], [portProblem.path]);
    // Runs attached to this one (branches on its legs, runs continuing from its ends) follow the points that moved.
    const dependents = withDependents(piping, run.id).slice(1);
    const followed: string[] = [];
    for (const id of dependents) {
      const dependent = getPiping(working).runs[id];
      const outcome = dependent === undefined ? undefined : stretchRun(working, dependent);
      if (outcome?.kind === 'failed')
        return refuse(
          doc,
          'edit_route',
          'RTE_STRETCH_FAILED',
          `run ${id} cannot follow the edit: ${outcome.reason}`,
          [run.id, id],
          ['runId'],
          outcome.detail,
        );
      if (outcome?.kind !== 'stretched') continue;
      working = outcome.document;
      followed.push(id);
    }
    const result = rederive(working, [run.id]);
    if (!result.ok) return refuseDerivation(doc, 'edit_route', result, run.id);
    const derivation = result.derivations[run.id];
    if (derivation === undefined) return refuse(doc, 'edit_route', 'RTE_UNKNOWN_RUN', `run ${run.id} did not derive`, [run.id], ['runId']);
    const takeoff = takeoffOf([{ runId: run.id, derivation }]);
    const now = result.document.plant?.piping?.runs[run.id];
    return {
      ...changed(
        result.document,
        `edit_route: ${params.op} on run ${run.id}: ${edited.legChanges.map((c) => `leg ${c.leg} (${c.direction}) ${c.changeMm > 0 ? '+' : ''}${+c.changeMm.toFixed(3)} mm`).join(', ') || 'no leg changed length'}; ` +
          `${now?.pis.length ?? 0} PI(s), ${takeoff.pipePieces.length} pipe piece(s) totalling ${takeoff.totalPipeMm} mm` +
          `${edited.remapped.length === 0 ? '' : `; re-placed ${edited.remapped.join('; ')}`}${followed.length === 0 ? '' : `; stretched ${followed.join(', ')} with it`}` +
          `${derivation.unverified ? `; unverified: ${derivation.unverifiedReasons.join('; ')}` : ''}.`,
        [run.id, ...followed],
      ),
      data: {
        runId: run.id,
        op: params.op,
        pis: now?.pis ?? [],
        legs: takeoff.legs.map((leg) => ({
          index: leg.index,
          direction: leg.direction,
          lengthMm: leg.lengthMm,
          cutLengthsMm: leg.cutLengthsMm,
          ...(leg.dropMm === undefined ? {} : { planLengthMm: leg.planLengthMm, dropMm: leg.dropMm, slopeDeg: leg.slopeDeg }),
        })),
        legChanges: edited.legChanges,
        remapped: edited.remapped,
        dependents: followed,
        pipePieces: takeoff.pipePieces.map((piece) => ({ id: piece.id, leg: piece.leg, cutLengthMm: piece.cutLengthMm })),
        totalPipeMm: takeoff.totalPipeMm,
        centrelineLengthMm: takeoff.centrelineLengthMm,
        warnings: takeoff.warnings,
        unverified: takeoff.unverified,
        unverifiedReasons: takeoff.unverifiedReasons,
      },
    };
  },
});
