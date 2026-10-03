/**
 * members: memberFootingPanelCommands.
 * @layer domain-aec
 */

import type { CadDocument, Vec2, Vec3 } from '@core/model/types';
import type { BuildingModel, FootingElement, PanelElement } from '@core/model/building';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, z } from '@core/commands/schema';
import {
  elementAffected,
  fromMm,
  getBuilding,
  isFiniteNumber,
  isVec2,
  nextElementId,
  nextMark,
  noChange,
  resolveLevel,
  toVec2,
  withElement,
} from '../model';
import { regenerateBuilding } from '../evaluate';
import { panelFrame } from './evaluate';
import { levelIdSchema, toVec3 } from './memberSupport';

/** Upper bound on members one generator call may create (keeps agents from hanging the host). */
export const MAX_GENERATED_MEMBERS = 5000;

/**
 * Plan positions of every column foot on a level (steel columns and concrete columns),
 * de-duplicated; restricted to `onlyIds` when given.
 */
export function columnFeet(
  building: BuildingModel,
  levelId: string,
  tolerance: number,
  onlyIds?: ReadonlySet<string>,
): Vec2[] {
  const feet: Vec2[] = [];
  for (const element of Object.values(building.elements)) {
    if (!('levelId' in element) || element.levelId !== levelId) continue;
    if (onlyIds && !onlyIds.has(element.id)) continue;
    let foot: Vec2 | null = null;
    if (element.category === 'column') foot = element.location;
    if (element.category === 'member' && element.role === 'column') {
      foot =
        element.start[2] <= element.end[2]
          ? [element.start[0], element.start[1]]
          : [element.end[0], element.end[1]];
    }
    if (
      foot &&
      !feet.some(
        (existing) => Math.hypot(existing[0] - foot[0], existing[1] - foot[1]) <= tolerance,
      )
    ) {
      feet.push(foot);
    }
  }
  return feet;
}

/** `locations` without the ones already carrying a footing on the level. */
export function withoutFootings(
  building: BuildingModel,
  levelId: string,
  locations: ReadonlyArray<Vec2>,
  tolerance: number,
): Vec2[] {
  const existing = Object.values(building.elements).flatMap((element) =>
    element.category === 'footing' && element.levelId === levelId ? [element.location] : [],
  );
  return locations.filter(
    (location) =>
      !existing.some(
        (footing) => Math.hypot(footing[0] - location[0], footing[1] - location[1]) <= tolerance,
      ),
  );
}

/** Adds pad footings (no regeneration). */
export function appendFootings(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  locations: ReadonlyArray<Vec2>,
  size: {
    width?: number;
    length?: number;
    thickness?: number;
    topOffset?: number;
    material?: string;
  },
): { building: BuildingModel; ids: string[] } {
  let next = building;
  const ids: string[] = [];
  const width = size.width ?? fromMm(doc, 1500);
  for (const location of locations) {
    const footing: FootingElement = {
      id: nextElementId(next, 'footing'),
      category: 'footing',
      mark: nextMark(next, 'footing'),
      entityIds: [],
      levelId,
      location: toVec2(location),
      width,
      length: size.length ?? width,
      thickness: size.thickness ?? fromMm(doc, 600),
      topOffset: size.topOffset ?? -fromMm(doc, 300),
      material: size.material?.trim() || 'concrete',
    };
    next = withElement(next, footing);
    ids.push(footing.id);
  }
  return { building: next, ids };
}

/**
 * @command add_footing
 * @pure
 * @affects creates 1 pad footing, or one under every column of the level
 * @failure no location / no columns / sizes <= 0 -> no-op
 */
export const addFooting = defineCommand({
  name: 'add_footing',
  description:
    'Add concrete pad footings: one at a plan location, or (underColumns: true) one under every steel and ' +
    'concrete column foot of the level. Top of footing at level + topOffset (default −300 mm); default ' +
    '1500 × 1500 × 600 mm.',
  params: z.object({
    location: z.array(z.number()).optional().describe('Footing centre [x, y].'),
    underColumns: z.boolean().optional().describe('Place one under each column of the level.'),
    width: z.number().optional().describe('Size along X. Default 1500 mm.'),
    length: z.number().optional().describe('Size along Y. Default = width.'),
    thickness: z.number().optional().describe('Depth of the pad. Default 600 mm.'),
    topOffset: z
      .number()
      .optional()
      .describe('Top of footing relative to the level. Default −300 mm.'),
    levelId: levelIdSchema,
    material: z.string().optional().describe('Default concrete.'),
  }),
  run: (doc, params): CommandResult => {
    const positive = (value: number | undefined): boolean =>
      value === undefined || (isFiniteNumber(value) && value > 0);
    if (!positive(params.width) || !positive(params.length) || !positive(params.thickness)) {
      return noChange(doc, 'add_footing failed: width, length and thickness must be > 0.');
    }
    if (params.topOffset !== undefined && !isFiniteNumber(params.topOffset)) {
      return noChange(doc, 'add_footing failed: topOffset must be finite.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok) return noChange(doc, `add_footing failed: ${resolution.reason}.`);
    const feet = params.underColumns
      ? columnFeet(resolution.building, resolution.level.id, fromMm(doc, 10))
      : [];
    const locations = params.underColumns
      ? withoutFootings(resolution.building, resolution.level.id, feet, fromMm(doc, 10))
      : isVec2(params.location)
        ? [toVec2(params.location)]
        : [];
    if (locations.length === 0) {
      return noChange(
        doc,
        !params.underColumns
          ? 'add_footing failed: location must be [x, y] (or set underColumns).'
          : feet.length === 0
            ? 'add_footing failed: the level has no columns.'
            : 'add_footing failed: every column already has a footing.',
      );
    }
    const added = appendFootings(doc, resolution.building, resolution.level.id, locations, {
      ...(params.width !== undefined ? { width: params.width } : {}),
      ...(params.length !== undefined ? { length: params.length } : {}),
      ...(params.thickness !== undefined ? { thickness: params.thickness } : {}),
      ...(params.topOffset !== undefined ? { topOffset: params.topOffset } : {}),
      ...(params.material !== undefined ? { material: params.material } : {}),
    });
    const document = regenerateBuilding(doc, added.building);
    return {
      document,
      summary: `Added ${added.ids.length} pad footing(s) ${added.ids.join(', ')}.`,
      affected: elementAffected(document, added.ids),
      data: { elementIds: added.ids },
    };
  },
});

/** Adds one cladding panel (no regeneration); null when the corners are not a usable plane. */
export function appendPanel(
  doc: CadDocument,
  building: BuildingModel,
  levelId: string,
  spec: { corners: Vec3[]; role: 'roof' | 'wall'; thickness?: number; material?: string },
): { building: BuildingModel; id: string } | null {
  if (spec.corners.length < 3 || !panelFrame(spec.corners)) return null;
  const panel: PanelElement = {
    id: nextElementId(building, 'panel'),
    category: 'panel',
    mark: nextMark(building, 'panel'),
    entityIds: [],
    levelId,
    role: spec.role,
    corners: spec.corners,
    thickness: spec.thickness ?? fromMm(doc, 80),
    material: spec.material?.trim() || 'sandwich-panel',
  };
  return { building: withElement(building, panel), id: panel.id };
}

/**
 * @command add_panel
 * @pure
 * @affects creates 1 cladding panel (mesh on layer A-CLAD)
 * @failure < 3 corners / degenerate plane / thickness <= 0 -> no-op
 */
export const addPanel = defineCommand({
  name: 'add_panel',
  description:
    'Add a planar cladding, roofing or sandwich panel through 3D corners [[x, y, z], …] (z above the level). ' +
    'The panel thickness grows along the plane normal (right-hand rule on the corner order). Use for ' +
    'pitched roofs, façades and gables.',
  params: z.object({
    corners: z.array(z.array(z.number())).describe('Coplanar corners [[x, y, z], …], at least 3.'),
    role: z.enum(['roof', 'wall']).optional().describe('Roofing or wall cladding. Default wall.'),
    thickness: z.number().optional().describe('Panel thickness. Default 80 mm.'),
    levelId: levelIdSchema,
    material: z.string().optional().describe('Default sandwich-panel (or steel-sheet, …).'),
  }),
  run: (doc, { corners, role = 'wall', thickness, levelId, material }): CommandResult => {
    const points = Array.isArray(corners) ? corners.map(toVec3) : [];
    if (points.length < 3 || points.some((point) => point === null)) {
      return noChange(doc, 'add_panel failed: corners must be ≥ 3 [x, y, z] points.');
    }
    if (thickness !== undefined && !(isFiniteNumber(thickness) && thickness > 0)) {
      return noChange(doc, 'add_panel failed: thickness must be > 0.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noChange(doc, `add_panel failed: ${resolution.reason}.`);
    const added = appendPanel(doc, resolution.building, resolution.level.id, {
      corners: points as Vec3[],
      role: role === 'roof' ? 'roof' : 'wall',
      ...(thickness !== undefined ? { thickness } : {}),
      ...(material !== undefined ? { material } : {}),
    });
    if (!added) return noChange(doc, 'add_panel failed: the corners do not span a plane.');
    const document = regenerateBuilding(doc, added.building);
    return {
      document,
      summary: `Added ${role} panel ${document.building?.elements[added.id]?.mark ?? ''} (${added.id}).`,
      affected: elementAffected(document, [added.id]),
      data: { elementId: added.id },
    };
  },
});
