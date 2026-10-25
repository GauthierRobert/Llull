/**
 * Beam graph of a graph lattice (05 IMP FR-IMP-18): the nodes and beams of sketched curves, merged within a tolerance, with radii that vary linearly along
 * each source curve from `radiusStart` to `radiusEnd`.
 * @invariant straight pieces are single beams; curved pieces are sampled to chords of at most `chord`; zero-length beams (after merging) are dropped and counted
 */

import { entityWorldPolyline } from '@core/geometry/entityPolyline';
import type { StrutBeam, StrutSet } from '@core/geometry/field/program';
import type { CadDocument, Vec3 } from '@core/model/types';
import type { GraphNode } from './model';

/** Hard cap of beams (explicit sets test every beam at every sample). */
export const MAX_GRAPH_BEAMS = 5000;

interface GraphGeometry {
  readonly set: StrutSet;
  readonly dropped: number;
  readonly totalLength: number;
  readonly radiusMax: number;
}

export type GraphResult =
  | { readonly ok: true; readonly graph: GraphGeometry }
  | {
      readonly ok: false;
      readonly code: 'IMP_ENTITY_NOT_FOUND' | 'IMP_GRAPH_EMPTY' | 'IMP_GRAPH_TOO_LARGE';
      readonly message: string;
      readonly ids: readonly string[];
    };

const key = (p: Vec3, tolerance: number): string => p.map((c) => Math.round(c / tolerance)).join(',');

/** Nodes and beams of `node.sourceIds` in `doc`. */
export function graphGeometry(
  doc: CadDocument,
  node: Pick<GraphNode, 'sourceIds' | 'chord' | 'mergeTolerance' | 'radiusStart' | 'radiusEnd' | 'cap'>,
): GraphResult {
  const nodes: Vec3[] = [];
  const byCell = new Map<string, number[]>();
  const beams: StrutBeam[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  let totalLength = 0;
  const tolerance = Math.max(node.mergeTolerance, 1e-9);
  const nodeAt = (p: Vec3): number => {
    const [cx, cy, cz] = p.map((c) => Math.round(c / tolerance)) as [number, number, number];
    for (let i = -1; i <= 1; i += 1)
      for (let j = -1; j <= 1; j += 1)
        for (let k = -1; k <= 1; k += 1)
          for (const index of byCell.get(`${cx + i},${cy + j},${cz + k}`) ?? []) {
            const q = nodes[index] as Vec3;
            if (Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) <= node.mergeTolerance) return index;
          }
    nodes.push(p);
    const cell = key(p, tolerance);
    byCell.set(cell, [...(byCell.get(cell) ?? []), nodes.length - 1]);
    return nodes.length - 1;
  };
  for (const id of node.sourceIds) {
    const entity = Object.hasOwn(doc.entities, id) ? doc.entities[id] : undefined;
    if (entity === undefined) return { ok: false, code: 'IMP_ENTITY_NOT_FOUND', message: `no entity '${id}'`, ids: [id] };
    const chain = entityWorldPolyline(entity, node.chord);
    if (typeof chain === 'string') return { ok: false, code: 'IMP_GRAPH_EMPTY', message: chain, ids: [id] };
    const lengths = chain
      .slice(1)
      .map((p, i) => Math.hypot(p[0] - (chain[i] as Vec3)[0], p[1] - (chain[i] as Vec3)[1], p[2] - (chain[i] as Vec3)[2]));
    const whole = lengths.reduce((a, b) => a + b, 0);
    let along = 0;
    chain.slice(1).forEach((p, i) => {
      const [s0, s1] = [whole === 0 ? 0 : along / whole, whole === 0 ? 0 : (along + (lengths[i] as number)) / whole];
      along += lengths[i] as number;
      const [a, b] = [nodeAt(chain[i] as Vec3), nodeAt(p)];
      const pair = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (a === b || seen.has(pair)) {
        dropped += 1;
        return;
      }
      seen.add(pair);
      const radius = (s: number): number => node.radiusStart + (node.radiusEnd - node.radiusStart) * s;
      beams.push({ a, b, ra: radius(s0), rb: radius(s1), cap: node.cap });
      totalLength += lengths[i] as number;
    });
  }
  if (beams.length === 0)
    return {
      ok: false,
      code: 'IMP_GRAPH_EMPTY',
      message: 'the sources hold no beam longer than the merge tolerance',
      ids: [...node.sourceIds],
    };
  if (beams.length > MAX_GRAPH_BEAMS)
    return {
      ok: false,
      code: 'IMP_GRAPH_TOO_LARGE',
      message: `${beams.length} beams exceed the limit of ${MAX_GRAPH_BEAMS}: raise chord`,
      ids: [...node.sourceIds],
    };
  const radiusMax = beams.reduce((largest, beam) => Math.max(largest, beam.ra, beam.rb), -Infinity);
  return { ok: true, graph: { set: { periodic: null, nodes, beams }, dropped, totalLength, radiusMax } };
}
