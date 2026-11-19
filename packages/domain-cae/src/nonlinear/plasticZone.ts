/** Plastic zone of solved nonlinear_static results on a tet mesh: nodal PEEQ, plastic volume and elements across the zone, per part (PHY-05 §5.5, §7.1). */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { Vec3 } from '@core/model/vectors';
import { cross3, len3, sub3 } from '@lib/vec3';
import { memoByObject } from '@lib/memoByObject';
import { elementVolume, indexMesh, type MeshElement, type MeshIndex } from '../thermal/meshGeometry';

/** An element is plastic when the equivalent plastic strain of EVERY corner node is above this value (strictly): its smallest corner PEEQ. */
export const PLASTIC_PEEQ = 0;
/** NLS_MESH_PLASTIC_ADEQUACY: fewest elements across the plastic zone of a part (TR §7.1: "< 2 elements through a thickness with PEEQ > 0"). */
export const PLASTIC_ZONE_ELEMENTS = 2;

/** Largest equivalent plastic strain (PE component 0) of each node over every stored increment, built once per results artifact. */
const nodalPeeq: (results: FeResultsArtifact) => ReadonlyMap<number, number> = memoByObject(
  (results: FeResultsArtifact): ReadonlyMap<number, number> => {
    const peeq = new Map<number, number>();
    for (const step of results.steps) {
      const values = step.fields['PE']?.values;
      if (values === undefined) continue;
      for (const id in values) {
        const value = values[id]?.[0];
        if (value === undefined || !Number.isFinite(value)) continue;
        const node = Number(id);
        if (value > (peeq.get(node) ?? Number.NEGATIVE_INFINITY)) peeq.set(node, value);
      }
    }
    return peeq;
  },
);

const corners = (element: MeshElement): readonly number[] => element.nodes.slice(0, 4);

/**
 * Smallest PEEQ of the corner nodes of `element` (a node without a value counts 0). Nodal PEEQ is >= 0, so a mean or largest corner value would count
 * every element touching a plastic node and add a ring of elastic elements around the zone; the smallest keeps only elements plastic at all corners.
 */
const elementPeeq = (element: MeshElement, peeq: ReadonlyMap<number, number>): number => {
  const at = corners(element);
  return at.length < 4 ? 0 : at.reduce((least, node) => Math.min(least, peeq.get(node) ?? 0), Number.POSITIVE_INFINITY);
};

export interface PartPlasticZone {
  readonly entityId: string;
  /** Volume of the part's tetrahedra (analysis length unit cubed). */
  readonly volume: number;
  readonly plasticVolume: number;
  readonly elements: number;
  readonly plasticElements: number;
  /** Slab-equivalent thickness of the zone (2 V / S) over the element size h = (6 V / n)^(1/3); null without a plastic element. */
  readonly elementsAcross: number | null;
  /** Largest nodal PEEQ over the nodes of the part, with its node; null when the results hold no PE value on the part. */
  readonly maxPeeq: { readonly value: number; readonly node: number } | null;
}

const faceKey = (nodes: readonly number[]): string => [...nodes].sort((left, right) => left - right).join(',');

const FACES = [
  [0, 1, 2],
  [0, 3, 1],
  [1, 3, 2],
  [2, 3, 0],
] as const;

const position = (index: MeshIndex, node: number): Vec3 => index.coordinates.get(node) ?? [0, 0, 0];

/** Area of the zone boundary: the faces of plastic elements not shared with another plastic element of the zone. */
function boundaryArea(index: MeshIndex, plastic: readonly MeshElement[]): number {
  const faces = new Map<string, { count: number; area: number }>();
  for (const element of plastic) {
    const at = corners(element);
    for (const face of FACES) {
      const nodes = face.map((corner) => at[corner]).filter((node): node is number => node !== undefined);
      if (nodes.length < 3) continue;
      const key = faceKey(nodes);
      const known = faces.get(key);
      if (known !== undefined) known.count += 1;
      else {
        const [a, b, c] = nodes.map((node) => position(index, node)) as [Vec3, Vec3, Vec3];
        faces.set(key, { count: 1, area: len3(cross3(sub3(b, a), sub3(c, a))) / 2 });
      }
    }
  }
  let area = 0;
  for (const face of faces.values()) if (face.count === 1) area += face.area;
  return area;
}

function zoneOf(index: MeshIndex, entityId: string, members: readonly MeshElement[], peeq: ReadonlyMap<number, number>): PartPlasticZone {
  let volume = 0;
  let plasticVolume = 0;
  const plastic: MeshElement[] = [];
  let maxPeeq: PartPlasticZone['maxPeeq'] = null;
  for (const element of members) {
    const size = elementVolume(index, element);
    volume += size;
    if (elementPeeq(element, peeq) > PLASTIC_PEEQ) {
      plastic.push(element);
      plasticVolume += size;
    }
    for (const node of element.nodes) {
      const value = peeq.get(node);
      if (value !== undefined && (maxPeeq === null || value > maxPeeq.value || (value === maxPeeq.value && node < maxPeeq.node)))
        maxPeeq = { value, node };
    }
  }
  const surface = plastic.length === 0 ? 0 : boundaryArea(index, plastic);
  const size = plastic.length === 0 ? 0 : Math.cbrt((6 * plasticVolume) / plastic.length);
  return {
    entityId,
    volume,
    plasticVolume,
    elements: members.length,
    plasticElements: plastic.length,
    elementsAcross: plastic.length === 0 || surface <= 0 || size <= 0 ? null : (2 * plasticVolume) / surface / size,
    maxPeeq,
  };
}

/**
 * The plastic zone of every part with tetrahedra (other element types are not counted), sorted by entity id.
 * @invariant pure; the zone is the envelope over every stored increment: nodal PEEQ = its largest value over them, and an element is plastic when
 *   the smallest of its corner-node PEEQ is > PLASTIC_PEEQ; the zone boundary S is every face of a plastic element not shared with another plastic
 *   element (faces on the part surface and faces against elastic elements alike); elementsAcross is the
 *   slab-equivalent zone thickness 2 V / S (exact for a layer, an under-estimate for a compact zone: conservative) over h = (6 V / n)^(1/3) (a Kuhn cell of side s reads s)
 */
export function plasticZones(mesh: FeMeshArtifact, results: FeResultsArtifact): PartPlasticZone[] {
  const index = indexMesh(mesh);
  const peeq = nodalPeeq(results);
  const byPart = new Map<string, MeshElement[]>();
  for (const element of index.elements.values()) {
    const members = byPart.get(element.entityId);
    if (members === undefined) byPart.set(element.entityId, [element]);
    else members.push(element);
  }
  return [...byPart.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([entityId, members]) => zoneOf(index, entityId, members, peeq));
}

/** Ids of the tet elements of `entityId` with a node whose PEEQ is above `limit`, ascending. */
export function elementsAbove(mesh: FeMeshArtifact, results: FeResultsArtifact, entityId: string, limit: number): number[] {
  const peeq = nodalPeeq(results);
  const ids: number[] = [];
  for (const element of indexMesh(mesh).elements.values())
    if (element.entityId === entityId && element.nodes.some((node) => (peeq.get(node) ?? 0) > limit)) ids.push(element.id);
  return ids.sort((left, right) => left - right);
}
