/**
 * Builds the canonical auto-route problem from the document (02 RTE §2.A `route_problem`): ports -> stubs (one LR 90 elbow centre-to-end,
 * plus the flange set on flanged ends), lattice, bounds, integer costs and inflated obstacle boxes. Pure: the same document and request
 * give the same problem and the same sha256 `problemHash`.
 */

import type { CadDocument } from '@core/model/types';
import type { PipeLine, PortRef, PortSpec } from '@aec/plant/types';
import type { Vec3 } from '@core/model/vectors';
import { sha256Hex } from '@lib/sha256';
import { getPiping } from '../model';
import { portOccupant, resolvePortId } from '../ports';
import { resolveFlangeSet } from '../flangeSet';
import { createSpecLookup, isMiss, pipeOutsideDiameter } from '../specLookup';
import { AXIS_VECTORS, firstBlocking, type Int3, type ObstacleBox, type RouteProblem } from './lattice';
import { collectObstacles } from './obstacles';

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
    /** Gasket + flange length through hub per flanged port (mm), absent for butt-weld / open ends. */
    readonly flangeSetLengths: { readonly from?: number; readonly to?: number };
    readonly portOwners: readonly string[];
    readonly unverified: boolean;
    readonly unverifiedReasons: readonly string[];
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
  /** The port the end is connected to (absent for an open end): its end type decides the flange set. */
  readonly port?: PortSpec;
}

function resolveEnd(doc: CadDocument, line: PipeLine, endpoint: Endpoint, path: 'from' | 'to'): PortEnd | ProblemRefusal {
  if (!('portId' in endpoint)) return { point: endpoint.point, direction: endpoint.direction };
  const resolved = resolvePortId(doc, endpoint.portId);
  if (!resolved.ok) return refusal('RTE_UNKNOWN_PORT', resolved.message, [`${path}.portId`]);
  const { port } = resolved;
  const user = portOccupant(doc, port.ref);
  if (user !== undefined)
    return refusal('RTE_PORT_IN_USE', `port ${port.id} is already connected (${user})`, [`${path}.portId`], [port.id, user]);
  if (port.spec.dn !== line.dn)
    return refusal(
      'RTE_SIZE_MISMATCH',
      `port ${port.id} is DN${port.spec.dn}, line ${line.id} is DN${line.dn}`,
      [`${path}.portId`],
      [port.id, line.id],
    );
  return { point: port.spec.position, direction: port.spec.direction, ref: port.ref, port: port.spec };
}

interface StubParts {
  readonly elbow: number;
  readonly elbowSource: string;
  readonly flangeLengths: { from?: number; to?: number };
  readonly unverifiedReasons: string[];
}

/** Elbow centre-to-end A and flange-set lengths from the line's spec (never a formula): the stub of a port is A + its flange set. */
function stubParts(doc: CadDocument, line: PipeLine, ends: { from: PortEnd; to: PortEnd }): StubParts | ProblemRefusal {
  const lookup = createSpecLookup(doc, line.spec);
  if (isMiss(lookup)) return refusal(lookup.miss, lookup.detail, ['lineId'], [line.id]);
  const row = lookup.component({ types: ['elbow90'], dn: line.dn });
  if (isMiss(row)) return refusal(row.miss, row.detail, ['lineId'], [line.id, ...row.ids]);
  const elbow = row.dims['centreToEnd'];
  if (elbow === undefined) return refusal('RTE_SPEC_NO_COMPONENT', `elbow row ${row.key} has no centreToEnd`, ['lineId'], [row.key]);
  const reasons: string[] = [];
  if (lookup.status() !== 'approved') reasons.push(`spec ${lookup.id} r${lookup.revision} is ${lookup.status()}, not approved`);
  if (row.unverified) reasons.push(`elbow row ${row.key} is not grade A`);
  const flangeLengths: { from?: number; to?: number } = {};
  for (const side of ['from', 'to'] as const) {
    const port = ends[side].port;
    if (port?.endType !== 'FL') continue;
    const pipe = lookup.pipe(line.dn);
    const set = resolveFlangeSet(lookup, port, line.dn, isMiss(pipe) ? 'BW' : (pipe.pipeEnd ?? 'BW'));
    if ('code' in set) return refusal(set.code, set.message, [`${side}.portId`], set.ids);
    flangeLengths[side] = set.length;
    for (const part of [set.flange, set.gasket, set.bolts]) if (part.unverified) reasons.push(`${part.key} is not grade A`);
  }
  return { elbow, elbowSource: `${row.key} (${row.source})`, flangeLengths, unverifiedReasons: reasons };
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
  const from = resolveEnd(doc, line, request.from, 'from');
  if ('ok' in from) return from;
  const to = resolveEnd(doc, line, request.to, 'to');
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
  const stubs = stubParts(doc, line, { from, to });
  if ('ok' in stubs) return stubs;
  const elbow = stubs.elbow;
  const stubUm = (flangeLength: number | undefined): number => Math.ceil(um(elbow + (flangeLength ?? 0)) / cellUm) * cellUm;
  const fromStub = stubUm(stubs.flangeLengths.from);
  const toStub = stubUm(stubs.flangeLengths.to);
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
  const radius = (pipeOutsideDiameter(doc, line.spec, line.dn) ?? 0) / 2 + (line.insulation?.thicknessMm ?? 0) + pick('clearance');
  const collected = collectObstacles(doc, piping, radius, request);
  if ('code' in collected) return refusal(collected.code, collected.message, collected.paths, collected.ids);
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
      elbowCentreToEnd: { value: elbow, source: stubs.elbowSource },
      flangeSetLengths: stubs.flangeLengths,
      portOwners,
      unverified: stubs.unverifiedReasons.length > 0,
      unverifiedReasons: stubs.unverifiedReasons,
    },
  };
}
