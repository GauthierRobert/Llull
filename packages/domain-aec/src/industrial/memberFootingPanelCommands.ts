/**
 * @layer domain-aec
 */

import type { Vec3 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, vec2, z } from '@core/commands/schema';
import { elementAffected, fromMm, getBuilding, resolveLevel } from '../model';
import { noop } from '@core/commands/noop';
import { regenerateBuilding } from '../evaluateElements';
import { appendFootings, appendPanel, columnFeet, withoutFootings } from './footingPanelSupport';
import { toVec3 } from './memberSupport';
import { levelIdParam } from '../levelParams';

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
    location: vec2('Footing centre [x, y].').optional(),
    underColumns: z.boolean().optional().describe('Place one under each column of the level.'),
    width: z.number().optional().describe('Size along X, in document units. Default 1500 mm.'),
    length: z.number().optional().describe('Size along Y. Default = width.'),
    thickness: z
      .number()
      .optional()
      .describe('Depth of the pad, in document units. Default 600 mm.'),
    topOffset: z
      .number()
      .optional()
      .describe('Top of footing relative to the level, in document units. Default −300 mm.'),
    levelId: levelIdParam,
    material: z.string().optional().describe('Default concrete.'),
  }),
  run: (doc, params): CommandResult => {
    const { width, length, thickness, topOffset, material } = params;
    const positive = (value: number | undefined): boolean => value === undefined || value > 0;
    if (!positive(width) || !positive(length) || !positive(thickness)) {
      return noop(doc, 'add_footing failed: width, length and thickness must be > 0.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), params.levelId);
    if (!resolution.ok) return noop(doc, `add_footing failed: ${resolution.reason}.`);
    const feet = params.underColumns
      ? columnFeet(resolution.building, resolution.level.id, fromMm(doc, 10))
      : [];
    const locations = params.underColumns
      ? withoutFootings(resolution.building, resolution.level.id, feet, fromMm(doc, 10))
      : params.location
        ? [params.location]
        : [];
    if (locations.length === 0) {
      return noop(
        doc,
        !params.underColumns
          ? 'add_footing failed: give location [x, y] (or set underColumns).'
          : feet.length === 0
            ? 'add_footing failed: the level has no columns.'
            : 'add_footing failed: every column already has a footing.',
      );
    }
    const added = appendFootings(doc, resolution.building, resolution.level.id, locations, {
      width,
      length,
      thickness,
      topOffset,
      material,
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

const MAX_PANEL_CORNERS = 500;

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
    corners: z.array(z.array(z.number())).describe('Coplanar corners [[x, y, z], …], 3 to 500.'),
    role: z.enum(['roof', 'wall']).optional().describe('Roofing or wall cladding. Default wall.'),
    thickness: z.number().optional().describe('Panel thickness, in document units. Default 80 mm.'),
    levelId: levelIdParam,
    material: z.string().optional().describe('Default sandwich-panel (or steel-sheet, …).'),
  }),
  run: (doc, { corners, role = 'wall', thickness, levelId, material }): CommandResult => {
    if (corners.length > MAX_PANEL_CORNERS) {
      return noop(
        doc,
        `add_panel failed: at most ${MAX_PANEL_CORNERS} corners (got ${corners.length}); a panel is a planar polygon, split a complex outline.`,
      );
    }
    const points = corners.map(toVec3);
    if (points.length < 3 || points.some((point) => point === null)) {
      return noop(doc, 'add_panel failed: corners must be ≥ 3 [x, y, z] points.');
    }
    if (thickness !== undefined && !(thickness > 0)) {
      return noop(doc, 'add_panel failed: thickness must be > 0.');
    }
    const resolution = resolveLevel(doc, getBuilding(doc), levelId);
    if (!resolution.ok) return noop(doc, `add_panel failed: ${resolution.reason}.`);
    const added = appendPanel(doc, resolution.building, resolution.level.id, {
      corners: points as Vec3[],
      role,
      thickness,
      material,
    });
    if (!added) return noop(doc, 'add_panel failed: the corners do not span a plane.');
    const document = regenerateBuilding(doc, added.building);
    return {
      document,
      summary: `Added ${role} panel ${document.building?.elements[added.id]?.mark ?? ''} (${added.id}).`,
      affected: elementAffected(document, [added.id]),
      data: { elementId: added.id },
    };
  },
});
