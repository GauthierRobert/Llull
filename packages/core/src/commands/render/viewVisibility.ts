/**
 * What a render shows (plant 09 VIS-M4 §4 `visibleEntityIds`): the entities that survive viewpoint visibility, profile `hidden` rules, the
 * section box and the view frustum, plus the render sample budget (`VIS_RENDER_BUDGET`). Pure.
 * @invariant an entity is visible only if every stage keeps it; the section box hides an entity only when its AABB is wholly on the removed side
 */

import type { CadDocument } from '../../model/types';
import type { SectionBox } from '../../model/review';
import { entityBoundsInDoc } from '../../geometry/bounds';
import { classifyAgainstSection } from '../../geometry/sectionBox';
import { boxInsideAllPlanes } from '../../geometry/renderPlan';
import { frustumPlanes, type FrustumPlane } from '../../geometry/renderPlanCamera';
import { cross3, normalize3, sub3 } from '../../lib/vec3';
import { orderedEntities } from '../entity/entityOps';
import type { Camera } from './camera';
import { supersampleFor } from './rasterScene';

/** Entity ids `data.visibleEntityIds` lists; `visibleEntityCount` always gives the full count. */
export const MAX_LISTED_VISIBLE = 500;
/** Output pixels × supersample² above which a render is refused (`VIS_RENDER_BUDGET`, spec §5.6: 1920 × 1080 × 4 = 8.3 M). */
export const MAX_RENDER_SAMPLES = 16_000_000;

/** Samples the reference raster of a `width` × `height` picture takes (`strip`: a turntable strip, drawn one frame at a time, counts its pixels once). */
export function renderSamples(width: number, height: number, strip = false): number {
  const pixels = width * height;
  return strip ? pixels : pixels * supersampleFor(width, height) ** 2;
}

/** Inward frustum planes of a render camera (orthographic: `orthoHalf` is the half-extent the picture is framed with). */
export function renderFrustum(camera: Camera, orthoHalf: number, width: number, height: number): FrustumPlane[] {
  const direction = normalize3(sub3(camera.target, camera.position));
  const right = normalize3(cross3(direction, camera.up));
  const up = cross3(right, direction);
  const base = { eye: camera.position, direction, up, widthPx: width, heightPx: height };
  return frustumPlanes(
    camera.fovDeg === undefined
      ? { ...base, projection: 'orthographic', fovDeg: 0, viewHeight: (orthoHalf * height) / (Math.min(width, height) * 0.45) }
      : { ...base, projection: 'perspective', fovDeg: camera.fovDeg, viewHeight: 0 },
  );
}

/**
 * Ids of the entities in `doc` (document order) kept by the section box and the frustum.
 * @failure no box and no frustum -> every entity
 */
export function entityIdsInView(doc: CadDocument, box: SectionBox | null, frustum: readonly FrustumPlane[] | null): string[] {
  return orderedEntities(doc)
    .filter((entity) => {
      if (box === null && frustum === null) return true;
      const bounds = entityBoundsInDoc(doc, entity);
      if (box !== null && classifyAgainstSection(box, bounds) === 'outside') return false;
      return frustum === null || boxInsideAllPlanes(bounds, frustum);
    })
    .map((entity) => entity.id);
}
