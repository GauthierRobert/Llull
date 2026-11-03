// LOD selection for the streamed cloud (TECHNICAL_SPEC §5.3): coarse first, refine by projected size within a hard point budget.
// A tile is one budgeted box query; its level is the budget of that query (whole octree levels, so a finer level contains the coarser).

import type { Vec3 } from '@core/model/vectors';
import type { CloudTile } from './tileGrid';

/** Points requested per tile at each level (≤ 200 000, the `query_cloud_points` cap). */
export const LEVEL_BUDGETS: readonly number[] = [2_000, 8_000, 32_000, 128_000];

/** Target screen spacing between points (px): a tile of area A px² wants A / SPACING² points. */
const TARGET_SPACING_PX = 3;
/** Tiles smaller than this on screen (diameter, px) are not drawn at all. */
const MIN_TILE_PX = 4;

export interface LodCamera {
  readonly position: Vec3;
  /** Vertical field of view, radians. */
  readonly fov: number;
  /** Viewport height, px. */
  readonly viewportHeight: number;
  /** True when a bounding sphere (centre, radius) touches the view frustum. */
  readonly sees: (centre: Vec3, radius: number) => boolean;
}

/** Projected diameter of a tile's bounding sphere in px (Infinity when the camera is inside it). */
export function tilePixelDiameter(tile: CloudTile, camera: LodCamera): number {
  const distance = Math.hypot(
    tile.centre[0] - camera.position[0],
    tile.centre[1] - camera.position[1],
    tile.centre[2] - camera.position[2],
  );
  if (distance <= tile.radius) return Number.POSITIVE_INFINITY;
  const pixelsPerMetre = camera.viewportHeight / (2 * Math.tan(camera.fov / 2));
  return (2 * tile.radius * pixelsPerMetre) / distance;
}

/** Smallest level whose budget covers `wanted` points (the last one when none does). */
function levelFor(wanted: number): number {
  const index = LEVEL_BUDGETS.findIndex((budget) => budget >= wanted);
  return index === -1 ? LEVEL_BUDGETS.length - 1 : index;
}

/** Level a tile would like on screen, or -1 when it is culled (outside the frustum or too small). */
export function wantedLevel(tile: CloudTile, camera: LodCamera): number {
  if (!camera.sees(tile.centre, tile.radius)) return -1;
  const diameter = tilePixelDiameter(tile, camera);
  if (diameter < MIN_TILE_PX) return -1;
  const area = Number.isFinite(diameter) ? (Math.PI / 4) * diameter * diameter : camera.viewportHeight * camera.viewportHeight;
  return levelFor(area / (TARGET_SPACING_PX * TARGET_SPACING_PX));
}

/** What the streamer knows of a tile: its level, and whether the answer was smaller than asked (nothing finer exists). */
export interface ResidentTile {
  readonly level: number;
  readonly complete: boolean;
}

/**
 * Levels to hold per visible tile key. Every visible tile first gets level 0 (parents before children), then levels are raised
 * one step at a time, biggest on screen first, while the sum of level budgets stays within `pointBudget`. A tile that is `complete`
 * at its resident level is never raised (nothing finer exists). Deterministic: ties break by tile key.
 */
export function selectLevels(
  tiles: readonly CloudTile[],
  camera: LodCamera,
  pointBudget: number,
  resident: ReadonlyMap<string, ResidentTile> = new Map(),
): ReadonlyMap<string, number> {
  const wants = tiles
    .map((tile) => ({ tile, want: wantedLevel(tile, camera), size: tilePixelDiameter(tile, camera) }))
    .filter((entry) => entry.want >= 0)
    .sort((a, b) => (b.size === a.size ? a.tile.key.localeCompare(b.tile.key) : b.size - a.size));
  const levels = new Map<string, number>(wants.map((entry) => [entry.tile.key, 0]));
  let spent = wants.length * (LEVEL_BUDGETS[0] ?? 0);
  let raised = true;
  while (raised) {
    raised = false;
    for (const { tile, want } of wants) {
      const level = levels.get(tile.key) ?? 0;
      const known = resident.get(tile.key);
      const exhausted = known !== undefined && known.complete && level >= known.level;
      if (level >= want || exhausted) continue;
      const extra = (LEVEL_BUDGETS[level + 1] ?? 0) - (LEVEL_BUDGETS[level] ?? 0);
      if (spent + extra > pointBudget) continue;
      levels.set(tile.key, level + 1);
      spent += extra;
      raised = true;
    }
  }
  return levels;
}

/** Sum of the level budgets of a selection (an upper bound of the points drawn). */
export function selectionPoints(levels: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const level of levels.values()) total += LEVEL_BUDGETS[level] ?? 0;
  return total;
}
