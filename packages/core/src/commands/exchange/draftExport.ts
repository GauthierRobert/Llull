/**
 * What `export_dxf` and `export_svg` write: the 2D entities of a document (all, or `ids`) as world-space drafting shapes, with the refusals
 * and named skips shared by both. Pure; the format files only map a shape to their syntax.
 */

import { type CadDocument, type Entity, type Vec2, is2D } from '../../model/types';
import type { RegionHatch } from '../../model/regionHatch';
import { DEFAULT_DIMENSION_OFFSET, dimensionDrawing, dimensionText } from '../../geometry/dimensionAnnotation';
import { catmullRomBeziers } from '../../geometry/curveSegments';
import { entityPlanPoint } from '../../geometry/entityFrame';
import type { CommandResult } from '../types';
import { tableRejection } from '../noop';

/** Dimension text height, drawing units (the viewport's default; the same as `export_building_dxf`). */
export const DIMENSION_TEXT_HEIGHT = 0.6;

/** Entities are on the XY plane when their x / y Euler rotations are below this (radians). */
const PLANE_TOLERANCE = 1e-9;

type Bezier = readonly [Vec2, Vec2, Vec2, Vec2];

/** A world-space drafting shape. Angles in radians, counter-clockwise from +X. */
export type DraftShape =
  | { readonly kind: 'line'; readonly a: Vec2; readonly b: Vec2 }
  | {
      readonly kind: 'polyline';
      readonly points: ReadonlyArray<Vec2>;
      readonly closed: boolean;
      /** `rectangle`: the 4 corners as [origin, +width, +width +height, +height]. */
      readonly rectangle: boolean;
    }
  | { readonly kind: 'arc'; readonly center: Vec2; readonly radius: number; readonly start: number; readonly end: number }
  | { readonly kind: 'circle'; readonly center: Vec2; readonly radius: number }
  /** Complete ellipse: `major` is the semi-major vector from the centre, `ratio` minor / major (<= 1). */
  | { readonly kind: 'ellipse'; readonly center: Vec2; readonly major: Vec2; readonly ratio: number }
  /** Centripetal Catmull-Rom through `points` (`closed` joins the ends) and the same curve as cubic Béziers. */
  | { readonly kind: 'spline'; readonly points: ReadonlyArray<Vec2>; readonly closed: boolean; readonly beziers: ReadonlyArray<Bezier> }
  | { readonly kind: 'point'; readonly at: Vec2 }
  | {
      readonly kind: 'text';
      readonly at: Vec2;
      readonly height: number;
      readonly rotation: number;
      readonly content: string;
      readonly anchor: 'left' | 'center' | 'right';
    }
  /** Even-odd area; `ordinal` numbers the regions of one export (loops of an unhatched region share it). */
  | {
      readonly kind: 'region';
      readonly loops: ReadonlyArray<ReadonlyArray<Vec2>>;
      readonly hatch: RegionHatch | null;
      readonly ordinal: number;
    };

export interface DraftItem {
  readonly id: string;
  readonly layerName: string;
  /** Layer tint (`#rrggbb`), null when the layer has none. */
  readonly layerColor: string | null;
  readonly visible: boolean;
  readonly locked: boolean;
  /** The entity's own colour (`#rrggbb`). */
  readonly color: string;
  /** Elevation of the entity's plane. */
  readonly z: number;
  readonly shape: DraftShape;
}

export interface DraftSkip {
  readonly id: string;
  readonly kind: string;
  readonly reason: SkipReason;
}

export interface DraftPlan {
  readonly items: DraftItem[];
  /** 2D entities left out (only when `ids` was omitted), each with a code; never silent. */
  readonly skipped: DraftSkip[];
  /** Exported entity ids and how many of them were dimensions (written as geometry + text). */
  readonly entityIds: string[];
  readonly dimensions: number;
}

type SkipReason = 'TILTED_PLANE' | 'IMAGE_UNDERLAY' | 'DIMENSION_DANGLING' | 'BAD_GEOMETRY';

const REMEDIATION: Readonly<Record<string, string>> = {
  EXPORT2D_EMPTY_SELECTION: 'Pass at least one 2D entity id in `ids`, or omit `ids` to export every 2D entity.',
  EXPORT2D_NO_ENTITIES: 'Draw 2D entities first (draw_line, draw_polyline, draw_rectangle, draw_arc, add_text…), then export.',
  EXPORT2D_UNKNOWN_ID: 'List the document with `llull entities` / find_entities and pass existing ids.',
  EXPORT2D_NOT_2D:
    'These formats write 2D drafting entities only. Drop the id, or use export_sheet_svg for a 3D solid view, export_step / export_stl for the solid itself.',
  EXPORT2D_TILTED_PLANE: 'Rotate the entity onto the XY plane (rotation x = y = 0), or omit `ids` to skip tilted entities with a warning.',
  EXPORT2D_IMAGE_UNDERLAY:
    'A raster underlay is tracing reference, not drawing content: drop its id, or omit `ids` to skip it with a warning.',
  EXPORT2D_DIMENSION_DANGLING: 'Re-run add_dimension on existing geometry (a referenced entity was deleted), or drop the dimension id.',
  EXPORT2D_BAD_GEOMETRY: 'Fix the entity (a non-finite coordinate); run check_model to find it.',
};

const reject = tableRejection(REMEDIATION);

const finite = (value: unknown): boolean => {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(finite);
  if (value !== null && typeof value === 'object') return Object.values(value).every(finite);
  return true;
};

const layerOf = (doc: CadDocument, entity: Entity): Omit<DraftItem, 'id' | 'shape' | 'z' | 'color'> => {
  const layer = doc.layers[entity.layerId];
  return {
    layerName: layer?.name ?? '0',
    layerColor: layer?.color ?? null,
    visible: layer?.visible ?? true,
    locked: layer?.locked ?? false,
  };
};

/** The shapes of one 2D entity in world xy, or the reason it cannot be exported. */
function shapesOf(
  doc: CadDocument,
  entity: Extract<Entity, { kind: import('../../model/types').Shape2DKind }>,
  ordinal: number,
): DraftShape[] | SkipReason {
  if (entity.kind === 'image') return 'IMAGE_UNDERLAY';
  if (Math.abs(entity.rotation[0]) > PLANE_TOLERANCE || Math.abs(entity.rotation[1]) > PLANE_TOLERANCE) return 'TILTED_PLANE';
  const world = (point: Vec2): Vec2 => entityPlanPoint(entity, point);
  const turn = entity.rotation[2];
  switch (entity.kind) {
    case 'line':
      return [{ kind: 'line', a: world(entity.start), b: world(entity.end) }];
    case 'polyline':
      return [{ kind: 'polyline', points: entity.points.map(world), closed: entity.closed, rectangle: false }];
    case 'rectangle': {
      const { width, height } = entity;
      const corners: Vec2[] = [world([0, 0]), world([width, 0]), world([width, height]), world([0, height])];
      return [{ kind: 'polyline', points: corners, closed: true, rectangle: true }];
    }
    case 'circle':
      return [{ kind: 'circle', center: world(entity.center), radius: entity.radius }];
    case 'arc':
      return [
        { kind: 'arc', center: world(entity.center), radius: entity.radius, start: entity.startAngle + turn, end: entity.endAngle + turn },
      ];
    case 'ellipse': {
      const wide = entity.radiusX >= entity.radiusY;
      const [major, minor] = wide ? [entity.radiusX, entity.radiusY] : [entity.radiusY, entity.radiusX];
      const axis = wide ? turn : turn + Math.PI / 2;
      return [
        { kind: 'ellipse', center: world(entity.center), major: [major * Math.cos(axis), major * Math.sin(axis)], ratio: minor / major },
      ];
    }
    case 'spline': {
      const local = entity.points.map((point): Vec2 => [point[0], point[1]]);
      const beziers = catmullRomBeziers(local, entity.closed).flatMap((segment) =>
        segment.type === 'bezier' ? [segment.points.map(world) as unknown as Bezier] : [],
      );
      return [{ kind: 'spline', points: entity.points.map(world), closed: entity.closed, beziers }];
    }
    case 'point':
      return [{ kind: 'point', at: [entity.position[0], entity.position[1]] }];
    case 'text':
      return [
        {
          kind: 'text',
          at: [entity.position[0], entity.position[1]],
          height: entity.height,
          rotation: turn,
          content: entity.content,
          anchor: entity.anchor ?? 'left',
        },
      ];
    case 'region': {
      const hatch = entity.hatch === undefined ? null : { ...entity.hatch, angle: entity.hatch.angle + turn };
      return [{ kind: 'region', loops: entity.loops.map((loop) => loop.map(world)), hatch, ordinal }];
    }
    case 'dimension': {
      const refs = entity.entityIds.map((refId) => doc.entities[refId]);
      const drawing = dimensionDrawing(entity.dimensionKind, refs, entity.offset ?? DEFAULT_DIMENSION_OFFSET);
      if (!drawing) return 'DIMENSION_DANGLING';
      return [
        ...drawing.segments.map((segment): DraftShape => ({ kind: 'line', a: segment[0], b: segment[1] })),
        {
          kind: 'text',
          at: drawing.textAt,
          height: DIMENSION_TEXT_HEIGHT,
          rotation: 0,
          content: dimensionText(entity, drawing.value, doc.displayPrecision),
          anchor: 'center',
        },
      ];
    }
  }
}

/** Elevation of a dimension's shapes: the z of its first reference; every other entity sits at its own position z. */
function elevationOf(doc: CadDocument, entity: Entity): number {
  if (entity.kind !== 'dimension') return entity.position[2];
  const ref = doc.entities[entity.entityIds[0] ?? ''];
  return ref === undefined ? 0 : ref.position[2];
}

/**
 * The drafting shapes of `ids` (or of every 2D entity, in document order).
 * @failure empty `ids` -> EXPORT2D_EMPTY_SELECTION; unknown id -> EXPORT2D_UNKNOWN_ID; non-2D id -> EXPORT2D_NOT_2D; an id that cannot be
 *   exported (tilted plane, image, dangling dimension, non-finite) -> EXPORT2D_<REASON>; nothing left -> EXPORT2D_NO_ENTITIES
 */
export function planDraftExport(doc: CadDocument, command: string, ids: readonly string[] | undefined): DraftPlan | CommandResult {
  const explicit = ids !== undefined;
  if (explicit && ids.length === 0) return reject(doc, command, 'EXPORT2D_EMPTY_SELECTION', 'ids is empty');
  if (explicit) {
    const unknown = ids.filter((id) => !Object.hasOwn(doc.entities, id));
    if (unknown.length > 0) return reject(doc, command, 'EXPORT2D_UNKNOWN_ID', `no entity ${unknown.join(', ')}`, unknown, ['ids']);
    const not2d = ids.filter((id) => !is2D(doc.entities[id] as Entity));
    if (not2d.length > 0) {
      const kinds = not2d.map((id) => `${id} (${(doc.entities[id] as Entity).kind})`).join(', ');
      return reject(doc, command, 'EXPORT2D_NOT_2D', `not a 2D entity: ${kinds}`, not2d, ['ids']);
    }
  }
  const wanted = explicit ? new Set(ids) : null;
  const items: DraftItem[] = [];
  const skipped: DraftSkip[] = [];
  const entityIds: string[] = [];
  let dimensions = 0;
  let ordinal = 0;
  for (const id of doc.order) {
    const entity = doc.entities[id];
    if (!entity || !is2D(entity) || (wanted !== null && !wanted.has(id))) continue;
    const shapes = finite(entity) ? shapesOf(doc, entity, ordinal) : 'BAD_GEOMETRY';
    if (typeof shapes === 'string') {
      if (explicit) return reject(doc, command, `EXPORT2D_${shapes}`, `${id} (${entity.kind}) cannot be exported`, [id], ['ids']);
      skipped.push({ id, kind: entity.kind, reason: shapes });
      continue;
    }
    if (entity.kind === 'region') ordinal += 1;
    if (entity.kind === 'dimension') dimensions += 1;
    entityIds.push(id);
    const common = { ...layerOf(doc, entity), color: entity.color, z: elevationOf(doc, entity) };
    for (const shape of shapes) items.push({ id, ...common, shape });
  }
  if (items.length === 0) {
    const why =
      skipped.length > 0
        ? `all ${skipped.length} 2D entities were skipped (${skipped.map((s) => `${s.id}: ${s.reason}`).join(', ')})`
        : 'the document has no 2D entities';
    return reject(doc, command, 'EXPORT2D_NO_ENTITIES', why);
  }
  return { items, skipped, entityIds, dimensions };
}

/** True when `planDraftExport` returned a refusal rather than a plan. */
export const isRefusal = (plan: DraftPlan | CommandResult): plan is CommandResult => 'document' in plan;

/** ` Skipped N 2D entit(y|ies): id (REASON), …` for a summary, empty when nothing was skipped. */
export function skippedNote(skipped: readonly DraftSkip[]): string {
  return skipped.length === 0
    ? ''
    : ` Skipped ${skipped.length} 2D entit${skipped.length === 1 ? 'y' : 'ies'}: ${skipped.map((s) => `${s.id} (${s.reason})`).join(', ')}.`;
}
