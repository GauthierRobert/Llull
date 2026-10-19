/**
 * Enumerates the actions applicable to a built design, with the params the UI sends: edges and faces come from the topology queries
 * (`inspect_topology`, `inspect_faces`) when the kernel has a B-rep; a mesh kernel has none, so each body gets one whole-body target
 * (`*`) for fillet / chamfer / shell and six bounding-box faces for holes. There is no draft and no vertex-taking command yet.
 */

import { execute } from '@core/commands/registry';
import { type CadDocument, is3D } from '@core/model/types';
import type { ActionSpec } from './runAction';

type Vec3 = readonly [number, number, number];

const MAX_BODIES = 6;
const MAX_TRANSFORMED = 8;
const MAX_EDGES_PER_BODY = 24;
const MAX_FACES_PER_BODY = 12;

interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

interface TopologyEdge {
  readonly index: number;
}

interface FaceInfo {
  readonly index: number;
  readonly surface: string;
  readonly point: Vec3;
}

const dataOf = (doc: CadDocument, command: string, params: Record<string, unknown>): Record<string, unknown> | null =>
  (execute(doc, command, params).data as Record<string, unknown> | undefined) ?? null;

const round = (value: number): number => Number(value.toPrecision(6));
const roundVec = (v: Vec3): Vec3 => [round(v[0]), round(v[1]), round(v[2])];

function boxOf(doc: CadDocument, id: string): Box | null {
  const data = dataOf(doc, 'measure_bounding_box', { entityId: id });
  const min = data?.['min'] as Vec3 | undefined;
  const max = data?.['max'] as Vec3 | undefined;
  return min !== undefined && max !== undefined && [...min, ...max].every(Number.isFinite) ? { min, max } : null;
}

const extents = (box: Box): Vec3 => [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];

/** Body-relative size of a blend / wall / hole: a fraction of the smallest non-degenerate extent. */
function bodyScale(box: Box): number {
  const sizes = extents(box).filter((s) => s > 1e-9);
  return sizes.length === 0 ? 1 : Math.min(...sizes);
}

const centre = (box: Box): Vec3 => [(box.min[0] + box.max[0]) / 2, (box.min[1] + box.max[1]) / 2, (box.min[2] + box.max[2]) / 2];

/** The six bounding-box face centres of a body (the pick points a mesh kernel can still resolve). */
function boxFaces(box: Box): FaceInfo[] {
  const c = centre(box);
  const faces: FaceInfo[] = [];
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [1, -1] as const) {
      const point = [...c] as [number, number, number];
      point[axis] = side === 1 ? (box.max[axis] ?? 0) : (box.min[axis] ?? 0);
      faces.push({ index: faces.length, surface: `bbox${side === 1 ? '+' : '-'}${'xyz'[axis]}`, point: roundVec(point) });
    }
  }
  return faces;
}

function exactEdges(doc: CadDocument, id: string): TopologyEdge[] | null {
  const edges = dataOf(doc, 'inspect_topology', { id })?.['edges'];
  return Array.isArray(edges) ? (edges as TopologyEdge[]) : null;
}

function exactFaces(doc: CadDocument, id: string): FaceInfo[] | null {
  const faces = dataOf(doc, 'inspect_faces', { entityId: id, samples: 1 })?.['faces'];
  if (!Array.isArray(faces)) return null;
  return (faces as { index: number; surface: string; centroid: Vec3; samples?: Vec3[] }[]).map((face) => ({
    index: face.index,
    surface: face.surface,
    point: roundVec(face.samples?.[0] ?? face.centroid),
  }));
}

function bodyActions(doc: CadDocument, id: string, box: Box): ActionSpec[] {
  const scale = bodyScale(box);
  const [size, thickness] = [round(scale * 0.1), round(scale * 0.1)];
  const specs: ActionSpec[] = [];
  const add = (command: string, params: Record<string, unknown>, target: string, relation: ActionSpec['relation']): void => {
    specs.push({ command, params, target, operands: [id], relation });
  };
  const edges = exactEdges(doc, id);
  if (edges === null) {
    add('fillet_edge', { id, radius: size }, `${id}#*`, 'reduces');
    add('chamfer_edge', { id, distance: size }, `${id}#*`, 'reduces');
    add('shell_solid', { id, thickness }, `${id}#*`, 'reduces');
  } else {
    for (const edge of edges.slice(0, MAX_EDGES_PER_BODY)) {
      add('fillet_edge', { id, edgeIndices: [edge.index], radius: size }, `${id}#e${edge.index}`, 'reduces');
      add('chamfer_edge', { id, edgeIndices: [edge.index], distance: size }, `${id}#e${edge.index}`, 'reduces');
    }
  }
  const faces = (exactFaces(doc, id) ?? boxFaces(box)).slice(0, MAX_FACES_PER_BODY);
  const diameter = round(scale * 0.25);
  for (const face of faces) {
    const label = `${id}#f${face.surface.startsWith('bbox') ? face.surface : face.index}`;
    if (edges !== null) add('shell_solid', { id, thickness, openFacesNear: [face.point] }, label, 'reduces');
    add(
      'add_hole',
      {
        target: id,
        face: { near: face.point },
        points: [face.point],
        pointsFrame: 'world',
        hole: { kind: 'simple', diameter },
        extent: { kind: 'through_all' },
      },
      label,
      'reduces',
    );
  }
  return specs;
}

function pairActions(ids: readonly string[]): ActionSpec[] {
  const specs: ActionSpec[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i] as string, ids[j] as string];
      for (const op of ['union', 'subtract', 'intersect'] as const) {
        specs.push({ command: 'boolean', params: { op, a, b }, target: `${a}+${b}/${op}`, operands: [a, b], relation: op });
      }
    }
  }
  return specs;
}

function transformActions(doc: CadDocument, id: string): ActionSpec[] {
  const box = boxOf(doc, id);
  const step = box === null ? 1 : round(Math.max(...extents(box), 1e-3) * 0.25);
  const unit = (command: string, params: Record<string, unknown>, target = id): ActionSpec => ({
    command,
    params,
    target,
    operands: [id],
    relation: 'none',
  });
  return [
    unit('move_entities', { ids: [id], delta: [step, 0, 0] }),
    unit('rotate_entity', { id, delta: [0, 0, 0.3] }),
    unit('mirror_entity', { id, axis: 'x' }),
    unit('array_linear', { id, count: 3, offset: [step * 2, 0, 0] }),
    unit('array_polar', { id, count: 4, center: [0, 0, 0] }),
  ];
}

/** Every action applicable to `doc`, in a stable order (bodies in document order). */
export function enumerateActions(doc: CadDocument): ActionSpec[] {
  const solids = doc.order.filter((id) => {
    const entity = doc.entities[id];
    return entity !== undefined && is3D(entity) && entity.kind !== 'instance';
  });
  const bodies = solids.slice(0, MAX_BODIES);
  const specs: ActionSpec[] = [];
  for (const id of bodies) {
    const box = boxOf(doc, id);
    if (box !== null) specs.push(...bodyActions(doc, id, box));
  }
  specs.push(...pairActions(bodies));
  for (const id of doc.order.slice(0, MAX_TRANSFORMED)) specs.push(...transformActions(doc, id));
  return specs;
}
