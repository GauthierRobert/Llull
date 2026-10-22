/**
 * Sketch entities as chart outlines for the face commands of 03 WRP: closed shapes become regions (an outer loop and holes), open curves stay chains, a text
 * with a font becomes the regions of its glyph outlines. Coordinates are the entity's plane coordinates (document units), the frame the chart is placed in.
 */

import type { CadDocument, Entity, Vec2, Vec3 } from '../../model/types';
import { inverseEulerXYZ } from '../../lib/eulerRotation';
import { JOINT_TOLERANCE } from '../../geometry/curveSegments';
import {
  mapSegment2,
  segmentArea,
  segmentEnd,
  segmentLength,
  segmentOfCurve,
  segmentOfOutline,
  segmentStart,
  type PlaneSegment,
} from '../../geometry/planeSegments';
import { outlineErrorCode, textOutline } from '../../geometry/textOutline';
import { planeToWorld } from '../../geometry/workPlane';
import { entityCurves } from '../solids/sketchCurves';
import { isFontFailure, loadFont } from './fontStore';

export interface ChartRegion {
  readonly outer: readonly PlaneSegment[];
  readonly holes: ReadonlyArray<readonly PlaneSegment[]>;
}

export interface SketchOutline {
  readonly id: string;
  readonly kind: Entity['kind'];
  readonly regions: readonly ChartRegion[];
  readonly open: ReadonlyArray<readonly PlaneSegment[]>;
  /** Area of the regions (outer minus holes), document units squared. */
  readonly area: number;
  /** The font bytes behind a text are not pinned. */
  readonly unverified: boolean;
  readonly font: { readonly family: string; readonly sha256: string } | null;
  /** Overlapping glyph contours were united on polygons. */
  readonly united: boolean;
  readonly missingCharacters: readonly string[];
  /** World point of a plane coordinate of this outline (the entity's work plane). */
  readonly toWorld: (point: Vec2) => Vec3;
}

export interface SketchFailure {
  readonly code: string;
  readonly message: string;
}

export const isSketchFailure = (value: SketchOutline | SketchFailure): value is SketchFailure => 'code' in value;

/** Most segments one entity may contribute (a long text); a limit, not a rounding. */
export const MAX_OUTLINE_SEGMENTS = 100_000;

const loopArea = (loop: readonly PlaneSegment[]): number => loop.reduce((sum, segment) => sum + segmentArea(segment), 0);

const closes = (chain: readonly PlaneSegment[]): boolean => {
  const first = chain[0];
  const last = chain[chain.length - 1];
  if (first === undefined || last === undefined) return false;
  const [a, b] = [segmentStart(first), segmentEnd(last)];
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= JOINT_TOLERANCE;
};

/** The entity's plane coordinates: its local frame plus the entity position expressed in its own plane. */
function planeShift(entity: Entity): Vec2 {
  const [x, y] = inverseEulerXYZ(entity.position, entity.rotation);
  return [x, y];
}

function worldMap(entity: Entity): (point: Vec2) => Vec3 {
  const [dx, dy] = planeShift(entity);
  return (point) => planeToWorld(entity.position, entity.rotation, [point[0] - dx, point[1] - dy]);
}

function textOutlineOf(doc: CadDocument, entity: Extract<Entity, { kind: 'text' }>): SketchOutline | SketchFailure {
  if (entity.font === undefined) return { code: 'WRP_TEXT_NO_FONT', message: `text '${entity.id}' has no font, so it has no outline` };
  const loaded = loadFont(doc, entity.font);
  if (isFontFailure(loaded)) return { code: loaded.code, message: loaded.message };
  const outline = textOutline(entity, loaded.font);
  if ('error' in outline) return { code: outlineErrorCode(outline.error), message: outline.message };
  const [dx, dy] = planeShift(entity);
  const shift = (point: Vec2): Vec2 => [point[0] + dx, point[1] + dy];
  const chain = (loop: readonly Parameters<typeof segmentOfOutline>[0][]): PlaneSegment[] =>
    loop.map((segment) => mapSegment2(segmentOfOutline(segment), shift));
  const regions: ChartRegion[] = outline.regions.map((region) => ({ outer: chain(region.outer), holes: region.holes.map(chain) }));
  if (
    regions.reduce((sum, region) => sum + region.outer.length + region.holes.reduce((n, hole) => n + hole.length, 0), 0) >
    MAX_OUTLINE_SEGMENTS
  )
    return { code: 'WRP_TEXT_TOO_LONG', message: `the outline of '${entity.id}' has more than ${MAX_OUTLINE_SEGMENTS} segments` };
  return {
    id: entity.id,
    kind: 'text',
    regions,
    open: [],
    area: outline.area,
    unverified: !loaded.record.provenance.verified,
    font: { family: loaded.record.family, sha256: loaded.record.blob },
    united: outline.united,
    missingCharacters: outline.layout.missing,
    toWorld: worldMap(entity),
  };
}

/**
 * The outline of one sketch entity in plane coordinates.
 * @failure unknown id, an entity that is no 2D curve, a text without font or a lost font -> `{ code, message }`
 */
export function sketchOutline(doc: CadDocument, id: string): SketchOutline | SketchFailure {
  const entity = doc.entities[id];
  if (entity === undefined) return { code: 'WRP_ENTITY_NOT_FOUND', message: `entity '${id}' not found` };
  if (entity.kind === 'text') return textOutlineOf(doc, entity);
  const own = entityCurves(entity);
  if (own === null)
    return { code: 'WRP_PROFILE_EMPTY', message: `entity '${id}' (${entity.kind}) is not a 2D curve or a text with a font` };
  const [dx, dy] = planeShift(entity);
  const shift = (point: Vec2): Vec2 => [point[0] + dx, point[1] + dy];
  const chain = own.curves.map((segment) => mapSegment2(segmentOfCurve(segment), shift));
  if (chain.reduce((sum, segment) => sum + segmentLength(segment), 0) < 1e-12)
    return { code: 'WRP_PROFILE_EMPTY', message: `entity '${id}' has no length` };
  const closed = own.closed || closes(chain);
  const base = {
    id,
    kind: entity.kind,
    unverified: false,
    font: null,
    united: false,
    missingCharacters: [] as string[],
    toWorld: worldMap(entity),
  };
  if (!closed) return { ...base, regions: [], open: [chain], area: 0 };
  return { ...base, regions: [{ outer: chain, holes: [] }], open: [], area: Math.abs(loopArea(chain)) };
}
