/**
 * Laminate of a composite shell part, read from the 06 CMP data in core (`CadDocument.composites`; the `composites` plugin of @aero is not
 * imported): the plies of a composite part, bottom (tool side) to top, with their lamina materials and rosette axes.
 */

import type { CompositePart, CompositesModel, LaminaMaterial } from '@core/model/composites';
import type { CadDocument } from '@core/model/types';
import type { Vec3 } from '@core/model/vectors';
import { normalize3, scale3 } from '@lib/vec3';

interface LaminatePly {
  readonly id: string;
  readonly name: string;
  readonly materialName: string;
  /** Cured ply thickness, document units. */
  readonly thickness: number;
  /** Degrees about the stacking normal from the rosette 0-degree axis. */
  readonly angleDeg: number;
  /** Rosette 0-degree axis (unit, world). */
  readonly axis0: Vec3;
}

export interface Laminate {
  readonly compositePartId: string;
  /** Bottom (tool side) to top along `stackNormal`. */
  readonly plies: readonly LaminatePly[];
  /** Unit direction the plies stack in (tool-face normal, reversed for `negative_normal`). */
  readonly stackNormal: Vec3;
  /** Total cured thickness, document units. */
  readonly thickness: number;
  readonly materials: Readonly<Record<string, LaminaMaterial>>;
}

export interface LaminateRefusal {
  readonly code: string;
  readonly message: string;
}

export const isLaminateRefusal = (value: Laminate | LaminateRefusal): value is LaminateRefusal => 'code' in value;

/**
 * Laminate of composite part `compositePartId` laid up on `entityId`.
 * @invariant only uniform laminates: every ply covers the whole tool face (`whole_face`); core plies are not written
 * @failure unknown part / part on another entity / no plies / missing lamina material or rosette -> FEA_COMPOSITE_INVALID;
 *   a ply with a polygon boundary (zones, drops) -> FEA_COMPOSITE_ZONES_UNSUPPORTED; a honeycomb / foam core ply -> FEA_COMPOSITE_CORE_UNSUPPORTED
 */
export function laminateOf(doc: CadDocument, compositePartId: string, entityId: string, sectionId?: string): Laminate | LaminateRefusal {
  const composites = doc.composites;
  const part =
    composites === undefined || !Object.hasOwn(composites.parts, compositePartId) ? undefined : composites.parts[compositePartId];
  if (composites === undefined || part === undefined)
    return { code: 'FEA_COMPOSITE_INVALID', message: `no composite part '${compositePartId}'` };
  if (!part.toolFaces.some((face) => face.entityId === entityId))
    return { code: 'FEA_COMPOSITE_INVALID', message: `composite part '${compositePartId}' is not laid up on '${entityId}'` };
  if (sectionId !== undefined) return sectionLaminate(composites, part, sectionId);
  const plies = composites.plyOrder
    .flatMap((id) => (Object.hasOwn(composites.plies, id) && composites.plies[id] !== undefined ? [composites.plies[id]] : []))
    .filter((ply) => ply.partId === compositePartId)
    .sort((a, b) => a.order - b.order);
  if (plies.length === 0) return { code: 'FEA_COMPOSITE_INVALID', message: `composite part '${compositePartId}' has no ply` };
  const zoned = plies.find((ply) => ply.boundary.kind !== 'whole_face');
  if (zoned !== undefined)
    return {
      code: 'FEA_COMPOSITE_ZONES_UNSUPPORTED',
      message: `ply '${zoned.name}' covers only part of the face: zoned / dropped laminates need a laminate section (create_laminate_sections, laminateSectionId)`,
    };
  const out: LaminatePly[] = [];
  const materials: Record<string, LaminaMaterial> = {};
  let stackNormal: Vec3 | null = null;
  for (const ply of plies) {
    const material = Object.hasOwn(composites.materials, ply.materialName) ? composites.materials[ply.materialName] : undefined;
    const rosette = Object.hasOwn(composites.rosettes, ply.rosetteId) ? composites.rosettes[ply.rosetteId] : undefined;
    if (material === undefined || rosette === undefined)
      return { code: 'FEA_COMPOSITE_INVALID', message: `ply '${ply.name}': lamina material or rosette missing` };
    if (material.form === 'core_honeycomb' || material.form === 'core_foam')
      return { code: 'FEA_COMPOSITE_CORE_UNSUPPORTED', message: `ply '${ply.name}' is a ${material.form}: sandwich cores are not written` };
    materials[ply.materialName] = material;
    stackNormal ??= scale3(normalize3(rosette.normal), part.laminateSide === 'negative_normal' ? -1 : 1);
    out.push({
      id: ply.id,
      name: ply.name,
      materialName: ply.materialName,
      thickness: material.plyThickness,
      angleDeg: ply.orientation,
      axis0: normalize3(rosette.axis0),
    });
  }
  return {
    compositePartId,
    plies: out,
    stackNormal: stackNormal ?? [0, 0, 1],
    thickness: out.reduce((sum, ply) => sum + ply.thickness, 0),
    materials,
  };
}

/**
 * Laminate of a stored 06 CMP section (`create_laminate_sections`): its plies (tool side first, angles from the part rosette) and lamina records.
 * @failure unknown section / section of another part / missing lamina material or rosette -> FEA_COMPOSITE_INVALID; core ply -> FEA_COMPOSITE_CORE_UNSUPPORTED
 */
function sectionLaminate(composites: CompositesModel, part: CompositePart, sectionId: string): Laminate | LaminateRefusal {
  const sections = composites.sections ?? {};
  const section = Object.hasOwn(sections, sectionId) ? sections[sectionId] : undefined;
  if (section === undefined || section.partId !== part.id)
    return { code: 'FEA_COMPOSITE_INVALID', message: `composite part '${part.id}' has no laminate section '${sectionId}'` };
  const rosette = Object.hasOwn(composites.rosettes, part.rosetteId) ? composites.rosettes[part.rosetteId] : undefined;
  if (rosette === undefined)
    return { code: 'FEA_COMPOSITE_INVALID', message: `composite part '${part.id}': rosette '${part.rosetteId}' missing` };
  const materials: Record<string, LaminaMaterial> = {};
  const plies: LaminatePly[] = [];
  for (const [index, ply] of section.plies.entries()) {
    const material = Object.hasOwn(composites.materials, ply.material) ? composites.materials[ply.material] : undefined;
    if (material === undefined)
      return { code: 'FEA_COMPOSITE_INVALID', message: `section '${section.name}': lamina material '${ply.material}' missing` };
    if (material.form === 'core_honeycomb' || material.form === 'core_foam')
      return {
        code: 'FEA_COMPOSITE_CORE_UNSUPPORTED',
        message: `section '${section.name}' ply ${index + 1} is a ${material.form}: sandwich cores are not written`,
      };
    materials[ply.material] = material;
    plies.push({
      id: `${section.id}.${index + 1}`,
      name: `${section.name} ${index + 1}`,
      materialName: ply.material,
      thickness: ply.thickness,
      angleDeg: ply.angleDeg,
      axis0: normalize3(rosette.axis0),
    });
  }
  if (plies.length === 0) return { code: 'FEA_COMPOSITE_INVALID', message: `laminate section '${sectionId}' has no ply` };
  return {
    compositePartId: part.id,
    plies,
    stackNormal: scale3(normalize3(rosette.normal), section.laminateSide === 'negative_normal' ? -1 : 1),
    thickness: plies.reduce((sum, ply) => sum + ply.thickness, 0),
    materials,
  };
}
