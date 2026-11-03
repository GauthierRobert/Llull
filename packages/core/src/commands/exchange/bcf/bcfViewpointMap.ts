/** BCF viewpoint -> review viewpoint (plant 09 VIS §6): metres to document units, camera normalisation, llull entity ids that exist in the document. */

import { normalizeViewpointCamera } from '../../../geometry/viewpointCamera';
import { fromMm } from '../../../model/units';
import type { Viewpoint, ViewpointCamera, ViewpointVisibility } from '../../../model/review';
import type { CadDocument, Vec3 } from '../../../model/types';
import { canonicalJson } from '../../../lib/canonicalJson';
import { nameUuid } from '../../../lib/nameUuid';
import type { BcfVisualization } from './bcfVisualizationRead';

/** The model invariant (|direction| = |up| = 1 ± 1e-6, |direction·up| ≤ 1e-6): a BCF camera inside it is stored as written, so a round trip keeps its digits. */
function withinTolerance({ direction, up }: ViewpointCamera): boolean {
  const length = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);
  const along = direction[0] * up[0] + direction[1] * up[1] + direction[2] * up[2];
  return Math.abs(length(direction) - 1) <= 1e-6 && Math.abs(length(up) - 1) <= 1e-6 && Math.abs(along) <= 1e-6;
}

export interface MappedViewpoint {
  readonly camera: ViewpointCamera;
  readonly selection: readonly string[];
  readonly visibility?: ViewpointVisibility;
  /** Components of the BCF viewpoint that name no entity of this document (IfcGuid only, another system, or an entity that no longer exists). */
  readonly unmapped: number;
}

/** The review viewpoint content of a BCF visualization, or why its camera is refused. */
export function mapVisualization(doc: CadDocument, visualization: BcfVisualization): MappedViewpoint | string {
  const units = (metres: number): number => fromMm(doc, metres * 1000);
  const { camera } = visualization;
  const eye: Vec3 = [units(camera.eyeM[0]), units(camera.eyeM[1]), units(camera.eyeM[2])];
  const raw: ViewpointCamera =
    camera.projection === 'perspective'
      ? { projection: 'perspective', eye, direction: [...camera.direction], up: [...camera.up], fovDeg: camera.fovDeg ?? Number.NaN }
      : {
          projection: 'orthographic',
          eye,
          direction: [...camera.direction],
          up: [...camera.up],
          viewHeight: units(camera.viewHeightM ?? Number.NaN),
        };
  const normalised = normalizeViewpointCamera(raw);
  if (typeof normalised === 'string') return normalised;
  const stored = withinTolerance(raw) ? { ...normalised, direction: raw.direction, up: raw.up } : normalised;
  const exists = (id: string): boolean => Object.hasOwn(doc.entities, id);
  const selection = [...new Set(visualization.selection.filter(exists))];
  const exceptions = [...new Set(visualization.exceptions.filter(exists))];
  const unmapped =
    visualization.unmappedComponents +
    (visualization.selection.length - visualization.selection.filter(exists).length) +
    (visualization.exceptions.length - visualization.exceptions.filter(exists).length);
  const restricted = visualization.defaultVisible === false || exceptions.length > 0;
  return {
    camera: stored,
    selection,
    ...(restricted ? { visibility: { defaultVisible: visualization.defaultVisible ?? false, exceptions } } : {}),
    unmapped,
  };
}

/** The review viewpoint `id` named `name` for mapped content (guid = name UUID of the id and camera, as save_viewpoint). */
export function viewpointOf(id: string, name: string, mapped: MappedViewpoint): Viewpoint {
  return {
    id,
    guid: nameUuid(`llull-viewpoint|${id}|${canonicalJson(mapped.camera)}`),
    name,
    camera: mapped.camera,
    ...(mapped.selection.length > 0 ? { selection: mapped.selection } : {}),
    ...(mapped.visibility === undefined ? {} : { visibility: mapped.visibility }),
  };
}
