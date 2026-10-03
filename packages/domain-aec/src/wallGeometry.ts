/**
 * @layer domain-aec
 */

import type { CadDocument, Vec2 } from '@core/model/types';
import type { BuildingModel, OpeningElement, WallElement } from '@core/model/building';
import { projectOntoSegment, distance } from '@lib/polygon';
import { arcOffsetOf, tangentWall } from './curvedWallGeometry';

export interface EvaluationContext {
  readonly doc: CadDocument;
  readonly building: BuildingModel;
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

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
  return building.elementOrder
    .map((id) => building.elements[id])
    .filter(
      (element): element is OpeningElement =>
        element !== undefined &&
        (element.category === 'door' || element.category === 'window') &&
        element.hostId === wallId,
    )
    .sort((a, b) => a.offset - b.offset);
}

function wallsOnLevel(building: BuildingModel, levelId: string): WallElement[] {
  return building.elementOrder
    .map((id) => building.elements[id])
    .filter(
      (element): element is WallElement =>
        element !== undefined && element.category === 'wall' && element.levelId === levelId,
    );
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
  const curved = new Set<string>();
  const tangents = building.elementOrder.flatMap((id) => {
    const element = building.elements[id];
    if (element?.category !== 'curvedWall' || element.levelId !== wall.levelId) return [];
    curved.add(element.id);
    return [tangentWall(element, arcOffsetOf(element, point))];
  });
  for (const other of [...wallsOnLevel(building, wall.levelId), ...tangents]) {
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
      if (!curved.has(other.id) && building.elementOrder.indexOf(other.id) < ownIndex) {
        return retraction;
      }
      const otherAway: Vec2 = atOtherStart
        ? otherFrame.direction
        : [-otherFrame.direction[0], -otherFrame.direction[1]];
      const cosine = away[0] * otherAway[0] + away[1] * otherAway[1];
      return (other.thickness / 2 + (wall.thickness / 2) * cosine) / sine;
    }
    const projection = projectOntoSegment(point, other.start, other.end);
    if (projection.distance <= tolerance && projection.t > 0 && projection.t < 1) {
      return retraction;
    }
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

/** Vertical rectangular pieces [s0,s1]×[z0,z1] (wall-local) left solid after cutting the openings. */
export function wallPieces(
  wall: WallElement,
  openings: ReadonlyArray<OpeningElement>,
  extent: WallExtent,
): Array<{ s0: number; s1: number; z0: number; z1: number }> {
  const pieces: Array<{ s0: number; s1: number; z0: number; z1: number }> = [];
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
