/**
 * @layer ui/components/toolbar
 *
 * One-click 3D primitive presets for the main toolbar: which add_* command to dispatch, with
 * default dimensions, and where to drop it so it never lands inside existing geometry.
 * Param-gathering only — the entity itself is built by the command (PRIME DIRECTIVE).
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import { rotatedEntityBounds } from '@core/commands/sceneRotatedBounds';
import type { IconName } from '@ui/components/Icon';

type SolidCommand =
  | 'add_box'
  | 'add_cylinder'
  | 'add_sphere'
  | 'add_cone'
  | 'add_torus'
  | 'add_wedge'
  | 'add_pyramid';

export interface SolidPreset {
  /** Registry command name. */
  command: SolidCommand;
  label: string;
  icon: IconName;
  /** Default dimension params; position + anchor are added by solidCommandParams. */
  dimensions: Record<string, number | Vec3>;
}

export const SOLID_PRESETS: readonly SolidPreset[] = [
  { command: 'add_box', label: 'Box', icon: 'cube', dimensions: { size: [2, 2, 2] } },
  {
    command: 'add_cylinder',
    label: 'Cylinder',
    icon: 'solidCylinder',
    dimensions: { radius: 1, height: 2 },
  },
  { command: 'add_sphere', label: 'Sphere', icon: 'solidSphere', dimensions: { radius: 1 } },
  { command: 'add_cone', label: 'Cone', icon: 'solidCone', dimensions: { radius: 1, height: 2 } },
  {
    command: 'add_torus',
    label: 'Torus',
    icon: 'solidTorus',
    dimensions: { ringRadius: 1, tubeRadius: 0.35 },
  },
  { command: 'add_wedge', label: 'Wedge', icon: 'solidWedge', dimensions: { size: [2, 2, 2] } },
  {
    command: 'add_pyramid',
    label: 'Pyramid',
    icon: 'solidPyramid',
    dimensions: { baseWidth: 2, baseDepth: 2, height: 2 },
  },
];

/** Gap (document units) left between a new primitive and the existing scene. */
const PLACEMENT_GAP = 1.5;

/** Half-width of the default primitives' footprint. */
const DEFAULT_HALF_WIDTH = 1;

/** Grid pitch of candidate drop points: one primitive plus a gap. */
const SLOT_PITCH = 2 * DEFAULT_HALF_WIDTH + PLACEMENT_GAP;

/** Candidate rings searched around the origin before falling back to the scene's +X edge. */
const MAX_SLOT_RINGS = 12;

interface Footprint {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

function footprints(document: CadDocument): Footprint[] {
  const result: Footprint[] = [];
  for (const id of document.order) {
    const entity = document.entities[id];
    if (entity === undefined) continue;
    const { min, max } = rotatedEntityBounds(entity);
    if (![min[0], min[1], max[0], max[1]].every(Number.isFinite)) continue;
    result.push({ minX: min[0], maxX: max[0], minY: min[1], maxY: max[1] });
  }
  return result;
}

function slotIsFree(x: number, y: number, occupied: readonly Footprint[]): boolean {
  const half = DEFAULT_HALF_WIDTH + PLACEMENT_GAP / 2;
  return occupied.every(
    (f) => x + half <= f.minX || x - half >= f.maxX || y + half <= f.minY || y - half >= f.maxY,
  );
}

/** Slots of ring `ring` (Chebyshev distance from the origin cell), nearest first. */
function ringSlots(ring: number): Array<[number, number]> {
  const slots: Array<[number, number]> = [];
  // `0 - ring` (not `-ring`) so the origin slot is +0, never -0.
  for (let i = 0 - ring; i <= ring; i++) {
    for (let j = 0 - ring; j <= ring; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) === ring) slots.push([i, j]);
    }
  }
  return slots.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || b[0] - a[0]);
}

/**
 * Base-center drop point for a new primitive: the free grid slot nearest the origin (so it lands
 * in view), resting on the ground plane (z = 0). Falls back to just past the scene's +X edge.
 * `reserved` drop points (creations not yet in the document) count as occupied.
 */
export function nextPlacement(document: CadDocument, reserved: readonly Vec3[] = []): Vec3 {
  const half = DEFAULT_HALF_WIDTH;
  const occupied = [
    ...footprints(document),
    ...reserved.map(([x, y]) => ({
      minX: x - half,
      maxX: x + half,
      minY: y - half,
      maxY: y + half,
    })),
  ];
  for (let ring = 0; ring <= MAX_SLOT_RINGS; ring++) {
    for (const [i, j] of ringSlots(ring)) {
      const x = i * SLOT_PITCH;
      const y = j * SLOT_PITCH;
      if (slotIsFree(x, y, occupied)) return [x, y, 0];
    }
  }
  const maxX = Math.max(...occupied.map((f) => f.maxX));
  return [maxX + PLACEMENT_GAP + DEFAULT_HALF_WIDTH, 0, 0];
}

/** Full add_* params for a preset dropped at `position` (base-center anchored, sits on z = 0). */
export function solidCommandParams(preset: SolidPreset, position: Vec3): Record<string, unknown> {
  return { ...preset.dimensions, position, anchor: 'base-center' };
}
