/**
 * render_stats (plant 09 VIS-M3a, TR-VIS-20): the draw-call, culling and LOD numbers of the R-BATCH-v1 render plan for one camera. The viewport
 * builds the same plan (`@core/geometry/renderPlan`), so these are the numbers it draws.
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { defineCommand, looseVec3, z } from '@core/commands/schema';
import { codedRejection, report } from '@core/commands/noop';
import { boundsCenter, boundsRadius, mergeBounds, type Bounds } from '@core/geometry/bounds';
import { type PlanCamera, framedPlanCamera, planCameraProblem, viewpointPlanCamera } from '@core/geometry/renderPlanCamera';
import { type PlanScene, compareCodepoint, planRender } from '@core/geometry/renderPlan';
import { planSceneOf } from '@core/geometry/planSceneCache';

/** Buckets listed in `data.buckets`, largest first; `bucketCount` is the full number. */
const MAX_LISTED_BUCKETS = 200;
const MAX_IMAGE_PX = 16384;
const VIEWS = ['top', 'bottom', 'front', 'back', 'left', 'right', 'iso', 'custom'] as const;

const REMEDIATION: Readonly<Record<string, string>> = {
  VIS_VIEWPOINT_NOT_FOUND: 'list_viewpoints shows the saved viewpoints; save_viewpoint creates one',
  VIS_CAMERA_INVALID: 'give fovDeg in (0, 180) and, for view "custom", a finite non-zero direction',
};

const cameraOf = (
  doc: CadDocument,
  scene: PlanScene,
  params: RenderStatsParams,
): PlanCamera | { code: string; message: string; path: string } => {
  const { width, height } = params;
  if (params.viewpointId !== undefined) {
    const viewpoint = Object.hasOwn(doc.review?.viewpoints ?? {}, params.viewpointId)
      ? doc.review?.viewpoints[params.viewpointId]
      : undefined;
    if (viewpoint === undefined)
      return { code: 'VIS_VIEWPOINT_NOT_FOUND', message: `no viewpoint '${params.viewpointId}'`, path: 'viewpointId' };
    const fromViewpoint = viewpointPlanCamera(viewpoint.camera, width, height);
    const problem = planCameraProblem(fromViewpoint);
    return problem === null
      ? fromViewpoint
      : { code: 'VIS_CAMERA_INVALID', message: `viewpoint '${params.viewpointId}': ${problem}`, path: 'viewpointId' };
  }
  for (const field of ['target', 'direction'] as const) {
    const value = params[field];
    if (value !== undefined && !(Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)))
      return { code: 'VIS_CAMERA_INVALID', message: `${field} must be 3 finite numbers [x, y, z]`, path: field };
  }
  const bounds = scene.instances.reduce<Bounds | null>(
    (sum, instance) => (sum === null ? instance.aabb : mergeBounds(sum, instance.aabb)),
    null,
  );
  const framed = framedPlanCamera({
    view: params.view ?? 'iso',
    direction: params.direction,
    projection: params.projection ?? 'orthographic',
    fovDeg: params.fovDeg,
    center: params.target ?? (bounds === null ? [0, 0, 0] : boundsCenter(bounds)),
    radius: bounds === null ? 5 : boundsRadius(bounds),
    widthPx: width,
    heightPx: height,
  });
  if (typeof framed === 'string') return { code: 'VIS_CAMERA_INVALID', message: framed, path: 'view' };
  const problem = planCameraProblem(framed);
  return problem === null ? framed : { code: 'VIS_CAMERA_INVALID', message: problem, path: 'view' };
};

interface RenderStatsParams {
  readonly viewpointId?: string | undefined;
  readonly view?: (typeof VIEWS)[number] | undefined;
  readonly direction?: Vec3 | undefined;
  readonly target?: Vec3 | undefined;
  readonly projection?: 'orthographic' | 'perspective' | undefined;
  readonly fovDeg?: number | undefined;
  readonly width: number;
  readonly height: number;
  readonly quality?: 'high' | 'medium' | 'low' | undefined;
  readonly multiDraw?: boolean | undefined;
}

/**
 * @affects nothing — read-only; data { componentCount, buckets[{ prototypeKey, materialClass, lod, instances }], bucketCount, uniqueBatches[], opaqueModelCalls,
 *   edgeCalls, shadowCalls, culled{ frustum, pixel }, instancesDrawnPlusCulled, triangles, gpuBytesEstimate, planVersion }
 * @invariant a pure function of document + camera; instancesDrawnPlusCulled = componentCount; opaqueModelCalls ≤ 2·(distinct prototype × material-class pairs) + C + U with multi-draw
 *   (= 2P + C + U when each prototype has one material class, as in SYN-RACK-v1)
 * @failure unknown viewpointId -> VIS_VIEWPOINT_NOT_FOUND; fovDeg outside (0, 180) or a zero custom direction -> VIS_CAMERA_INVALID
 */
export const renderStats = defineCommand({
  name: 'render_stats',
  description:
    'Count what the 3D viewport draws for one camera, with the same batching / LOD / culling plan the viewport uses (rule R-BATCH-v1, LOD thresholds lod:llull-v1). ' +
    'Camera: viewpointId (a saved viewpoint wins over the other camera fields) or view (top|bottom|front|back|left|right|iso|custom, default iso; custom needs direction) ' +
    'framed on the scene (or on target), projection orthographic (default) or perspective with fovDeg (default 45). width / height are the image size in pixels. ' +
    'Visible 3D entities are the instances; identical shapes (kind + parameters) share a prototype and one InstancedMesh per (prototype, material class, LOD) bucket; ' +
    'LOD2 boxes merge per material class; single-instance prototypes are batched per material class. LOD by projected bounding-box diagonal: >= 48 px LOD0, >= 8 px LOD1, ' +
    '>= 1 px LOD2 box, smaller culled; instances outside the view volume are frustum-culled. Material class = the entity materialId (else "unassigned"). ' +
    'data { componentCount, buckets[{ prototypeKey, materialClass, lod, instances }] (largest 200 of bucketCount), uniqueBatches, opaqueModelCalls (≤ 2 x distinct prototype-and-material-class pairs + material classes + unique-geometry classes; with multiDraw true, the default, ' +
    'one call per unique-geometry material class; false: one per unique instance), edgeCalls, shadowCalls (3 / 2 cascades for quality high / medium, 0 low), ' +
    'culled { frustum, pixel }, instancesDrawnPlusCulled (= componentCount), triangles (LOD1 / box counts are estimates), gpuBytesEstimate, planVersion }. ' +
    'Read-only. Errors: VIS_VIEWPOINT_NOT_FOUND, VIS_CAMERA_INVALID.',
  annotations: { readOnly: true },
  params: z.object({
    viewpointId: z
      .string()
      .optional()
      .describe('Id of a saved viewpoint (save_viewpoint); its camera replaces view / direction / projection / fovDeg.'),
    view: z.enum(VIEWS).optional().describe('Named view framed on the scene. Default "iso". "custom" uses direction.'),
    direction: looseVec3('Custom view only: [x, y, z] from the target toward the eye (non-zero, finite).').optional(),
    target: looseVec3('Point the view is framed on [x, y, z]. Default: the centre of the scene bounds.').optional(),
    projection: z.enum(['orthographic', 'perspective']).optional().describe('"orthographic" (default) or "perspective".'),
    fovDeg: z.number().optional().describe('Perspective vertical field of view in degrees, in (0, 180). Default 45.'),
    width: z.number().int().min(1).max(MAX_IMAGE_PX).describe('Image width in pixels (1..16384).'),
    height: z.number().int().min(1).max(MAX_IMAGE_PX).describe('Image height in pixels (1..16384); the LOD metric uses it.'),
    quality: z.enum(['high', 'medium', 'low']).optional().describe('Viewport tier for edgeCalls / shadowCalls. Default "high".'),
    multiDraw: z
      .boolean()
      .optional()
      .describe('Count unique-geometry batches with WEBGL_multi_draw (one call per material class). Default true.'),
  }),
  run: (doc, params): CommandResult => {
    const { scene, query } = planSceneOf(doc);
    const camera = cameraOf(doc, scene, params);
    if ('code' in camera)
      return codedRejection(doc, 'render_stats', camera.code, camera.message, REMEDIATION[camera.code] ?? '', [], [camera.path]);
    const plan = planRender(scene, camera, {
      multiDraw: params.multiDraw ?? true,
      quality: params.quality ?? 'high',
      ...(query !== undefined ? { query } : {}),
    });
    const buckets = plan.buckets
      .map(({ prototypeKey, materialClass, lod, instances }) => ({ prototypeKey, materialClass, lod, instances }))
      .sort(
        (a, b) =>
          b.instances - a.instances ||
          compareCodepoint(a.prototypeKey, b.prototypeKey) ||
          compareCodepoint(a.materialClass, b.materialClass) ||
          a.lod - b.lod,
      )
      .slice(0, MAX_LISTED_BUCKETS);
    const uniqueBatches = plan.uniqueBatches.map(({ materialClass, members }) => ({ materialClass, instances: members.length }));
    const instancesDrawnPlusCulled = plan.drawn + plan.culled.frustum + plan.culled.pixel;
    return report(
      doc,
      `render_stats (${camera.projection}, ${camera.widthPx}x${camera.heightPx}): ${plan.componentCount} instance(s), ${scene.prototypeKeys.length} prototype(s), ` +
        `${plan.opaqueModelCalls} opaque model call(s) (${plan.buckets.length} bucket(s), ${uniqueBatches.length} unique batch(es)); drawn ${plan.drawn}, ` +
        `culled ${plan.culled.frustum} by frustum and ${plan.culled.pixel} by size; ${plan.triangles} triangle(s).`,
      {
        componentCount: plan.componentCount,
        prototypeCount: scene.prototypeKeys.length,
        buckets,
        bucketCount: plan.buckets.length,
        uniqueBatches,
        opaqueModelCalls: plan.opaqueModelCalls,
        edgeCalls: plan.edgeCalls,
        shadowCalls: plan.shadowCalls,
        culled: plan.culled,
        instancesDrawnPlusCulled,
        triangles: plan.triangles,
        gpuBytesEstimate: plan.gpuBytesEstimate,
        planVersion: plan.planVersion,
        multiDraw: params.multiDraw ?? true,
        quality: params.quality ?? 'high',
        projection: camera.projection,
        ...(params.viewpointId !== undefined ? { viewpointId: params.viewpointId } : {}),
      },
    );
  },
});
