// Parsers of the geometry parts of an `analyze_pipe_stress` answer called with `include: ['stresses', 'geometry', 'reactions', 'displacements']`:
// node positions and element / pipe centrelines (absolute document mm), support reactions and node displacements per case. Pure.

import type { Vec3 } from '@core/model/types';
import { isRecord } from '@lib/isRecord';

interface GeometryElement {
  readonly id: string;
  readonly pipeId: string;
  readonly kind: 'straight' | 'bend';
  readonly nodeIds: readonly [string, string];
  /** Outside diameter, mm. */
  readonly odMm: number;
}

interface GeometryPipe {
  readonly id: string;
  /** A building pipe or an 02 RTE run. */
  readonly kind: 'pipe' | 'run';
}

export interface StressGeometry {
  /** Node id (`N3`) to absolute position, mm. */
  readonly nodes: ReadonlyMap<string, Vec3>;
  /** Straight pieces between nodes (a bend is the chord of its arc). */
  readonly elements: readonly GeometryElement[];
  readonly pipes: readonly GeometryPipe[];
}

export interface SupportReaction {
  readonly nodeId: string;
  readonly case: string;
  /** Force the support applies to the pipe, N. */
  readonly forceN: Vec3;
}

export interface NodeDisplacement {
  readonly case: string;
  readonly node: string;
  readonly uMm: Vec3;
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function vec3(value: unknown): Vec3 | null {
  if (!Array.isArray(value) || value.length < 3) return null;
  const [x, y, z] = value as unknown[];
  return typeof x === 'number' && typeof y === 'number' && typeof z === 'number' ? [x, y, z] : null;
}

function parseElement(value: unknown): GeometryElement | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  const pipeId = str(value['pipeId']);
  const nodeIds = list(value['nodeIds']);
  const [na, nb] = [str(nodeIds[0]), str(nodeIds[1])];
  const od = value['odMm'];
  if (id === null || pipeId === null || na === null || nb === null || typeof od !== 'number') return null;
  return { id, pipeId, kind: value['kind'] === 'bend' ? 'bend' : 'straight', nodeIds: [na, nb], odMm: od };
}

function parsePipe(value: unknown): GeometryPipe | null {
  if (!isRecord(value)) return null;
  const id = str(value['id']);
  return id === null ? null : { id, kind: value['kind'] === 'run' ? 'run' : 'pipe' };
}

/** The geometry of `data.geometry`; null when it is absent (the answer was not asked for it). */
export function parseGeometry(value: unknown): StressGeometry | null {
  if (!isRecord(value)) return null;
  const nodes = new Map<string, Vec3>();
  for (const node of list(value['nodes'])) {
    const id = isRecord(node) ? str(node['id']) : null;
    const position = isRecord(node) ? vec3(node['positionMm']) : null;
    if (id !== null && position !== null) nodes.set(id, position);
  }
  return {
    nodes,
    elements: list(value['elements']).flatMap((element) => parseElement(element) ?? []),
    pipes: list(value['pipes']).flatMap((pipe) => parsePipe(pipe) ?? []),
  };
}

export function parseReactions(value: unknown): SupportReaction[] {
  return list(value).flatMap((entry): SupportReaction[] => {
    if (!isRecord(entry)) return [];
    const nodeId = str(entry['nodeId']);
    const caseName = str(entry['case']);
    const forceN = vec3(entry['forceN']);
    return nodeId === null || caseName === null || forceN === null ? [] : [{ nodeId, case: caseName, forceN }];
  });
}

export function parseDisplacements(value: unknown): NodeDisplacement[] {
  return list(value).flatMap((entry): NodeDisplacement[] => {
    if (!isRecord(entry)) return [];
    const node = str(entry['node']);
    const caseName = str(entry['case']);
    const uMm = vec3(entry['uMm']);
    return node === null || caseName === null || uMm === null ? [] : [{ case: caseName, node, uMm }];
  });
}
