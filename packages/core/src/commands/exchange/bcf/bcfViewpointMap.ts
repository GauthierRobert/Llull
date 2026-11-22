/** BCF viewpoint -> review viewpoint (plant 09 VIS §6): metres to document units, camera normalisation, llull entity ids that exist in the document. */

import { normalizeViewpointCamera } from '../../../geometry/viewpointCamera';
import { fromMm } from '../../../model/units';
import type { Viewpoint, ViewpointCamera, ViewpointVisibility } from '../../../model/review';
import type { CadDocument, Vec3 } from '../../../model/types';
import { canonicalJson } from '../../../lib/canonicalJson';
import { nameUuid } from '../../../lib/nameUuid';
import { documentProjection } from '../../../plugins/host';
import type { BcfComponentRef, BcfVisualization } from './bcfVisualizationRead';

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
  /** IfcGuid values (no / unknown llull id) that no entity of this document resolves to, in file order, unique. */
  readonly unresolvedGuids: readonly string[];
  /** Components with a well-formed IfcGuid that resolved to no entity (all of them; `unresolvedGuids` lists at most MAX_LISTED_GUIDS). */
  readonly unresolvedCount: number;
}

/** Most unresolved IfcGuid values listed in a result (summary, warning, data). */
export const MAX_LISTED_GUIDS = 100;

interface ResolvedRefs {
  readonly ids: readonly string[];
  readonly unmapped: number;
  readonly unresolvedGuids: readonly string[];
  readonly unresolvedCount: number;
}

/**
 * Entities of the components: the llull id when the document has it, else the entities `entitiesOfIfcGuid` (the export_ifc GlobalId derivation) finds
 * for the IfcGuid. A component that resolves to nothing is counted and its IfcGuid, when it has one, is listed.
 */
function resolveRefs(doc: CadDocument, refs: readonly BcfComponentRef[]): ResolvedRefs {
  const byGuid = documentProjection('entitiesOfIfcGuid');
  const ids = new Set<string>();
  const unresolved: string[] = [];
  let unmapped = 0;
  let unresolvedCount = 0;
  for (const ref of refs) {
    if (ref.id !== undefined && Object.hasOwn(doc.entities, ref.id)) {
      ids.add(ref.id);
      continue;
    }
    const found = ref.ifcGuid === undefined ? [] : (byGuid?.(doc, ref.ifcGuid) ?? []).filter((id) => Object.hasOwn(doc.entities, id));
    for (const id of found) ids.add(id);
    if (found.length > 0) continue;
    unmapped += 1;
    if (ref.ifcGuid === undefined) continue;
    unresolvedCount += 1;
    if (unresolved.length < MAX_LISTED_GUIDS && !unresolved.includes(ref.ifcGuid)) unresolved.push(ref.ifcGuid);
  }
  return { ids: [...ids], unmapped, unresolvedGuids: unresolved, unresolvedCount };
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
  const resolved = { selection: resolveRefs(doc, visualization.selectionRefs), exceptions: resolveRefs(doc, visualization.exceptionRefs) };
  const { selection, exceptions } = { selection: resolved.selection.ids, exceptions: resolved.exceptions.ids };
  const unmapped = resolved.selection.unmapped + resolved.exceptions.unmapped;
  const unresolvedGuids = [...new Set([...resolved.selection.unresolvedGuids, ...resolved.exceptions.unresolvedGuids])].slice(
    0,
    MAX_LISTED_GUIDS,
  );
  const unresolvedCount = resolved.selection.unresolvedCount + resolved.exceptions.unresolvedCount;
  const restricted = visualization.defaultVisible === false || exceptions.length > 0;
  return {
    camera: stored,
    selection,
    ...(restricted ? { visibility: { defaultVisible: visualization.defaultVisible ?? false, exceptions } } : {}),
    unmapped,
    unresolvedGuids,
    unresolvedCount,
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
