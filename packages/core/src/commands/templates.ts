/**
 * Parametric template generators — one-call creation of common CAD patterns.
 *
 * Architecture: an OCP-safe registry of template builders lives in `TEMPLATE_REGISTRY`.
 * Adding a template = add an entry to that record; no caller edits are needed.
 *
 * Each builder returns an ordered array of entities. The command adds them all to the
 * document and returns `affected` in the same deterministic order so that
 * `replay_history` (id-stable replay) can positionally zip the ids.
 *
 * @layer core/commands
 */

import type { Entity, Vec3, Vec2 } from '../model/types';
import { DEFAULT_LAYER_ID } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z, looseVec3 } from './schema';
import { nextId } from '../lib/id';
import { withEntity } from './entityOps';
import { ORIGIN } from '../lib/vec3';
import { MAX_TEMPLATE_ENTITIES } from './limits';

/** Build a circle entity at a given 2D center on the given work-plane position. */
function makeCircle(center: Vec2, radius: number, position: Vec3, color: string): Entity {
  return {
    id: nextId('circ'),
    kind: 'circle',
    center,
    radius,
    position,
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color,
  };
}

/** Build a rectangle entity at the given work-plane position. */
function makeRectangle(width: number, height: number, position: Vec3, color: string): Entity {
  return {
    id: nextId('rect'),
    kind: 'rectangle',
    width,
    height,
    position,
    rotation: [0, 0, 0],
    layerId: DEFAULT_LAYER_ID,
    color,
  };
}

const positive = (template: string, name: string, value: number): string | null =>
  !Number.isFinite(value) || value <= 0 ? `${template}: ${name} must be > 0 (got ${value}).` : null;

const nonNegative = (template: string, name: string, value: number): string | null =>
  !Number.isFinite(value) || value < 0 ? `${template}: ${name} must be >= 0 (got ${value}).` : null;

const integerAtLeastOne = (template: string, name: string, value: number): string | null =>
  !Number.isFinite(value) || value < 1 || !Number.isInteger(value)
    ? `${template}: ${name} must be an integer >= 1 (got ${value}).`
    : null;

interface BoltHolePatternParams {
  count: number;
  boltCircleRadius: number;
  holeRadius: number;
}

interface FlangeParams {
  outerRadius: number;
  boreRadius: number;
  boltCount: number;
  boltCircleRadius: number;
  holeRadius: number;
}

interface RectangularPlateWithHolesParams {
  width: number;
  height: number;
  holeRows: number;
  holeCols: number;
  holeRadius: number;
  marginX: number;
  marginY: number;
}

type TemplateName = 'bolt_hole_pattern' | 'flange' | 'rectangular_plate_with_holes';

interface TemplateEntry<P> {
  /** Human-readable one-line description for the template (shown to MCP agents). */
  description: string;
  /** Validate params; return error string on failure, null on success. */
  validate(params: P): string | null;
  /** Build and return entities in deterministic creation order. */
  build(params: P, position: Vec3, color: string): Entity[];
}

// Using `unknown` here; each entry narrows internally. The outer command narrows via the map.
const TEMPLATE_REGISTRY: Record<TemplateName, TemplateEntry<never>> = {
  bolt_hole_pattern: {
    description:
      'N equally-spaced bolt holes (circles) arranged on a bolt circle. ' +
      'count must be >= 1; boltCircleRadius and holeRadius must be > 0.',
    validate(params: BoltHolePatternParams): string | null {
      const t = 'bolt_hole_pattern';
      return (
        integerAtLeastOne(t, 'count', params.count) ??
        (params.count > MAX_TEMPLATE_ENTITIES
          ? `${t}: count ${params.count} exceeds MAX_TEMPLATE_ENTITIES (${MAX_TEMPLATE_ENTITIES}).`
          : null) ??
        positive(t, 'boltCircleRadius', params.boltCircleRadius) ??
        positive(t, 'holeRadius', params.holeRadius)
      );
    },
    build(params: BoltHolePatternParams, position: Vec3, color: string): Entity[] {
      const entities: Entity[] = [];
      for (let i = 0; i < params.count; i++) {
        const angle = (2 * Math.PI * i) / params.count;
        const cx = params.boltCircleRadius * Math.cos(angle);
        const cy = params.boltCircleRadius * Math.sin(angle);
        entities.push(makeCircle([cx, cy], params.holeRadius, position, color));
      }
      return entities;
    },
  } as TemplateEntry<never>,

  flange: {
    description:
      'A flange: outer circle + bore circle + a bolt-hole pattern ring. ' +
      'outerRadius > boltCircleRadius + holeRadius; boreRadius < outerRadius; boltCount >= 1; all radii > 0.',
    validate(params: FlangeParams): string | null {
      const t = 'flange';
      return (
        positive(t, 'outerRadius', params.outerRadius) ??
        positive(t, 'boreRadius', params.boreRadius) ??
        (params.boreRadius >= params.outerRadius
          ? `${t}: boreRadius (${params.boreRadius}) must be < outerRadius (${params.outerRadius}).`
          : null) ??
        integerAtLeastOne(t, 'boltCount', params.boltCount) ??
        (params.boltCount + 2 > MAX_TEMPLATE_ENTITIES
          ? `${t}: boltCount ${params.boltCount} exceeds MAX_TEMPLATE_ENTITIES (${MAX_TEMPLATE_ENTITIES}).`
          : null) ??
        positive(t, 'boltCircleRadius', params.boltCircleRadius) ??
        positive(t, 'holeRadius', params.holeRadius)
      );
    },
    build(params: FlangeParams, position: Vec3, color: string): Entity[] {
      // Order: [outerCircle, boreCircle, hole_0, hole_1, ..., hole_n-1]
      const entities: Entity[] = [];
      // Outer ring
      entities.push(makeCircle([0, 0], params.outerRadius, position, color));
      // Bore
      entities.push(makeCircle([0, 0], params.boreRadius, position, color));
      // Bolt holes
      for (let i = 0; i < params.boltCount; i++) {
        const angle = (2 * Math.PI * i) / params.boltCount;
        const cx = params.boltCircleRadius * Math.cos(angle);
        const cy = params.boltCircleRadius * Math.sin(angle);
        entities.push(makeCircle([cx, cy], params.holeRadius, position, color));
      }
      return entities;
    },
  } as TemplateEntry<never>,

  rectangular_plate_with_holes: {
    description:
      'A rectangular plate with a uniform grid of bolt holes. ' +
      'width and height must be > 0; holeRows and holeCols must be >= 1; holeRadius > 0; ' +
      'marginX and marginY set the inset from the plate edge to the outermost hole centers.',
    validate(params: RectangularPlateWithHolesParams): string | null {
      const t = 'rectangular_plate_with_holes';
      return (
        positive(t, 'width', params.width) ??
        positive(t, 'height', params.height) ??
        integerAtLeastOne(t, 'holeRows', params.holeRows) ??
        integerAtLeastOne(t, 'holeCols', params.holeCols) ??
        (params.holeRows * params.holeCols + 1 > MAX_TEMPLATE_ENTITIES
          ? `${t}: holeRows*holeCols (${params.holeRows * params.holeCols}) exceeds MAX_TEMPLATE_ENTITIES (${MAX_TEMPLATE_ENTITIES}).`
          : null) ??
        positive(t, 'holeRadius', params.holeRadius) ??
        nonNegative(t, 'marginX', params.marginX) ??
        nonNegative(t, 'marginY', params.marginY)
      );
    },
    build(params: RectangularPlateWithHolesParams, position: Vec3, color: string): Entity[] {
      // Order: [plate (rectangle), hole_row0_col0, hole_row0_col1, ..., hole_rowN_colM]
      const entities: Entity[] = [];
      // Plate: origin at lower-left corner of the work plane
      entities.push(makeRectangle(params.width, params.height, position, color));

      // Grid of holes, centered in the plate with margin inset.
      // Plate lower-left corner is at position (work-plane local origin),
      // so hole local coords are offset from [0,0] by marginX/marginY.
      const colSpacing =
        params.holeCols > 1 ? (params.width - 2 * params.marginX) / (params.holeCols - 1) : 0;
      const rowSpacing =
        params.holeRows > 1 ? (params.height - 2 * params.marginY) / (params.holeRows - 1) : 0;

      for (let row = 0; row < params.holeRows; row++) {
        for (let col = 0; col < params.holeCols; col++) {
          const cx = params.marginX + col * colSpacing;
          const cy = params.marginY + row * rowSpacing;
          entities.push(makeCircle([cx, cy], params.holeRadius, position, color));
        }
      }
      return entities;
    },
  } as TemplateEntry<never>,
};

const VALID_TEMPLATES: readonly TemplateName[] = [
  'bolt_hole_pattern',
  'flange',
  'rectangular_plate_with_holes',
];

/**
 * @command instantiate_template
 * @pure
 * @layer core/commands
 * @affects creates N entities (plate + holes, or circles in pattern) in deterministic order
 * @invariant affected[i] is stable across replay (id-stable replay)
 * @failure unknown template -> no-op; invalid per-template params -> no-op, affected:[]
 */
export const instantiateTemplate = defineCommand({
  name: 'instantiate_template',
  description:
    'Create a common parametric CAD part in a single call. ' +
    'template selects which generator to use; params are the template dimensions. ' +
    'Returns all created entity ids in a deterministic order. ' +
    'Templates: ' +
    '"bolt_hole_pattern" — N equally-spaced circles on a bolt circle (params: count, boltCircleRadius, holeRadius); ' +
    '"flange" — outer circle + bore circle + bolt-hole ring (params: outerRadius, boreRadius, boltCount, boltCircleRadius, holeRadius); ' +
    '"rectangular_plate_with_holes" — rectangle plate + grid of circles (params: width, height, holeRows, holeCols, holeRadius, marginX, marginY).',
  params: z.object({
    template: z
      .enum(VALID_TEMPLATES)
      .describe(
        'Which template to instantiate. Must be one of: ' +
          '"bolt_hole_pattern", "flange", "rectangular_plate_with_holes".',
      ),
    params: z
      .looseObject({})
      .describe(
        'Template-specific dimension parameters as a JSON object. ' +
          'bolt_hole_pattern: { count: number, boltCircleRadius: number, holeRadius: number }. ' +
          'flange: { outerRadius, boreRadius, boltCount, boltCircleRadius, holeRadius }. ' +
          'rectangular_plate_with_holes: { width, height, holeRows, holeCols, holeRadius, marginX, marginY }.',
      ),
    position: looseVec3(
      'World-space [x, y, z] position of the work-plane origin for the template. Defaults to [0, 0, 0].',
    ).optional(),
    color: z
      .string()
      .optional()
      .describe(
        'Hex color string for all created entities, e.g. "#4a90d9". Defaults to "#4a90d9".',
      ),
  }),
  run: (doc, { template, params, position = ORIGIN, color = '#4a90d9' }): CommandResult => {
    // Validate template name
    if (!VALID_TEMPLATES.includes(template as TemplateName)) {
      return {
        document: doc,
        summary: `instantiate_template: unknown template "${String(template)}". Valid templates: ${VALID_TEMPLATES.join(', ')}.`,
        affected: [],
      };
    }

    const entry = TEMPLATE_REGISTRY[template as TemplateName];

    // Validate per-template params
    const validationError = (entry as TemplateEntry<Record<string, unknown>>).validate(
      params as never,
    );
    if (validationError !== null) {
      return {
        document: doc,
        summary: validationError,
        affected: [],
      };
    }

    // Build entities — deterministic order guaranteed by each builder
    const entities = (entry as TemplateEntry<Record<string, unknown>>).build(
      params as never,
      position,
      color,
    );

    if (entities.length === 0) {
      return {
        document: doc,
        summary: `instantiate_template: template "${template}" produced 0 entities (no-op).`,
        affected: [],
      };
    }

    const affected = entities.map((e) => e.id);
    const newDoc = entities.reduce(withEntity, doc);

    return {
      document: newDoc,
      summary: `Instantiated template "${template}": created ${entities.length} entities [${affected.join(', ')}].`,
      affected,
    };
  },
});
