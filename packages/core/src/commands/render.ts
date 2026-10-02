/**
 * render_view — pure SVG renderer for the "AI vision loop".
 *
 * Renders the document to a self-contained SVG string using pure math and string
 * building. No three.js, no DOM, no React. The document coordinate convention is
 * Z-up throughout: +X right, +Y forward, +Z up. This matches the model/types.ts
 * entity contracts (box, cone, pyramid, wedge, extrusion are all Z-up).
 *
 * NOTE on cylinder: scene.ts entityBounds uses Y-axis (three.js CylinderGeometry
 * convention). The tessellation here uses Z-axis (Z-up, matching the model). The
 * bounds used for framing come from computeSceneSnapshot which uses scene.ts
 * entityBounds — the slight inconsistency only affects framing; rendering is
 * Z-up throughout.
 *
 * @command render_view
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.svg is a complete <svg> document; document === input doc
 * @failure invalid params are clamped; empty doc returns a valid empty SVG
 */

import type { CadDocument, Entity, Vec3 } from '../model/types';
import type { CommandResult } from './types';
import { defineCommand, z } from './schema';
import { computeSceneSnapshot } from './scene';
import { type RenderViewData, type PreDepthPolygon, type Polygon3D } from './renderTypes';
import { centroid3, applyRotation } from './renderMath';
import {
  type ViewName,
  VALID_VIEWS,
  cameraForView,
  cameraBasis,
  projectPoint,
} from './renderCamera';
import {
  tessellateBox,
  tessellateCylinder,
  tessellateSphere,
  tessellateCone,
  tessellateTorus,
  tessellateWedge,
  tessellatePyramid,
  tessellateRevolution,
  tessellateExtrusion,
  tessellateMesh,
} from './renderTessellation3D';
import {
  tessellate2DLine,
  tessellate2DPolyline,
  tessellate2DArc,
  tessellate2DCircle,
  tessellate2DRectangle,
  tessellate2DEllipse,
  tessellate2DSpline,
  tessellate2DPoint,
} from './renderTessellation2D';
import { MAX_POLYGONS, buildSvg } from './renderSvg';

export { applyEulerXYZ } from '../lib/eulerRotation';

export type { RenderViewData } from './renderTypes';

// ---------------------------------------------------------------------------
// Dispatch tessellation by entity kind
// ---------------------------------------------------------------------------

function tessellateEntity(e: Entity): PreDepthPolygon[] {
  switch (e.kind) {
    // 3D solids — apply entity rotation (three.js intrinsic XYZ Euler order)
    case 'box':
      return applyRotation(tessellateBox(e), e.position, e.rotation);
    case 'cylinder':
      return applyRotation(tessellateCylinder(e), e.position, e.rotation);
    case 'sphere':
      return applyRotation(tessellateSphere(e), e.position, e.rotation);
    case 'cone':
      return applyRotation(tessellateCone(e), e.position, e.rotation);
    case 'torus':
      return applyRotation(tessellateTorus(e), e.position, e.rotation);
    case 'wedge':
      return applyRotation(tessellateWedge(e), e.position, e.rotation);
    case 'pyramid':
      return applyRotation(tessellatePyramid(e), e.position, e.rotation);
    case 'extrusion':
      return applyRotation(tessellateExtrusion(e), e.position, e.rotation);
    case 'revolution':
      return applyRotation(tessellateRevolution(e), e.position, e.rotation);
    case 'mesh':
      return applyRotation(tessellateMesh(e), e.position, e.rotation);
    // 2D shapes — rotation not applied here (2D plane orientation is out of scope)
    case 'line':
      return tessellate2DLine(e);
    case 'polyline':
      return tessellate2DPolyline(e);
    case 'arc':
      return tessellate2DArc(e);
    case 'circle':
      return tessellate2DCircle(e);
    case 'rectangle':
      return tessellate2DRectangle(e);
    case 'point':
      return tessellate2DPoint(e);
    case 'ellipse':
      return tessellate2DEllipse(e);
    case 'spline':
      return tessellate2DSpline(e);
    case 'text':
      return []; // not drawn in render_view SVG; the viewport renders text
    case 'dimension':
      return []; // not drawn in render_view SVG; the viewport renders dimensions
    case 'instance':
      return []; // expanded form not yet tessellated; use explode_instance to export
    default: {
      const exhaustive: never = e;
      void exhaustive;
      return [];
    }
  }
}

// ---------------------------------------------------------------------------
// Main render function
// ---------------------------------------------------------------------------

function renderDocument(
  doc: CadDocument,
  view: ViewName,
  width: number,
  height: number,
): RenderViewData {
  const snapshot = computeSceneSnapshot(doc);
  const bounds = snapshot.bounds;

  // Compute scene radius and center
  let center: Vec3 = [0, 0, 0];
  let radius = 5; // default for empty scene

  if (bounds) {
    center = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2,
    ];
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    radius = Math.max(dx, dy, dz) / 2 + 1e-3;
    if (radius < 0.1) radius = 1;
  }

  const cam = cameraForView(view, center, radius);
  const basis = cameraBasis(cam);
  const orthoHalf = (cam.ortho ?? radius) * 1.2;

  // Collect and tessellate all entities (stable order = doc.order)
  const rawPolys: PreDepthPolygon[] = [];
  for (const id of doc.order) {
    const e = doc.entities[id];
    if (!e) continue;
    const tess = tessellateEntity(e);
    for (const p of tess) {
      rawPolys.push(p);
    }
  }

  // Cap polygon count
  const capped = rawPolys.length > MAX_POLYGONS ? rawPolys.slice(0, MAX_POLYGONS) : rawPolys;

  // Project depth and shade
  const polygons: Polygon3D[] = capped.map((p) => {
    const c = centroid3(p.verts);
    const [, , depth] = projectPoint(c, cam, basis);
    return { ...p, depth };
  });

  const svg = buildSvg(polygons, cam, basis, orthoHalf, width, height, view, snapshot.entityCount);

  return {
    view,
    width,
    height,
    entityCount: snapshot.entityCount,
    bounds,
    camera: {
      position: [...cam.position] as [number, number, number],
      target: [...cam.target] as [number, number, number],
      up: [...cam.up] as [number, number, number],
    },
    svg,
  };
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

/**
 * @command render_view
 * @pure
 * @layer core/commands
 * @affects nothing — read-only; document returned unchanged, affected:[]
 * @invariant data.svg is a self-contained <svg> string; document === input doc (referential equality)
 * @failure unknown view name -> fallback to 'iso'; width/height clamped to [64, 2000]
 */
export const renderView = defineCommand({
  name: 'render_view',
  annotations: { readOnly: true },
  description:
    'Render the document to a self-contained SVG image string so an AI agent can SEE the scene and self-correct. ' +
    'Returns the unchanged document plus a `data` object containing: `svg` (complete SVG string), ' +
    '`view` (resolved view name), `width`, `height`, `entityCount`, `bounds` (world AABB or null), ' +
    'and `camera` ({position, target, up}). ' +
    'Choose `view` to orient the render: "iso" (default isometric), "top", "bottom", "front", "back", ' +
    '"left", or "right" (all orthographic). ' +
    'Adjust `width`/`height` (pixels, clamped to [64, 2000], default 800×600) for resolution. ' +
    'The SVG uses flat Lambertian shading on 3D solids and stroked paths for 2D shapes. ' +
    'Does NOT modify the document; `affected` is always [].',
  params: z.object({
    view: z
      .enum(['top', 'bottom', 'front', 'back', 'left', 'right', 'iso'])
      .optional()
      .describe(
        'Camera direction. One of: "iso" (isometric — default, good for orienting in 3D), ' +
          '"top" (looking down the +Z axis), "bottom" (looking up the -Z axis), ' +
          '"front" (looking along the +Y axis), "back" (looking along the -Y axis), ' +
          '"left" (looking along the +X axis), "right" (looking along the -X axis). ' +
          'Omit for the default "iso" view.',
      ),
    width: z
      .number()
      .optional()
      .describe('Output image width in pixels. Clamped to [64, 2000]. Default: 800.'),
    height: z
      .number()
      .optional()
      .describe('Output image height in pixels. Clamped to [64, 2000]. Default: 600.'),
  }),
  run: (doc, params): CommandResult => {
    const rawParams = params;

    // Resolve view
    const rawView = rawParams.view ?? 'iso';
    const view: ViewName = VALID_VIEWS.has(rawView) ? (rawView as ViewName) : 'iso';

    // Clamp dimensions
    const width = Math.max(64, Math.min(2000, Math.round(rawParams.width ?? 800)));
    const height = Math.max(64, Math.min(2000, Math.round(rawParams.height ?? 600)));

    const data = renderDocument(doc, view, width, height);

    return {
      document: doc,
      summary: `Rendered ${view} view: ${data.entityCount} entit${data.entityCount === 1 ? 'y' : 'ies'}, ${width}×${height}.`,
      affected: [],
      data,
    };
  },
});
