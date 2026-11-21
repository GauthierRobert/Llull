/**
 * Connection groups at check time (FR-ASC-10 / 11, TECHNICAL_SPEC 4.3): the strong links they add to the connectivity graph, and the stale items.
 * Without `detect` every member pair is connected. With `detect` only member pairs whose meshes lie within `toleranceMm`, whose nearest facets
 * face each other (normals within `faceAngleDeg` of opposition) and whose contact passes the `cylindrical` rule are connected; the contact is
 * curved when facets around the witness point (radius max(tolerance, 2 x the nearest facet's longest edge)) differ in normal by 1 to 45 degrees (a larger step is a sharp edge, not curvature).
 * @invariant touching faces alone never connect (D2): a part pair is linked only through a group, a joint, a body, an intent or an overlap
 * @invariant deterministic: groups in id order, members in document order, pairs i < j
 */

import type { CadDocument, MeshData, Vec3 } from '../../model/types';
import type { CheckItem } from '../../model/checkResult';
import type { ConnectionDetect } from '../../model/prototype';
import type { AssemblyPart } from './partTypes';
import { makeItem } from './partValidity';
import { resolveMembers } from './connectionMembers';
import { broadPhasePairs } from './broadPhase';
import { closestPointOnTriangle } from '../triangleQueries';
import type { GeometryQueryEngine } from '../geometryQueries';
import type { SpatialIndexPort } from '../spatialIndex';
import { appendAll } from '../../lib/appendAll';
import { cross3, dot3, len3, sub3 } from '../../lib/vec3';

interface ConnectionSummary {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  /** Live member parts. */
  readonly members: number;
  /** Strong links it contributes. */
  readonly links: number;
  readonly stale: readonly string[];
}

export interface ConnectionOutcome {
  readonly links: Array<readonly [string, string]>;
  readonly items: CheckItem[];
  readonly summaries: ConnectionSummary[];
}

interface Facet {
  readonly normal: Vec3;
  readonly distance: number;
  readonly longestEdge: number;
}

const CONTACT_EPS = 1e-9;
const CURVED_NORMAL_COS = Math.cos((1 * Math.PI) / 180);
const CREASE_NORMAL_COS = Math.cos((45 * Math.PI) / 180);

function facetsNear(mesh: MeshData, point: Vec3, toleranceUnits: number): { contact: Facet[]; curved: boolean } {
  const facets: Facet[] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const corner = (k: number): Vec3 => {
      const v = (mesh.indices[t + k] ?? 0) * 3;
      return [mesh.positions[v] ?? 0, mesh.positions[v + 1] ?? 0, mesh.positions[v + 2] ?? 0];
    };
    const [a, b, c] = [corner(0), corner(1), corner(2)];
    const normal = cross3(sub3(b, a), sub3(c, a));
    const length = len3(normal);
    if (length === 0) continue;
    const closest = closestPointOnTriangle(point, [a, b, c]);
    facets.push({
      normal: [normal[0] / length, normal[1] / length, normal[2] / length],
      distance: len3(sub3(closest, point)),
      longestEdge: Math.max(len3(sub3(b, a)), len3(sub3(c, b)), len3(sub3(a, c))),
    });
  }
  const contact = facets.filter((facet) => facet.distance <= toleranceUnits + CONTACT_EPS);
  const [reference] = [...contact].sort((p, q) => p.distance - q.distance);
  if (reference === undefined) return { contact, curved: false };
  const radius = Math.max(toleranceUnits, 2 * reference.longestEdge);
  const curved = facets.some((facet) => {
    const cosine = dot3(facet.normal, reference.normal);
    return facet.distance <= radius && cosine < CURVED_NORMAL_COS && cosine >= CREASE_NORMAL_COS;
  });
  return { contact, curved };
}

function contactAccepted(a: MeshData, b: MeshData, pointA: Vec3, pointB: Vec3, detect: ConnectionDetect, toleranceUnits: number): boolean {
  const [onA, onB] = [facetsNear(a, pointA, toleranceUnits), facetsNear(b, pointB, toleranceUnits)];
  const limit = (detect.faceAngleDeg * Math.PI) / 180 + 1e-9;
  const facing = onA.contact.some((fa) =>
    onB.contact.some((fb) => Math.acos(Math.max(-1, Math.min(1, -dot3(fa.normal, fb.normal)))) <= limit),
  );
  if (!facing) return false;
  const curved = onA.curved || onB.curved;
  return detect.cylindrical === 'include' || (detect.cylindrical === 'only') === curved;
}

function detectedLinks(
  members: readonly AssemblyPart[],
  detect: ConnectionDetect,
  mmPerUnit: number,
  engine: GeometryQueryEngine,
  port: SpatialIndexPort | null | undefined,
): Array<readonly [string, string]> {
  const tolerance = detect.toleranceMm / mmPerUnit;
  const pairs = broadPhasePairs(members, tolerance, port);
  const usable = pairs.filter(([i, j]) => members[i]?.mesh != null && members[j]?.mesh != null);
  if (usable.length === 0) return [];
  const meshes = members.map((part) => part.mesh ?? { positions: [], indices: [] });
  const answers = engine.placedDistanceBatch(
    meshes,
    usable.map(([a, b]) => ({ a, b, placement: null, maxDistance: tolerance })),
  );
  const links: Array<readonly [string, string]> = [];
  usable.forEach(([i, j], k) => {
    const answer = answers[k];
    if (answer === null || answer === undefined) return;
    const [a, b] = [members[i] as AssemblyPart, members[j] as AssemblyPart];
    if (contactAccepted(a.mesh as MeshData, b.mesh as MeshData, answer.pointA, answer.pointB, detect, tolerance)) links.push([a.id, b.id]);
  });
  return links;
}

export function connectionLinks(
  doc: CadDocument,
  partsById: ReadonlyMap<string, AssemblyPart>,
  mmPerUnit: number,
  engine: GeometryQueryEngine,
  port?: SpatialIndexPort | null,
): ConnectionOutcome {
  const links: Array<readonly [string, string]> = [];
  const items: CheckItem[] = [];
  const summaries: ConnectionSummary[] = [];
  const groups = Object.values(doc.prototype?.connections ?? {}).sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  for (const group of groups) {
    const resolved = resolveMembers(doc, group.members);
    const members = resolved.ids.flatMap((id) => partsById.get(id) ?? []);
    const added: Array<readonly [string, string]> =
      group.detect === undefined
        ? members.slice(1).map((part) => [(members[0] as AssemblyPart).id, part.id] as const)
        : detectedLinks(members, group.detect, mmPerUnit, engine, port);
    appendAll(links, added);
    summaries.push({
      id: group.id,
      name: group.name,
      kind: group.kind,
      members: members.length,
      links: added.length,
      stale: resolved.stale,
    });
    if (resolved.stale.length > 0)
      items.push(
        makeItem(
          'FPR_CONN_STALE',
          'warn',
          resolved.stale,
          `Connection ${group.id} refers to ids that no longer exist: delete_connection_group and declare it again.`,
          { note: `connection group '${group.name}' (${group.kind}): the stale members were ignored` },
        ),
      );
  }
  return { links, items, summaries };
}
