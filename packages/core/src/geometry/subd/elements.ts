/**
 * Persistent cage element ids and element references (04 DIR §3.2). Ids are minted by the step that creates the element (`v-<step>.<k>`,
 * `f-<step>.<k>`); an edge id is derived from its two vertex ids (`e:<idA>|<idB>`, sorted). References are ids or indices; commands record
 * the ids so a replay is independent of array order. Pure.
 */

import type { Vec3 } from '../../model/types';
import type { CageElementIds } from '../../model/subdivisionCage';
import { nextId } from '../../lib/id';
import { edgeKey } from './edgeKey';
import { type CageTopology, buildTopology } from './topology';

export type VertexRef = string | number;
export type FaceRef = string | number;
export type EdgeRef = string | readonly [number, number];

/** A reference that does not resolve; `code` is the stable DIR code. */
export interface RefProblem {
  readonly code: 'DIR_REF_LOST' | 'DIR_ELEMENT_KIND';
  readonly message: string;
  readonly path: string;
}

/** The parts of a subdivision entity references resolve against. */
export interface CageRefSource {
  readonly vertices: ReadonlyArray<Vec3>;
  readonly faces: ReadonlyArray<ReadonlyArray<number>>;
  readonly elementIds: CageElementIds;
}

export interface Resolved<T> {
  readonly items: T[];
  /** The references as ids (vertices, faces) or edge ids; what a FeatureStep records. */
  readonly ids: string[];
  /** Some reference was an index (so the recorded ids differ from the params). */
  readonly byIndex: boolean;
}

/** Key shared by every id minted in the current step: `cage-3.1` -> `3`, a process-counter id -> its time-counter part. */
function stepKeyOf(minted: string, prefix: string): string {
  const rest = minted.slice(prefix.length + 1);
  return rest.replace(/\.\d+$/, '');
}

/** Ids `<prefix>-<key>.<index>` for a freshly created cage. */
export function initialElementIds(vertexCount: number, faceCount: number): CageElementIds {
  const key = stepKeyOf(nextId('cage'), 'cage');
  const ids = (prefix: string, count: number): string[] => Array.from({ length: count }, (_, i) => `${prefix}-${key}.${i}`);
  return { vertices: ids('v', vertexCount), faces: ids('f', faceCount) };
}

/** A fresh id (`<prefix>-<step>.<n>`) not in `taken`; the id is added to `taken`. */
export function mintElementId(prefix: 'v' | 'f', taken: Set<string>): string {
  let id = nextId(prefix);
  while (taken.has(id)) id = nextId(prefix);
  taken.add(id);
  return id;
}

/** Derived id of the edge between two vertices. */
export function edgeIdOf(ids: CageElementIds, a: number, b: number): string {
  const [x, y] = [ids.vertices[a] as string, ids.vertices[b] as string];
  return x < y ? `e:${x}|${y}` : `e:${y}|${x}`;
}

const lost = (what: string, ref: unknown, path: string): RefProblem => ({
  code: 'DIR_REF_LOST',
  message: `${what} ${JSON.stringify(ref)} does not exist in the cage`,
  path,
});
const kind = (expected: string, ref: unknown, path: string): RefProblem => ({
  code: 'DIR_ELEMENT_KIND',
  message: `${JSON.stringify(ref)} is not a ${expected} reference`,
  path,
});

function resolveIndexed(
  refs: readonly (string | number)[],
  ids: ReadonlyArray<string>,
  what: 'vertex' | 'face',
  path: string,
): Resolved<number> | RefProblem {
  const lookup = new Map(ids.map((id, i) => [id, i]));
  const items: number[] = [];
  const out: string[] = [];
  let byIndex = false;
  for (const [k, ref] of refs.entries()) {
    const here = `${path}.${k}`;
    if (typeof ref === 'string') {
      if (ref.startsWith('e:') || ref.startsWith(what === 'vertex' ? 'f-' : 'v-')) return kind(what, ref, here);
      const found = lookup.get(ref);
      if (found === undefined) return lost(what, ref, here);
      items.push(found);
      out.push(ref);
    } else {
      if (!Number.isInteger(ref) || ref < 0 || ref >= ids.length) return lost(what, ref, here);
      byIndex = true;
      items.push(ref);
      out.push(ids[ref] as string);
    }
  }
  return { items, ids: out, byIndex };
}

/** Vertex indices of `refs` (ids or indices), or the first problem. */
export function resolveVertices(cage: CageRefSource, refs: readonly VertexRef[], path: string): Resolved<number> | RefProblem {
  return resolveIndexed(refs, cage.elementIds.vertices, 'vertex', path);
}

/** Face indices of `refs` (ids or indices), or the first problem. */
export function resolveFaces(cage: CageRefSource, refs: readonly FaceRef[], path: string): Resolved<number> | RefProblem {
  return resolveIndexed(refs, cage.elementIds.faces, 'face', path);
}

/** Edge references (`e:<idA>|<idB>` or `[a, b]` vertex indices) as topology edge indices; the edge must exist. */
export function resolveEdges(
  cage: CageRefSource,
  refs: readonly EdgeRef[],
  path: string,
  topology: CageTopology = buildTopology(cage.vertices.length, cage.faces),
): Resolved<number> | RefProblem {
  const lookup = new Map(cage.elementIds.vertices.map((id, i) => [id, i]));
  const items: number[] = [];
  const out: string[] = [];
  let byIndex = false;
  for (const [k, ref] of refs.entries()) {
    const here = `${path}.${k}`;
    let pair: readonly [number | undefined, number | undefined];
    if (typeof ref === 'string') {
      if (!ref.startsWith('e:')) return kind('edge', ref, here);
      const [x, y] = ref.slice(2).split('|');
      pair = [x === undefined ? undefined : lookup.get(x), y === undefined ? undefined : lookup.get(y)];
    } else {
      byIndex = true;
      pair = ref;
    }
    const [a, b] = pair;
    const edge = a === undefined || b === undefined ? undefined : topology.edgeIndex.get(edgeKey(a, b));
    if (a === undefined || b === undefined || edge === undefined) return lost('edge', ref, here);
    items.push(edge);
    out.push(edgeIdOf(cage.elementIds, a, b));
  }
  return { items, ids: out, byIndex };
}

export const isRefProblem = (value: unknown): value is RefProblem =>
  typeof value === 'object' && value !== null && 'code' in value && 'path' in value;
