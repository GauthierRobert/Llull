/**
 * @layer domain-aec
 */

import type { Vec2 } from '@core/model/types';
import type {
  BuildingModel,
  CurvedWallElement,
  OpeningElement,
  WallElement,
} from '@core/model/building';
import { projectOntoSegment, distance } from '@lib/polygon';
import { arcOffsetOf, curvedWallExtent, tangentWall } from './curvedWallGeometry';
import { elementsOf, orderedElements } from './model';

interface WallFrame {
  readonly length: number;
  readonly angle: number;
  readonly direction: Vec2;
  readonly normal: Vec2;
}

export function wallFrame(wall: Pick<WallElement, 'start' | 'end'>): WallFrame {
  const dx = wall.end[0] - wall.start[0];
  const dy = wall.end[1] - wall.start[1];
  const length = Math.hypot(dx, dy);
  const direction: Vec2 = length === 0 ? [1, 0] : [dx / length, dy / length];
  return {
    length,
    angle: Math.atan2(dy, dx),
    direction,
    normal: [-direction[1], direction[0]],
  };
}

export function pointAlong(
  wall: Pick<WallElement, 'start'>,
  frame: WallFrame,
  s: number,
  n = 0,
): Vec2 {
  return [
    wall.start[0] + frame.direction[0] * s + frame.normal[0] * n,
    wall.start[1] + frame.direction[1] * s + frame.normal[1] * n,
  ];
}

export function openingsOf(building: BuildingModel, wallId: string): OpeningElement[] {
  return orderedElements(building)
    .filter(
      (element): element is OpeningElement =>
        (element.category === 'door' || element.category === 'window') && element.hostId === wallId,
    )
    .sort((a, b) => a.offset - b.offset);
}

/**
 * Plan extension (+) or retraction (−) at one wall end so joints close cleanly (square-cut butt
 * joints). With φ the angle between the two walls' away-from-joint directions:
 * - L/X joint, earlier wall: its OUTER edge reaches the other wall's outer face —
 *   (t_other/2 + (t_self/2)·cos φ) / sin φ (signed cos: ≈ (t/2)·cot(φ/2) for obtuse joints);
 * - later wall at an L/X joint, or abutting wall at a T joint: retracts to the other wall's near
 *   face without leaving a gap — −(t_other/2 − (t_self/2)·|cos φ|) / sin φ.
 */
export function endAdjustment(
  building: BuildingModel,
  wall: WallElement,
  end: 'start' | 'end',
): number {
  const point = wall[end];
  const frame = wallFrame(wall);
  const away: Vec2 = end === 'start' ? frame.direction : [-frame.direction[0], -frame.direction[1]];
  const ownIndex = building.elementOrder.indexOf(wall.id);
  // Curved walls take part through their tangent at the arc point nearest this wall end.
  const curvedWalls = elementsOf(building, 'curvedWall').filter(
    (curved) => curved.levelId === wall.levelId,
  );
  const curvedIds = new Set(curvedWalls.map((curved) => curved.id));
  const tangents = curvedWalls.map((curved) => tangentWall(curved, arcOffsetOf(curved, point)));
  const straightWalls = elementsOf(building, 'wall').filter(
    (candidate) => candidate.levelId === wall.levelId,
  );
  for (const other of [...straightWalls, ...tangents]) {
    if (other.id === wall.id) continue;
    const otherFrame = wallFrame(other);
    const sine = Math.abs(away[0] * otherFrame.direction[1] - away[1] * otherFrame.direction[0]);
    if (sine < 0.05) continue;
    const tolerance = Math.max(Math.min(wall.thickness, other.thickness) * 0.05, 1e-9);
    const retraction =
      -(
        other.thickness / 2 -
        (wall.thickness / 2) *
          Math.abs(away[0] * otherFrame.direction[0] + away[1] * otherFrame.direction[1])
      ) / sine;
    const atOtherStart = distance(point, other.start) <= tolerance;
    if (atOtherStart || distance(point, other.end) <= tolerance) {
      // A curved wall keeps its square end: the straight wall always closes the corner.
      if (!curvedIds.has(other.id) && building.elementOrder.indexOf(other.id) < ownIndex)
        return retraction;
      const otherAway: Vec2 = atOtherStart
        ? otherFrame.direction
        : [-otherFrame.direction[0], -otherFrame.direction[1]];
      const cosine = away[0] * otherAway[0] + away[1] * otherAway[1];
      return (other.thickness / 2 + (wall.thickness / 2) * cosine) / sine;
    }
    const projection = projectOntoSegment(point, other.start, other.end);
    if (projection.distance <= tolerance && projection.t > 0 && projection.t < 1) return retraction;
  }
  return 0;
}

/** Along-wall interval [start, end] actually occupied by the wall body (joints applied). */
export interface WallExtent {
  readonly start: number;
  readonly end: number;
}

export function wallExtent(building: BuildingModel, wall: WallElement): WallExtent {
  const startAdjustment = endAdjustment(building, wall, 'start');
  return {
    start: startAdjustment === 0 ? 0 : -startAdjustment,
    end: wallFrame(wall).length + endAdjustment(building, wall, 'end'),
  };
}

/** Plan swing of a door in a straight wall: hinge point, open-leaf end and the arc's angles. */
export function doorSwing(
  wall: Pick<WallElement, 'start' | 'end' | 'thickness'>,
  door: OpeningElement,
): { hinge: Vec2; leafEnd: Vec2; startAngle: number; endAngle: number } {
  const frame = wallFrame(wall);
  const hingeOffset =
    door.swing === 'left' ? door.offset - door.width / 2 : door.offset + door.width / 2;
  const hinge = pointAlong(wall, frame, hingeOffset, wall.thickness / 2);
  const openAngle = frame.angle + Math.PI / 2;
  const [startAngle, endAngle] =
    door.swing === 'left' ? [frame.angle, openAngle] : [openAngle, frame.angle + Math.PI];
  const leafEnd: Vec2 = [
    hinge[0] + Math.cos(openAngle) * door.width,
    hinge[1] + Math.sin(openAngle) * door.width,
  ];
  return { hinge, leafEnd, startAngle, endAngle };
}

/** Built extent of a straight wall, or of a curved wall along its arc (joints applied). */
export function builtExtent(
  building: BuildingModel,
  wall: WallElement | CurvedWallElement,
): WallExtent {
  return wall.category === 'wall' ? wallExtent(building, wall) : curvedWallExtent(building, wall);
}

interface WallPiece {
  readonly s0: number;
  readonly s1: number;
  readonly z0: number;
  readonly z1: number;
}

/** Vertical rectangular pieces [s0,s1]×[z0,z1] (wall-local) left solid after cutting the openings. */
export function wallPieces<Wall extends { readonly height: number }>(
  wall: Wall,
  openings: ReadonlyArray<OpeningElement>,
  extent: WallExtent,
): WallPiece[] {
  const pieces: WallPiece[] = [];
  let cursor = extent.start;
  for (const opening of openings) {
    const left = Math.max(opening.offset - opening.width / 2, extent.start);
    const right = Math.min(opening.offset + opening.width / 2, extent.end);
    if (left > cursor) pieces.push({ s0: cursor, s1: left, z0: 0, z1: wall.height });
    if (opening.sillHeight > 0) pieces.push({ s0: left, s1: right, z0: 0, z1: opening.sillHeight });
    const head = opening.sillHeight + opening.height;
    if (head < wall.height) pieces.push({ s0: left, s1: right, z0: head, z1: wall.height });
    cursor = Math.max(cursor, right);
  }
  if (extent.end > cursor) pieces.push({ s0: cursor, s1: extent.end, z0: 0, z1: wall.height });
  return pieces.filter((piece) => piece.s1 - piece.s0 > 1e-9 && piece.z1 - piece.z0 > 1e-9);
}
