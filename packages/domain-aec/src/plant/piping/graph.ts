/**
 * Connectivity graph of derived runs (02 RTE §5.8): nodes are parts and external ports (tie-ins, equipment nozzles), edges are joints,
 * attachments of a part port to an external port (an olet is joined to its header piece by its weld joint). A part port is connected when another part port or an
 * external port lies at the same point with the opposite direction (or within a joint's gap), so the graph needs nothing but the derived parts.
 * Open ends are the part ports that connect to nothing; disagreements across a connection (size, rating, facing, end type) are listed.
 * @invariant pure; ports are matched on a 0.05 mm grid with a 0.01 mm tolerance and 1 degree between opposite directions
 */

import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import type { EndType, Joint, PartPort, PipeRun, PortSpec, RoutedPart } from '@aec/plant/types';
import { dot3, len3, sub3 } from '@lib/vec3';
import { elementsOf, getBuilding } from '../../building/model';
import { equipmentPorts } from '../equipment/geometry/ports';
import { isFailure, type DerivationFailure, type RunDerivation } from './deriveTypes';
import { getPiping } from './model';
import { deriveRun } from './routeParts';
import { connectedRuns } from './runLinks';

export interface GraphRun {
  readonly runId: string;
  readonly lineId: string;
  readonly derivation: RunDerivation;
}

export interface ExternalPort {
  /** The port id an agent passes: tie-in id or `<tag>:<mark>`. */
  readonly id: string;
  readonly tag: string;
  readonly kind: 'tieIn' | 'nozzle';
  readonly spec: PortSpec;
}

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'joint' | 'attachment';
  readonly jointKind?: Joint['kind'];
  readonly position: Vec3;
}

export interface OpenEnd {
  readonly partId: string;
  readonly portIndex: number;
  readonly runId: string;
  readonly lineId: string;
  readonly position: Vec3;
  readonly direction: Vec3;
  readonly dn: number;
  readonly endType: EndType;
}

export type MismatchCode = 'RTE_SIZE_MISMATCH' | 'RTE_RATING_MISMATCH' | 'RTE_FACING_MISMATCH' | 'RTE_END_TYPE_MISMATCH';

export interface Mismatch {
  readonly code: MismatchCode;
  readonly a: string;
  readonly b: string;
  readonly position: Vec3;
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface RunGraph {
  readonly parts: ReadonlyMap<string, { readonly part: RoutedPart; readonly runId: string; readonly lineId: string }>;
  readonly externals: ReadonlyMap<string, ExternalPort>;
  readonly edges: readonly GraphEdge[];
  readonly openEnds: readonly OpenEnd[];
  readonly mismatches: readonly Mismatch[];
  /** External ports attached to a part of the selected runs. */
  readonly attached: ReadonlySet<string>;
  /** Connected components: ids of parts and external ports, parts in route order. */
  readonly components: ReadonlyArray<readonly string[]>;
}

const CELL = 0.05;
const TOLERANCE = 0.01;
/** cos of 1 degree: opposite directions must be at least this anti-parallel. */
const OPPOSITE = Math.cos((1 * Math.PI) / 180);

interface PortRecord {
  readonly owner: string;
  readonly index: number;
  readonly port: PartPort;
  readonly external: boolean;
}

const cellOf = (value: number): number => Math.round(value / CELL);
const keyOf = (position: Vec3): string => `${cellOf(position[0])}|${cellOf(position[1])}|${cellOf(position[2])}`;

/** Every tie-in and equipment nozzle of the document as an external port. */
export function externalPorts(doc: CadDocument): ExternalPort[] {
  const piping = getPiping(doc);
  const ties = piping.tieInOrder.flatMap((id) => {
    const tie = piping.tieIns[id];
    return tie === undefined ? [] : [{ id, tag: tie.tag, kind: 'tieIn' as const, spec: tie.port }];
  });
  const nozzles = elementsOf(getBuilding(doc), 'equipment').flatMap((element) =>
    equipmentPorts(doc, element).map((port) => ({
      id: port.id,
      tag: port.tag,
      kind: 'nozzle' as const,
      spec: {
        position: port.position,
        direction: port.direction,
        dn: port.dn,
        endType: 'FL' as const,
        rating: port.rating,
        facing: port.facing,
      },
    })),
  );
  return [...ties, ...nozzles];
}

const specToPort = (spec: PortSpec): PartPort => ({
  position: spec.position,
  direction: spec.direction,
  dn: spec.dn,
  endType: spec.endType,
  ...(spec.rating === undefined ? {} : { rating: spec.rating }),
  ...(spec.facing === undefined ? {} : { facing: spec.facing }),
});

const normal = (text: string | undefined): string => (text ?? '').replace(/\s+/g, '').toUpperCase();

function mismatchesOf(a: PortRecord, b: PortRecord): Mismatch[] {
  const found: Mismatch[] = [];
  const base = { a: a.owner, b: b.owner, position: a.port.position };
  if (a.port.dn !== b.port.dn) found.push({ ...base, code: 'RTE_SIZE_MISMATCH', detail: { dnA: a.port.dn, dnB: b.port.dn } });
  if (a.port.rating !== undefined && b.port.rating !== undefined && normal(a.port.rating) !== normal(b.port.rating))
    found.push({ ...base, code: 'RTE_RATING_MISMATCH', detail: { ratingA: a.port.rating, ratingB: b.port.rating } });
  if (a.port.facing !== undefined && b.port.facing !== undefined && a.port.facing !== b.port.facing)
    found.push({ ...base, code: 'RTE_FACING_MISMATCH', detail: { facingA: a.port.facing, facingB: b.port.facing } });
  if (a.port.endType !== b.port.endType)
    found.push({ ...base, code: 'RTE_END_TYPE_MISMATCH', detail: { endTypeA: a.port.endType, endTypeB: b.port.endType } });
  return found;
}

/**
 * The graph of `runs` (derived) against the document's external ports.
 * @invariant a pair of ports is matched once; an external port matches any number of part ports only if each is at its position (normally one)
 */
export function buildGraph(doc: CadDocument, runs: readonly GraphRun[]): RunGraph {
  const parts = new Map<string, { part: RoutedPart; runId: string; lineId: string }>();
  const records: PortRecord[] = [];
  for (const { runId, lineId, derivation } of runs)
    for (const part of derivation.parts) {
      parts.set(part.id, { part, runId, lineId });
      part.ports.forEach((port, index) => records.push({ owner: part.id, index, port, external: false }));
    }
  const externals = new Map(externalPorts(doc).map((port) => [port.id, port]));
  for (const port of externals.values()) records.push({ owner: port.id, index: 0, port: specToPort(port.spec), external: true });

  const grid = new Map<string, PortRecord[]>();
  for (const record of records) {
    const key = keyOf(record.port.position);
    grid.set(key, [...(grid.get(key) ?? []), record]);
  }
  const near = (record: PortRecord): PortRecord[] => {
    const [x, y, z] = record.port.position.map(cellOf) as [number, number, number];
    const found: PortRecord[] = [];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) found.push(...(grid.get(`${x + dx}|${y + dy}|${z + dz}`) ?? []));
    return found.filter(
      (other) =>
        other !== record &&
        other.owner !== record.owner &&
        len3(sub3(other.port.position, record.port.position)) <= TOLERANCE &&
        dot3(other.port.direction, record.port.direction) <= -OPPOSITE,
    );
  };

  const connected = new Set<string>();
  const edges: GraphEdge[] = [];
  const mismatches: Mismatch[] = [];
  const edgeKeys = new Set<string>();
  const attached = new Set<string>();
  const portKey = (record: PortRecord): string => `${record.owner}#${record.index}`;
  const link = (a: string, b: string, kind: GraphEdge['kind'], position: Vec3, jointKind?: Joint['kind']): void => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from: a, to: b, kind, position, ...(jointKind === undefined ? {} : { jointKind }) });
  };

  // Joints bridge a weld gap (and the engagement of a socket / threaded joint): a port within that reach of the joint position is connected through it.
  const byOwner = new Map<string, PortRecord[]>();
  for (const record of records) if (!record.external) byOwner.set(record.owner, [...(byOwner.get(record.owner) ?? []), record]);
  for (const { derivation } of runs)
    for (const joint of derivation.joints) {
      const [a, b] = joint.parts;
      for (const owner of [a, b])
        for (const record of byOwner.get(owner) ?? [])
          if (len3(sub3(record.port.position, joint.position)) <= joint.gapMm + (joint.engagementMm ?? 0) + TOLERANCE)
            connected.add(portKey(record));
      if (parts.has(a) && parts.has(b)) link(a, b, 'joint', joint.position, joint.kind);
      else for (const external of [a, b].filter((id) => externals.has(id))) attached.add(external);
      for (const accessory of joint.accessories ?? []) link(accessory, a, 'joint', joint.position, joint.kind);
    }
  for (const record of records) {
    if (record.external) continue;
    for (const other of near(record)) {
      connected.add(portKey(record));
      link(record.owner, other.owner, other.external ? 'attachment' : 'joint', record.port.position);
      if (other.external) attached.add(other.owner);
      if (record.owner < other.owner || other.external) mismatches.push(...mismatchesOf(record, other));
    }
  }
  const openEnds: OpenEnd[] = [];
  for (const { part, runId, lineId } of parts.values())
    part.ports.forEach((port, index) => {
      if (!connected.has(`${part.id}#${index}`))
        openEnds.push({
          partId: part.id,
          portIndex: index,
          runId,
          lineId,
          position: port.position,
          direction: port.direction,
          dn: port.dn,
          endType: port.endType,
        });
    });
  return { parts, externals, edges, openEnds, mismatches, attached, components: components(parts, externals, edges, attached) };
}

/** Union-find over parts and the attached external ports. */
function components(
  parts: RunGraph['parts'],
  externals: RunGraph['externals'],
  edges: readonly GraphEdge[],
  attached: ReadonlySet<string>,
): string[][] {
  const root = new Map<string, string>();
  const find = (id: string): string => {
    let at = id;
    while ((root.get(at) ?? at) !== at) at = root.get(at) as string;
    root.set(id, at);
    return at;
  };
  const ids = [...parts.keys(), ...[...externals.keys()].filter((id) => attached.has(id))];
  for (const id of ids) root.set(id, id);
  for (const edge of edges) if (root.has(edge.from) && root.has(edge.to)) root.set(find(edge.from), find(edge.to));
  const groups = new Map<string, string[]>();
  for (const id of ids) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  return [...groups.values()];
}

/** Shortest chain of node ids from `from` to `to` over the edges (breadth first), or null when they are not connected. */
export function pathBetween(graph: RunGraph, from: string, to: string): string[] | null {
  const known = (id: string): boolean => graph.parts.has(id) || graph.externals.has(id);
  if (!known(from) || !known(to)) return null;
  const next = new Map<string, string[]>();
  for (const edge of graph.edges) {
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
    next.set(edge.to, [...(next.get(edge.to) ?? []), edge.from]);
  }
  const back = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const at = queue.shift() as string;
    if (at === to) break;
    for (const step of next.get(at) ?? []) {
      if (back.has(step)) continue;
      back.set(step, at);
      queue.push(step);
    }
  }
  if (!back.has(to)) return null;
  const path: string[] = [];
  for (let at: string | null | undefined = to; at !== null && at !== undefined; at = back.get(at)) path.unshift(at);
  return path;
}

export interface RunSelection {
  /** The selected runs: those of the lines (all runs without `lineIds`) and every run attached to them. */
  readonly runIds: readonly string[];
  readonly graphRuns: readonly GraphRun[];
  /** Runs that do not derive, with the failure. */
  readonly broken: ReadonlyArray<{ readonly runId: string; readonly failure: DerivationFailure }>;
}

/** Derives the runs of `lineIds` (and the runs attached to them) for the graph and the checks. */
export function selectRuns(doc: CadDocument, lineIds?: readonly string[]): RunSelection {
  const piping = getPiping(doc);
  const wanted = piping.runOrder.filter((id) => lineIds === undefined || lineIds.includes(piping.runs[id]?.lineId ?? ''));
  const runIds = lineIds === undefined ? wanted : connectedRuns(piping, wanted);
  const graphRuns: GraphRun[] = [];
  const broken: Array<{ runId: string; failure: DerivationFailure }> = [];
  for (const runId of runIds) {
    const run = piping.runs[runId] as PipeRun;
    const derivation = deriveRun(doc, run);
    if (isFailure(derivation)) broken.push({ runId, failure: derivation });
    else graphRuns.push({ runId, lineId: run.lineId, derivation });
  }
  return { runIds, graphRuns, broken };
}
