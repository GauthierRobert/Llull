/**
 * Mesh-to-mesh temperature mapping (PHY-04 TR-TMC-23): for each node of a target mesh, find the source element that contains it (bounding-box
 * tree, deterministic: the lowest element index wins) and interpolate the source nodal values with the element shape functions (C3D4 linear,
 * C3D10 quadratic; mid-edge nodes are taken at the straight-edge positions, which is how the mesher writes them). A node outside every element
 * is projected on the nearest element (flagged and counted); the largest distance moved is reported.
 */

import type { FeMeshArtifact } from '@core/model/analysis';
import { barycentricAt, buildLocator, locateElement, type LocatorElement } from './elementLocator';

export interface MappingReport {
  /** Largest distance from a target node to the source element used (0 when all nodes are inside), in mesh length units. */
  readonly maxMappingDistance: number;
  /** Target nodes outside every source element (value taken at the nearest point of the nearest element). */
  readonly outside: number;
  /** Largest |mapped - source| at target nodes that coincide with a source node (the check of TR-TMC-23: must be < 1e-9). */
  readonly coincidentMaxError: number;
  readonly coincidentNodes: number;
}

export interface MappedField {
  readonly ok: true;
  readonly values: readonly number[];
  /** Source element used per target node (0-based index in block / element order) and the distance moved to it (0 inside). */
  readonly elements: readonly number[];
  readonly distances: readonly number[];
  readonly report: MappingReport;
}

export interface MappingRefusal {
  readonly ok: false;
  readonly message: string;
}

type Vec = readonly [number, number, number];

interface SourceElement extends LocatorElement {
  readonly nodes: readonly number[];
}

/** Shape functions of C3D4 (4 nodes) / C3D10 (10 nodes, CalculiX order) at barycentric coordinates. */
function shape(l: readonly [number, number, number, number], nodes: number): number[] {
  const [l1, l2, l3, l4] = l;
  if (nodes === 4) return [l1, l2, l3, l4];
  return [
    l1 * (2 * l1 - 1),
    l2 * (2 * l2 - 1),
    l3 * (2 * l3 - 1),
    l4 * (2 * l4 - 1),
    4 * l1 * l2,
    4 * l2 * l3,
    4 * l3 * l1,
    4 * l1 * l4,
    4 * l2 * l4,
    4 * l3 * l4,
  ];
}

function sourceElements(mesh: FeMeshArtifact): SourceElement[] | null {
  const coordinates = new Map(mesh.nodes.map(([id, x, y, z]) => [id, [x, y, z] as Vec]));
  const out: SourceElement[] = [];
  for (const block of mesh.blocks) {
    for (const element of block.elements) {
      const nodes = element.slice(1);
      if (nodes.length !== 4 && nodes.length !== 10) return null;
      const points = nodes.map((id) => coordinates.get(id));
      if (points.some((point) => point === undefined)) return null;
      const corners = points.slice(0, 4) as unknown as [Vec, Vec, Vec, Vec];
      const all = points as Vec[];
      out.push({
        nodes,
        corners,
        low: [0, 1, 2].map((axis) => Math.min(...all.map((p) => p[axis] ?? 0))) as unknown as Vec,
        high: [0, 1, 2].map((axis) => Math.max(...all.map((p) => p[axis] ?? 0))) as unknown as Vec,
      });
    }
  }
  return out;
}

/**
 * `sourceValues` (by source node id) interpolated at every node of `target`, aligned with `target.nodes`.
 * @invariant deterministic (lowest element index among containing elements); a target node at a source node reproduces its value
 * @failure a source element that is not C3D4 / C3D10, a missing node or no element -> refusal; a source value missing for a node -> refusal
 */
export function mapNodalField(
  source: FeMeshArtifact,
  sourceValues: ReadonlyMap<number, number>,
  target: FeMeshArtifact,
): MappedField | MappingRefusal {
  const elements = sourceElements(source);
  if (elements === null || elements.length === 0)
    return { ok: false, message: 'the source mesh has no C3D4 / C3D10 elements with all their nodes' };
  const locator = buildLocator(elements);
  const values: number[] = [];
  const used: number[] = [];
  const distances: number[] = [];
  for (const [, x, y, z] of target.nodes) {
    const hit = locateElement(locator, [x, y, z]);
    const element = hit === null ? undefined : elements[hit.element];
    if (hit === null || element === undefined) return { ok: false, message: 'no source element found for a target node' };
    const l = hit.barycentric ?? barycentricAt(locator.terms, hit.element, hit.point[0], hit.point[1], hit.point[2]);
    if (l === null) return { ok: false, message: `source element ${hit.element + 1} is degenerate` };
    const weights = shape(l, element.nodes.length);
    let value = 0;
    for (const [i, node] of element.nodes.entries()) {
      const nodal = sourceValues.get(node);
      if (nodal === undefined || !Number.isFinite(nodal)) return { ok: false, message: `the source has no finite value at node ${node}` };
      value += (weights[i] ?? 0) * nodal;
    }
    values.push(value);
    used.push(hit.element);
    distances.push(hit.distance);
  }
  return { ok: true, values, elements: used, distances, report: mappingReport(source, sourceValues, target, values, distances) };
}

/**
 * The TR-TMC-23 report of mapped `values` / `distances` (aligned with `target.nodes`): nodes moved by more than 1e-9 x the source size, the
 * largest such move, and the largest error at target nodes that coincide with a source node. Shared by the TS mapping and the native
 * mapped-field reader, so both report alike. Loops, not spreads: meshes of 200k nodes overflow `Math.min(...array)`.
 */
export function mappingReport(
  source: FeMeshArtifact,
  sourceValues: ReadonlyMap<number, number>,
  target: FeMeshArtifact,
  values: readonly number[],
  distances: readonly number[],
): MappingReport {
  const low = [Infinity, Infinity, Infinity];
  const high = [-Infinity, -Infinity, -Infinity];
  for (const node of source.nodes)
    for (let axis = 0; axis < 3; axis += 1) {
      const value = node[axis + 1] ?? 0;
      if (value < (low[axis] ?? 0)) low[axis] = value;
      if (value > (high[axis] ?? 0)) high[axis] = value;
    }
  const size = Math.hypot(...high.map((h, axis) => h - (low[axis] ?? 0)));
  const tolerance = 1e-9 * size;
  const exact = new Map<string, number>(source.nodes.map(([id, x, y, z]) => [`${x}|${y}|${z}`, id]));
  let maxDistance = 0;
  let outside = 0;
  let coincident = 0;
  let coincidentError = 0;
  for (const [index, [, x, y, z]] of target.nodes.entries()) {
    const distance = distances[index] ?? Number.NaN;
    if (distance > tolerance) {
      outside += 1;
      maxDistance = Math.max(maxDistance, distance);
    }
    const same = exact.get(`${x}|${y}|${z}`);
    if (same !== undefined) {
      coincident += 1;
      coincidentError = Math.max(coincidentError, Math.abs((values[index] ?? Number.NaN) - (sourceValues.get(same) ?? Number.NaN)));
    }
  }
  return { maxMappingDistance: maxDistance, outside, coincidentMaxError: coincidentError, coincidentNodes: coincident };
}
