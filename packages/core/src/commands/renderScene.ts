import type { CadDocument, Entity, Vec3 } from '../model/types';
import { ORIGIN, add3 } from '../lib/vec3';
import { computeSceneSnapshot } from './scene';
import { boundsCenter, boundsRadius } from './sceneBounds';
import type { RenderViewData, Polygon3D } from './renderTypes';
import { type ViewName, cameraForView, cameraBasis, projectPoint } from './renderCamera';
import { tessellateEntity } from './renderTessellation';
import { MAX_POLYGONS, buildSvg } from './renderSvg';
import { expandInstance } from './instanceExpansion';

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
): RenderViewData {
  const snapshot = computeSceneSnapshot(doc);
  const bounds = snapshot.bounds;

  const radius = bounds ? boundsRadius(bounds) : 5; // 5 frames an empty scene
  const cam = cameraForView(view, bounds ? boundsCenter(bounds) : ORIGIN, radius);
  const basis = cameraBasis(cam);
  const orthoHalf = radius * 1.2;

  // Tessellate in doc.order up to MAX_POLYGONS (no spread: a mesh can exceed the argument limit).
  const polygons: Polygon3D[] = [];
  collect: for (const id of doc.order) {
    const e = doc.entities[id];
    if (!e) continue;
    for (const drawable of drawableEntities(doc, e)) {
      for (const p of tessellateEntity(drawable)) {
        if (polygons.length >= MAX_POLYGONS) break collect;
        const [, , depth] = projectPoint(centroid3(p.verts), cam, basis);
        polygons.push({ ...p, depth });
      }
    }
  }

  return {
    view,
    width,
    height,
    entityCount: snapshot.entityCount,
    bounds,
    camera: cam,
    svg: buildSvg(polygons, cam, orthoHalf, width, height, view, snapshot.entityCount),
  };
}
