/**
 * Pockets (07 FTR §5.6 step 3): a planar floor bounded by walls perpendicular to it (planes, or cylinders parallel to its normal) across
 * concave edges, plus an optional floor fillet (cylinders / tori tangent to the floor).
 * @invariant corner radius = the smallest vertical cylindrical wall radius; depth = the highest wall edge above the floor; `open` = a floor edge
 *   that does not meet a wall (the pocket runs off the part)
 * @failure fewer than 3 walls (closed) / 2 walls (open) -> not a pocket
 */

import type { Vec3 } from '../../model/types';
import { roundTo } from '../../lib/compactNumber';
import { dot3, sub3 } from '../../lib/vec3';
import { type Group, type Model, edgesOf, outwardNormal } from './model';
import type { RecognizedPocket } from './types';

const MIN_CLOSED_WALLS = 3;
const MIN_OPEN_WALLS = 2;

type Role = 'wall' | 'corner' | 'blend' | 'rim' | 'other';

/** `joint`: the convexity a wall meets its neighbour with — 'concave' at the floor, 'smooth' behind a floor fillet. */
function roleOf(model: Model, other: Group, convexity: string, normal: Vec3, joint: 'concave' | 'smooth'): Role {
  const { angle } = model.tolerance;
  const across = (axis: Vec3): number => Math.abs(dot3(axis, normal));
  const surface = other.surface;
  if (surface.type === 'plane') {
    if (convexity === joint && across(surface.normal) < angle) return 'wall';
    return convexity === 'convex' && joint === 'concave' ? 'rim' : 'other';
  }
  if (surface.type === 'cylinder' && other.reversed) {
    if (convexity === joint && 1 - across(surface.axis) < angle * angle) return 'corner';
    if (convexity === 'smooth' && joint === 'concave' && across(surface.axis) < angle) return 'blend';
  }
  if (surface.type === 'torus' && other.reversed && convexity === 'smooth' && joint === 'concave') return 'blend';
  return 'other';
}

interface Role2 {
  readonly other: Group;
  readonly role: Role;
}

function pocketAt(model: Model, floor: Group, taken: ReadonlySet<Group>): { pocket: RecognizedPocket; members: Group[] } | null {
  const normal = outwardNormal(floor);
  if (normal === null) return null;
  const near: Role2[] = model
    .boundary(floor)
    .filter((entry) => !taken.has(entry.other))
    .map((entry) => ({ other: entry.other, role: roleOf(model, entry.other, entry.convexity, normal, 'concave') }));
  const blends = [...new Set(near.filter((entry) => entry.role === 'blend').map((entry) => entry.other))];
  const behind: Role2[] = blends.flatMap((blend) =>
    model
      .boundary(blend)
      .filter((entry) => entry.other !== floor && !blends.includes(entry.other))
      .map((entry) => ({ other: entry.other, role: roleOf(model, entry.other, entry.convexity, normal, 'smooth') })),
  );
  const roles = [...near, ...behind];
  const walls = [...new Set(roles.filter((entry) => entry.role === 'wall' || entry.role === 'corner').map((entry) => entry.other))];
  const open = roles.some((entry) => entry.role === 'rim');
  const stray = roles.some((entry) => entry.role === 'other');
  if (stray || walls.length < (open ? MIN_OPEN_WALLS : MIN_CLOSED_WALLS)) return null;
  const floorPoint = model.edgePoints(model.boundary(floor)[0]?.edge ?? -1)[0];
  if (floorPoint === undefined) return null;
  const members = [...new Set([...walls, ...blends])];
  const above = members
    .flatMap((group) => edgesOf(model, group))
    .flatMap((edge) => model.edgePoints(edge))
    .map((point) => dot3(sub3(point, floorPoint), normal));
  const depth = Math.max(0, ...above);
  if (!(depth > model.tolerance.length)) return null;
  const radius = (group: Group): number =>
    group.surface.type === 'cylinder' ? group.surface.radius : group.surface.type === 'torus' ? group.surface.minor : 0;
  const radii = (kind: 'corner' | 'blend'): number[] => {
    const wanted = new Set(roles.filter((entry) => entry.role === kind).map((entry) => entry.other));
    return [...wanted].map(radius).filter((value) => value > 0);
  };
  const fillets = radii('blend');
  const corners = radii('corner');
  const r = (value: number): number => roundTo(value, 9) + 0;
  return {
    members: [floor, ...members],
    pocket: {
      floorZ: r(dot3(floorPoint, normal)),
      normal: [r(normal[0]), r(normal[1]), r(normal[2])],
      depth: r(depth),
      cornerRadius: corners.length === 0 ? 0 : r(Math.min(...corners)),
      floorFillet: fillets.length === 0 ? 0 : r(Math.min(...fillets)),
      open,
      faceIndices: [...new Set([floor, ...members].flatMap((group) => group.faces))].sort((a, b) => a - b),
    },
  };
}

/** Pockets of the model, deepest-floor-first stable order (normal, floor height, first face); `taken` receives the groups they explain. */
export function recognizePockets(model: Model, taken: Set<Group>): RecognizedPocket[] {
  const pockets: RecognizedPocket[] = [];
  for (const floor of model.groups) {
    if (taken.has(floor) || floor.surface.type !== 'plane') continue;
    const found = pocketAt(model, floor, taken);
    if (found === null) continue;
    pockets.push(found.pocket);
    found.members.forEach((group) => taken.add(group));
  }
  return pockets.sort(
    (a, b) =>
      a.normal[2] - b.normal[2] ||
      a.normal[1] - b.normal[1] ||
      a.normal[0] - b.normal[0] ||
      a.floorZ - b.floorZ ||
      (a.faceIndices[0] ?? 0) - (b.faceIndices[0] ?? 0),
  );
}
