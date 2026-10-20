/**
 * Builds the canonical auto-route problem from the document (02 RTE §2.A `route_problem`): ports -> stubs (one LR 90 elbow centre-to-end,
 * plus the flange set on flanged ends), lattice, bounds, integer costs and inflated obstacle boxes. Pure: the same document and request
 * give the same problem and the same sha256 `problemHash`.
 */

import { is3D, type CadDocument } from '@core/model/types';
import type { PipeLine, PipingModel, PortRef } from '@core/model/plant';
import type { Vec3 } from '@core/model/vectors';
import { entityBoundsInDoc } from '@core/geometry/bounds';
import { sha256Hex } from '@lib/sha256';
import { getPiping } from '../model';
import { ELBOW_SOURCE, elbowCentreToEnd, pipeOutsideDiameter } from '../sizes';
import { runPoints } from '../derive';
import { AXIS_VECTORS, firstBlocking, type Int3, type ObstacleBox, type RouteProblem } from './lattice';

export type Endpoint = { readonly portId: string } | { readonly point: Vec3; readonly direction: Vec3 };

export interface RouteRequest {
  readonly lineId: string;
  readonly from: Endpoint;
  readonly to: Endpoint;
  readonly grid?: number | undefined;
  readonly bendCost?: number | undefined;
  readonly clearance?: number | undefined;
  readonly gridMargin?: number | undefined;
  readonly preferElevations?: readonly number[] | undefined;
  readonly elevationPenalty?: number | undefined;
  readonly keepOut?: readonly string[] | undefined;
  readonly keepOutBoxes?: readonly { readonly min: Vec3; readonly max: Vec3 }[] | undefined;
  readonly elbowCentreToEnd?: number | undefined;
  readonly flangeSetLength?: number | undefined;
}

/** Named defaults (reported in `data.defaults` when used). */
export const ROUTE_DEFAULTS = { grid: 50, bendCost: 1000, clearance: 50, gridMargin: 2000, elevationPenalty: 0.5 } as const;

export interface ResolvedEnd {
  readonly point: Vec3;
  readonly direction: Vec3;
  readonly ref?: PortRef;
}

export interface BuiltProblem {
  readonly ok: true;
  readonly problem: RouteProblem;
  readonly problemHash: string;
  readonly line: PipeLine;
  readonly from: ResolvedEnd;
  readonly to: ResolvedEnd;
  readonly info: {
    readonly defaults: Readonly<Record<string, number>>;
    readonly elbowCentreToEnd: { readonly value: number; readonly source: string };
    readonly portOwners: readonly string[];
    readonly unverified: true;
  };
}

export interface ProblemRefusal {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}

const refusal = (code: string, message: string, paths: readonly string[], ids: readonly string[] = []): ProblemRefusal => ({
  ok: false,
  code,
  message,
  ids,
  paths,
});

const um = (mm: number): number => Math.round(mm * 1000);
const toUm = (p: Vec3): Int3 => [um(p[0]), um(p[1]), um(p[2])];
const plus = (p: Int3, axis: number, length: number): Int3 => {
  const v = AXIS_VECTORS[axis] as Int3;
  return [p[0] + v[0] * length, p[1] + v[1] * length, p[2] + v[2] * length];
};

/** Axis index of a unit axis direction, or null. */
function axisIndex(direction: Vec3): number | null {
  const length = Math.hypot(...direction);
  if (!(length > 0)) return null;
  for (let axis = 0; axis < 6; axis++) {
    const v = AXIS_VECTORS[axis] as Int3;
    if (
      Math.abs(direction[0] / length - v[0]) < 1e-9 &&
      Math.abs(direction[1] / length - v[1]) < 1e-9 &&
      Math.abs(direction[2] / length - v[2]) < 1e-9
    )
      return axis;
  }
  return null;
}

interface PortEnd extends ResolvedEnd {
  readonly flanged: boolean;
}

function resolveEnd(piping: PipingModel, line: PipeLine, endpoint: Endpoint, path: 'from' | 'to'): PortEnd | ProblemRefusal {
  if (!('portId' in endpoint)) return { point: endpoint.point, direction: endpoint.direction, flanged: false };
  const tieIn = piping.tieIns[endpoint.portId];
  if (tieIn === undefined) return refusal('RTE_UNKNOWN_PORT', `no tie-in point "${endpoint.portId}"`, [`${path}.portId`]);
  const user = piping.runOrder.find((id) => {
    const run = piping.runs[id];
    return run?.start.ref?.id === tieIn.id || run?.end.ref?.id === tieIn.id;
  });
  if (user !== undefined)
    return refusal('RTE_PORT_IN_USE', `tie-in ${tieIn.id} is already connected by run ${user}`, [`${path}.portId`], [tieIn.id, user]);
  if (tieIn.port.dn !== line.dn)
    return refusal(
      'RTE_SIZE_MISMATCH',
      `tie-in ${tieIn.id} is DN${tieIn.port.dn}, line ${line.id} is DN${line.dn}`,
      [`${path}.portId`],
      [tieIn.id, line.id],
    );
  return {
    point: tieIn.port.position,
    direction: tieIn.port.direction,
    ref: { kind: 'tieIn', id: tieIn.id },
    flanged: tieIn.port.endType === 'FL',
  };
}

/** Inflated world boxes: 3D entities (not run meshes), legs of existing runs, explicit keep-out boxes. */
function collectObstacles(
  doc: CadDocument,
  piping: PipingModel,
  radius: number,
  request: RouteRequest,
): { obstacles: ObstacleBox[]; keepOutIds: ReadonlySet<string> } | ProblemRefusal {
  const inflate = (id: string, min: Vec3, max: Vec3, extra: number): ObstacleBox => ({
    id,
    min: [Math.floor((min[0] - extra) * 1000), Math.floor((min[1] - extra) * 1000), Math.floor((min[2] - extra) * 1000)],
    max: [Math.ceil((max[0] + extra) * 1000), Math.ceil((max[1] + extra) * 1000), Math.ceil((max[2] + extra) * 1000)],
  });
  const keepOut = new Set(request.keepOut ?? []);
  const unknown = [...keepOut].filter((id) => doc.entities[id] === undefined);
  if (unknown.length > 0) return refusal('RTE_UNKNOWN_KEEPOUT', `no entity ${unknown.join(', ')}`, ['keepOut'], unknown);
  const runIds = new Set(piping.runOrder);
  const obstacles: ObstacleBox[] = [];
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (entity === undefined || runIds.has(id) || !is3D(entity)) continue;
    const { min, max } = entityBoundsInDoc(doc, entity);
    if ([...min, ...max].every(Number.isFinite)) obstacles.push(inflate(id, min, max, radius));
  }
  for (const runId of piping.runOrder) {
    const run = piping.runs[runId];
    const other = run === undefined ? undefined : piping.lines[run.lineId];
    if (run === undefined || other === undefined) continue;
    const otherRadius = (pipeOutsideDiameter(other.dn) ?? 0) / 2 + (other.insulation?.thicknessMm ?? 0);
    const points = runPoints(run);
    for (let leg = 0; leg + 1 < points.length; leg++) {
      const [a, b] = [points[leg] as Vec3, points[leg + 1] as Vec3];
      const min: Vec3 = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
      const max: Vec3 = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
      obstacles.push(inflate(`${runId}#leg${leg}`, min, max, radius + otherRadius));
    }
  }
  (request.keepOutBoxes ?? []).forEach((box, index) => {
    const id = `keepOutBox#${index}`;
    keepOut.add(id);
    const lower: Vec3 = [Math.min(box.min[0], box.max[0]), Math.min(box.min[1], box.max[1]), Math.min(box.min[2], box.max[2])];
    const upper: Vec3 = [Math.max(box.min[0], box.max[0]), Math.max(box.min[1], box.max[1]), Math.max(box.min[2], box.max[2])];
    obstacles.push(inflate(id, lower, upper, radius));
  });
  return { obstacles, keepOutIds: keepOut };
}

const strictlyInside = (p: Int3, box: ObstacleBox): boolean =>
  p.every((v, axis) => v > (box.min[axis] as number) && v < (box.max[axis] as number));

/**
 * @failure unknown line / port / keep-out, port in use, size mismatch, non-axis port, missing elbow or flange-set length, ports off a
 *   common lattice or a blocked port stub -> ProblemRefusal (RTE_* code, ids, param paths)
 */
export function buildRouteProblem(doc: CadDocument, request: RouteRequest): BuiltProblem | ProblemRefusal {
  if (doc.units !== 'mm')
    return refusal('RTE_UNITS_UNSUPPORTED', `auto-routing reads plant lengths in mm; this document is in ${doc.units}`, []);
  const piping = getPiping(doc);
  const line = piping.lines[request.lineId];
  if (line === undefined) return refusal('RTE_UNKNOWN_LINE', `no pipe line "${request.lineId}"`, ['lineId']);
  const from = resolveEnd(piping, line, request.from, 'from');
  if ('ok' in from) return from;
  const to = resolveEnd(piping, line, request.to, 'to');
  if ('ok' in to) return to;
  const fromAxis = axisIndex(from.direction);
  const toAxis = axisIndex(to.direction);
  if (fromAxis === null || toAxis === null)
    return refusal('RTE_PORT_DIRECTION', 'auto-routing needs both port directions along a world axis', [fromAxis === null ? 'from' : 'to']);
  const defaults: Record<string, number> = {};
  const pick = <K extends keyof typeof ROUTE_DEFAULTS>(key: K): number => {
    const given = request[key];
    if (given !== undefined) return given;
    defaults[key] = ROUTE_DEFAULTS[key];
    return ROUTE_DEFAULTS[key];
  };
  const cellUm = um(pick('grid'));
  if (cellUm < 1) return refusal('RTE_AUTOROUTE_NO_PATH', 'the grid cell rounds to 0 µm', ['grid']);
  const elbow = request.elbowCentreToEnd ?? elbowCentreToEnd(line.dn);
  if (elbow === null)
    return refusal('RTE_SPEC_NO_COMPONENT', `no LR 90 elbow row for DN${line.dn} (until 01 PSC): pass elbowCentreToEnd`, [
      'elbowCentreToEnd',
    ]);
  const flangeless = !from.flanged && !to.flanged;
  if (!flangeless && request.flangeSetLength === undefined)
    return refusal(
      'RTE_SPEC_NO_COMPONENT',
      'a flanged port needs the flange-set length (gasket + flange through hub) until 01 PSC: pass flangeSetLength',
      ['flangeSetLength'],
    );
  const stubUm = (flanged: boolean): number => Math.ceil(um(elbow + (flanged ? (request.flangeSetLength ?? 0) : 0)) / cellUm) * cellUm;
  const fromStub = stubUm(from.flanged);
  const toStub = stubUm(to.flanged);
  const fromUm = toUm(from.point);
  const toPointUm = toUm(to.point);
  const originUm = plus(fromUm, fromAxis, fromStub);
  const goalPointUm = plus(toPointUm, toAxis, toStub);
  const offset = goalPointUm.map((v, dim) => (v - (originUm[dim] as number)) / cellUm);
  if (!offset.every(Number.isInteger))
    return refusal(
      'RTE_AUTOROUTE_NO_PATH',
      `the port stubs are not on a common ${cellUm / 1000} mm lattice (offset ${offset.join(', ')} cells)`,
      ['grid'],
    );
  const goalCell = offset as unknown as Int3;
  const margin = Math.ceil(um(pick('gridMargin')) / cellUm);
  const bounds = {
    min: goalCell.map((v) => Math.min(0, v) - margin) as unknown as Int3,
    max: goalCell.map((v) => Math.max(0, v) + margin) as unknown as Int3,
  };
  const radius = (pipeOutsideDiameter(line.dn) ?? 0) / 2 + (line.insulation?.thicknessMm ?? 0) + pick('clearance');
  const collected = collectObstacles(doc, piping, radius, request);
  if ('ok' in collected) return collected;
  const states = bounds.max.reduce((total, max, dim) => total * (max - (bounds.min[dim] as number) + 1), 6);
  if (states > Number.MAX_SAFE_INTEGER)
    return refusal(
      'RTE_AUTOROUTE_BUDGET',
      `the grid box holds ${states} lattice states (limit 2^53): use a coarser grid or a smaller gridMargin`,
      ['gridMargin'],
    );
  // Obstacles touching the lattice box or either port stub (the stubs end outside the box when gridMargin is small).
  const lo = bounds.min.map((v, dim) => Math.min((originUm[dim] as number) + v * cellUm, fromUm[dim] as number, toPointUm[dim] as number));
  const hi = bounds.max.map((v, dim) => Math.max((originUm[dim] as number) + v * cellUm, fromUm[dim] as number, toPointUm[dim] as number));
  const relevant = collected.obstacles.filter((box) =>
    box.min.every((min, dim) => min <= (hi[dim] as number) && (box.max[dim] as number) >= (lo[dim] as number)),
  );
  const portOwners = relevant
    .filter((box) => !collected.keepOutIds.has(box.id) && (strictlyInside(fromUm, box) || strictlyInside(toPointUm, box)))
    .map((box) => box.id);
  const stubObstacles = relevant.filter((box) => !portOwners.includes(box.id));
  for (const [start, end, path] of [
    [fromUm, originUm, 'from'],
    [goalPointUm, toPointUm, 'to'],
  ] as const) {
    const blocking = firstBlocking(start, end, stubObstacles);
    if (blocking !== null) return refusal('RTE_AUTOROUTE_NO_PATH', `the ${path} port stub runs into ${blocking.id}`, [path], [blocking.id]);
  }
  const elevations = request.preferElevations ?? [];
  const penalty = elevations.length > 0 ? pick('elevationPenalty') : 0;
  const problem: RouteProblem = {
    version: 1,
    cellUm,
    originUm,
    bounds,
    from: { pointUm: fromUm, axis: fromAxis, stubUm: fromStub },
    to: { pointUm: toPointUm, axis: toAxis ^ 1, stubUm: toStub },
    goal: { cell: goalCell, axis: toAxis ^ 1 },
    minLegCells: Math.max(1, Math.ceil(um(2 * elbow) / cellUm)),
    bendCostUm: um(pick('bendCost')),
    preferredK: [...new Set(elevations.map((z) => Math.round((um(z) - originUm[2]) / cellUm)))].sort((a, b) => a - b),
    offElevationPenaltyPerCellUm: Math.round(cellUm * penalty),
    obstacles: relevant,
  };
  return {
    ok: true,
    problem,
    problemHash: sha256Hex(JSON.stringify(problem)),
    line,
    from,
    to,
    info: {
      defaults,
      elbowCentreToEnd: { value: elbow, source: request.elbowCentreToEnd === undefined ? ELBOW_SOURCE : 'param elbowCentreToEnd' },
      portOwners,
      unverified: true,
    },
  };
}
