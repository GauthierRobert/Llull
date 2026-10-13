/**
 * Technical (ISO 128) orthographic view of 3D solids as drawing primitives: thick visible edges, thin dashed hidden edges, chain centre
 * lines and — under a section plane — the cut faces outlined thick and hatched at 45° (hidden edges are omitted from a section view, per
 * ISO 128-50). The 2D viewport and the DXF export draw solids through this one function.
 */

import { type CadDocument, type Entity, type EntityId, type Vec2, is3D } from '../model/types';
import type { DrawingPrimitive } from '../model/drawing';
import { polygonArea, pointInPolygon } from '../lib/polygon';
import { centerLinePrimitives } from './centerLines';
import { entityToTriangles } from './entityTriangles';
import { classifyEdges, type ViewSource } from './hiddenLines';
import { chainLoops } from './planeEdges';
import { expansionDependency } from './instanceExpansion';
import { quantizedKey } from '../lib/quantize';
import {
  type Face,
  type FeatureEdge,
  type Segment2,
  type ViewFrame,
  cutSegments,
  facesOf,
  featureEdges,
  weldTolerance,
} from './viewProjection';

/** DXF / CAD layers of a technical view, one per line type. */
export const TECHNICAL_LAYERS = { visible: 'OBJ-VISIBLE', hidden: 'OBJ-HIDDEN', center: 'OBJ-CENTER', cut: 'OBJ-CUT' } as const;

export interface EntityDrawing {
  readonly entityId: EntityId;
  readonly primitives: DrawingPrimitive[];
}

interface TechnicalViewOptions {
  readonly frame: ViewFrame;
  /** Section plane depth (toward the viewer); material in front of it is removed. */
  readonly cutDepth?: number | undefined;
}

/** Even-odd loops grouped into outer boundaries, each with the holes directly inside it. */
function nestLoops(loops: ReadonlyArray<Vec2[]>): Array<{ outer: Vec2[]; holes: Vec2[][] }> {
  const containers = loops.map((loop, index) => loops.filter((other, j) => j !== index && pointInPolygon(loop[0] as Vec2, other)));
  const regions = loops.flatMap((outer, index) =>
    (containers[index] as Vec2[][]).length % 2 === 0 ? [{ outer, holes: [] as Vec2[][] }] : [],
  );
  loops.forEach((loop, index) => {
    const inside = containers[index] as Vec2[][];
    if (inside.length % 2 === 0) return;
    const parent = regions.filter((region) => inside.includes(region.outer)).sort((a, b) => polygonArea(a.outer) - polygonArea(b.outer))[0];
    parent?.holes.push(loop);
  });
  return regions;
}

const segmentKey = ([a, b]: Segment2, tolerance: number): string => {
  const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
  return quantizedKey([...p, ...q], tolerance);
};

/** A solid's faces and feature edges as seen through one frame (independent of other solids). */
interface SolidFaces {
  readonly faces: Face[];
  readonly edges: FeatureEdge[];
  readonly tolerance: number;
  /** `expansionDependency` when cached (a cache entry is stale once it changes). */
  readonly dependency: unknown;
}

/** Per frame, per entity object: entities are immutable, so an edit yields a new key. */
const facesCache = new WeakMap<ViewFrame, WeakMap<Entity, SolidFaces>>();

function solidFaces(doc: Pick<CadDocument, 'components'>, entity: Entity, frame: ViewFrame): SolidFaces {
  const dependency = expansionDependency(entity, doc);
  const byEntity = facesCache.get(frame) ?? new WeakMap<Entity, SolidFaces>();
  facesCache.set(frame, byEntity);
  const cached = byEntity.get(entity);
  if (cached && cached.dependency === dependency) return cached;
  const faces = facesOf(entityToTriangles(entity, doc), frame);
  const tolerance = weldTolerance(faces);
  const entry = { faces, edges: featureEdges(faces, tolerance), tolerance, dependency };
  byEntity.set(entity, entry);
  return entry;
}

/** Line primitives of `segments`, skipping any already drawn (coincident edges, e.g. a box's top and bottom). */
function lines(segments: ReadonlyArray<Segment2>, style: 'visible' | 'hidden', drawn: Set<string>, tolerance: number): DrawingPrimitive[] {
  const layer = TECHNICAL_LAYERS[style];
  const primitives: DrawingPrimitive[] = [];
  for (const segment of segments) {
    const key = segmentKey(segment, tolerance);
    if (drawn.has(key)) continue;
    drawn.add(key);
    primitives.push({ type: 'line', layer, style, a: segment[0], b: segment[1] });
  }
  return primitives;
}

/**
 * The technical view of `entities` (3D solids; anything else is skipped) through `frame`. Edges are hidden by every solid of the set, not
 * only their own.
 * @returns one drawing per solid that produced any primitive, in input order
 */
export function technicalView(
  doc: Pick<CadDocument, 'components'>,
  entities: ReadonlyArray<Entity>,
  { frame, cutDepth = Infinity }: TechnicalViewOptions,
): EntityDrawing[] {
  const solids = entities.filter(is3D);
  const cached = solids.map((entity) => solidFaces(doc, entity, frame));
  const sources: ViewSource[] = cached.map(({ faces, edges, tolerance }) => ({
    faces,
    edges,
    cutLoops: Number.isFinite(cutDepth) ? chainLoops(cutSegments(faces, frame, cutDepth), tolerance) : [],
  }));
  const runs = classifyEdges(sources, frame, cutDepth);
  const sectioned = Number.isFinite(cutDepth);
  const drawings: EntityDrawing[] = [];
  solids.forEach((entity, index) => {
    const source = sources[index] as ViewSource;
    const edgeRuns = runs[index];
    if (source.faces.length === 0 || !edgeRuns) return;
    const primitives: DrawingPrimitive[] = [];
    for (const { outer, holes } of nestLoops(source.cutLoops as Vec2[][])) {
      primitives.push({ type: 'polygon', layer: TECHNICAL_LAYERS.cut, style: 'cut', points: outer, fill: 'hatch', holes });
      for (const hole of holes) {
        // A closed outline, not a polygon: an unfilled cut polygon reads as solid poché.
        primitives.push({ type: 'polyline', layer: TECHNICAL_LAYERS.cut, style: 'cut', points: [...hole, hole[0] as Vec2] });
      }
    }
    // Visible first: a hidden run coinciding with a visible one is not drawn (visible lines win).
    const drawn = new Set<string>();
    const tolerance = (cached[index] as SolidFaces).tolerance;
    primitives.push(...lines(edgeRuns.visible, 'visible', drawn, tolerance));
    if (!sectioned) primitives.push(...lines(edgeRuns.hidden, 'hidden', drawn, tolerance));
    primitives.push(...centerLinePrimitives(entity, doc, frame, TECHNICAL_LAYERS.center, cutDepth));
    if (primitives.length > 0) drawings.push({ entityId: entity.id, primitives });
  });
  return drawings;
}
