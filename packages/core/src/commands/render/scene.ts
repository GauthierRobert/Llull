import type { CadDocument, Entity, ImageEntity } from '../../model/types';
import { ORIGIN, centroid3 } from '../../lib/vec3';
import { computeSceneSnapshot } from '../inspect/scene';
import { boundsCenter, boundsRadius } from '../../geometry/bounds';
import type { PreDepthPolygon, Polygon3D, RenderOptions, RenderViewData } from './types';
import { type ViewName, cameraForView, cameraBasis, projectPoint } from './camera';
import { tessellateEntity } from './polygons';
import { DEFAULT_BACKGROUND, buildSvg } from './svg';
import { MAX_POLYGONS, applyBudget, type EntityPolygons } from './budget';
import { cutEntityPolygons, unitPlanes } from './clip';
import { splitForDepth } from './depthSplit';
import { expandInstance } from '../../geometry/instanceExpansion';
import { orderedEntities } from '../entity/entityOps';

/** Faces longer than this fraction of the scene radius are split before the painter's sort (see depthSplit.ts). */
const DEPTH_SPLIT_FRACTION = 0.12;
/** Face budget of a raster render (each face costs its pixels, so far more fit than in vector SVG). */
const RASTER_BUDGET = 400000;

/** Component instances nested deeper than this are not drawn (guards against reference cycles). */
const MAX_INSTANCE_DEPTH = 4;

/** `e` itself, or for an instance the baked entities of its component (recursively). */
function drawableEntities(doc: CadDocument, e: Entity, depth = 0): Entity[] {
  if (e.kind !== 'instance') return [e];
  const component = doc.components[e.componentId];
  if (!component || depth >= MAX_INSTANCE_DEPTH) return [];
  return expandInstance(e, component).flatMap((child) => drawableEntities(doc, child, depth + 1));
}

/** `e` in its assigned material's colour, as the 3D viewport shows it (the entity colour when no material is assigned). */
function withMaterialColor(doc: CadDocument, e: Entity): Entity {
  const material = e.materialId === undefined ? undefined : doc.materials[e.materialId];
  return material === undefined || material.color === e.color ? e : { ...e, color: material.color };
}

/** Z-up orthographic SVG render of every entity in `doc.order`. @pure */
export function renderDocument(
  doc: CadDocument,
  view: ViewName,
  width: number,
  height: number,
  options: RenderOptions = {},
): RenderViewData {
  const snapshot = computeSceneSnapshot(doc);
  const bounds = options.frame !== undefined ? options.frame : snapshot.bounds;
  const radius = bounds ? boundsRadius(bounds) : 5; // 5 frames an empty scene
  const center = options.target ?? (bounds ? boundsCenter(bounds) : ORIGIN);
  const cam = cameraForView(view, center, radius, options.direction);
  const basis = cameraBasis(cam);
  const orthoHalf = (radius * 1.2) / (options.zoom ?? 1);
  const budget = options.maxPolygons ?? MAX_POLYGONS;
  const cut = options.cut;
  const planes = cut ? unitPlanes(cut) : [];
  const cutIds = cut?.entityIds ? new Set(cut.entityIds) : null;
  const tolerance = Math.max(radius, 1e-6) * 1e-6;
  const cutEntityIds: string[] = [];
  const items: EntityPolygons[] = [];
  for (const e of orderedEntities(doc)) {
    const id = e.id;
    let polygons: PreDepthPolygon[] = drawableEntities(doc, e).flatMap((drawable) => tessellateEntity(withMaterialColor(doc, drawable)));
    if (cut && (cutIds === null || cutIds.has(id))) {
      const result = cutEntityPolygons(polygons, cut, planes, tolerance);
      polygons = result.polygons;
      if (result.cut) cutEntityIds.push(id);
    }
    items.push({ id, polygons: polygons.map((polygon) => ({ ...polygon, owner: id })) });
  }
  const raster = options.mode !== 'vector';
  // Rasterising costs per pixel, not per face: the budget only guards against pathological meshes there.
  const fitted = applyBudget(items, raster ? Math.max(budget, RASTER_BUDGET) : budget);
  const split = raster
    ? fitted.polygons
    : splitForDepth(fitted.polygons, radius * DEPTH_SPLIT_FRACTION, budget, (p) => {
        const [u, v] = projectPoint(p, cam, basis);
        return [u, v];
      });
  const polygons: Polygon3D[] = split.map((p) => {
    // Caps sit on the nearest face of their outline; everything else sorts by centroid.
    const depth = p.loops
      ? p.verts.reduce((nearest, v) => Math.min(nearest, projectPoint(v, cam, basis)[2]), Infinity)
      : projectPoint(centroid3(p.verts), cam, basis)[2];
    return { ...p, depth };
  });
  const background = options.background === undefined ? DEFAULT_BACKGROUND : options.background;
  // Underlays are never capped by MAX_POLYGONS: they are one <image> each, painted first.
  const underlays = orderedEntities(doc).flatMap((e) => drawableEntities(doc, e).filter((d): d is ImageEntity => d.kind === 'image'));
  return {
    view,
    width,
    height,
    entityCount: snapshot.entityCount,
    bounds,
    camera: cam,
    orthoHalf,
    polygonCount: polygons.filter((p) => !p.stroke).length,
    polygonBudget: raster ? Math.max(budget, RASTER_BUDGET) : budget,
    simplifiedEntityIds: fitted.simplifiedEntityIds,
    skippedEntityIds: fitted.skippedEntityIds,
    cutEntityIds,
    svg: buildSvg(polygons, underlays, cam, orthoHalf, width, height, view, snapshot.entityCount, background, raster ? radius : null),
  };
}
