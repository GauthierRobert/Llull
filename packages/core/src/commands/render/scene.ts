import type { CadDocument, Entity, Vec3 } from '../../model/types';
import { ORIGIN, add3 } from '../../lib/vec3';
import { computeSceneSnapshot } from '../inspect/scene';
import { boundsCenter, boundsRadius } from '../../geometry/bounds';
import type { PreDepthPolygon, Polygon3D, RenderOptions, RenderViewData } from './types';
import { type ViewName, cameraForView, cameraBasis, projectPoint } from './camera';
import { tessellateEntity } from './polygons';
import { DEFAULT_BACKGROUND, buildSvg } from './svg';
import { MAX_POLYGONS, applyBudget, type EntityPolygons } from './budget';
import { cutEntityPolygons, unitPlanes } from './clip';
import { expandInstance } from '../../geometry/instanceExpansion';

/** Component instances nested deeper than this are not drawn (guards against reference cycles). */
const MAX_INSTANCE_DEPTH = 4;

/** `e` itself, or for an instance the baked entities of its component (recursively). */
function drawableEntities(doc: CadDocument, e: Entity, depth = 0): Entity[] {
  if (e.kind !== 'instance') return [e];
  const component = doc.components[e.componentId];
  if (!component || depth >= MAX_INSTANCE_DEPTH) return [];
  return expandInstance(e, component).flatMap((child) => drawableEntities(doc, child, depth + 1));
}

function centroid3(verts: Vec3[]): Vec3 {
  if (verts.length === 0) return [0, 0, 0];
  const sum = verts.reduce((acc, v) => add3(acc, v), ORIGIN);
  return [sum[0] / verts.length, sum[1] / verts.length, sum[2] / verts.length];
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
  for (const id of doc.order) {
    const e = doc.entities[id];
    if (!e) continue;
    let polygons: PreDepthPolygon[] = drawableEntities(doc, e).flatMap(tessellateEntity);
    if (cut && (cutIds === null || cutIds.has(id))) {
      const result = cutEntityPolygons(polygons, cut, planes, tolerance);
      polygons = result.polygons;
      if (result.cut) cutEntityIds.push(id);
    }
    items.push({ id, polygons });
  }

  const fitted = applyBudget(items, budget);
  const polygons: Polygon3D[] = fitted.polygons.map((p) => {
    // Caps sit on the nearest face of their outline; everything else sorts by centroid.
    const depth = p.loops
      ? p.verts.reduce((nearest, v) => Math.min(nearest, projectPoint(v, cam, basis)[2]), Infinity)
      : projectPoint(centroid3(p.verts), cam, basis)[2];
    return { ...p, depth };
  });
  const background = options.background === undefined ? DEFAULT_BACKGROUND : options.background;

  return {
    view,
    width,
    height,
    entityCount: snapshot.entityCount,
    bounds,
    camera: cam,
    orthoHalf,
    polygonCount: polygons.filter((p) => !p.stroke).length,
    polygonBudget: budget,
    simplifiedEntityIds: fitted.simplifiedEntityIds,
    skippedEntityIds: fitted.skippedEntityIds,
    cutEntityIds,
    svg: buildSvg(polygons, cam, orthoHalf, width, height, view, snapshot.entityCount, background),
  };
}
