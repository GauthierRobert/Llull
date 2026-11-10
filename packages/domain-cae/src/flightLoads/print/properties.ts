/** 14 FLL-M3: the homogenised properties of a printed part of a document, the one place `set_print_idealization` and the deck writer both read. */

import { displayOnlyMeshIds, displayOnlyMessage } from '@core/geometry/mesh/displayOnly';
import { solidTriangles } from '@core/geometry/solidTriangles';
import type { PrintIdealization } from '@core/model/printIdealization';
import { is3D } from '@core/model/types';
import type { CadDocument } from '@core/model/types';
import { toMetres } from '@core/model/units';
import { ROOM_TEMPERATURE_K, elasticConstants, isElasticRefusal } from '../../decks/elastic';
import { homogenise, isStable, skinEstimate, type HomogenisedPart, type SkinEstimate } from './homogenize';

export interface PrintedProperties {
  readonly part: HomogenisedPart;
  readonly skin: SkinEstimate;
  /** Poisson ratio of the solid material and where it was read. */
  readonly nu: number;
  readonly nuSource: string;
  /** Why the result is not verified: unmeasured shear and Poisson ratios, the first-order skin, the exponent and material flags. */
  readonly unverifiedReasons: readonly string[];
  readonly wallDocUnits: number;
  readonly topBottomDocUnits: number;
}

export interface PrintedRefusal {
  readonly code: string;
  readonly message: string;
}

export const isPrintedRefusal = (value: PrintedProperties | PrintedRefusal): value is PrintedRefusal => 'code' in value;

/**
 * Homogenised orthotropic properties of `entityId` printed as `print`: skin fraction from the entity triangles, Poisson ratio from the entity material.
 * @invariant deterministic; read at 20 degC (printed idealization is for static / modal / buckling cases)
 * @failure an asset-backed part held only as its display mesh -> MESH_ASSET_LOD_ONLY (the host hands the deck a full-resolution document); no 3D solid / no closed geometry -> FLL_PRINT_GEOMETRY; no material or no elastic constants -> the elastic refusal code; unstable constants -> FLL_PRINT_STIFFNESS
 */
export function printedProperties(doc: CadDocument, entityId: string, print: PrintIdealization): PrintedProperties | PrintedRefusal {
  const entity = Object.hasOwn(doc.entities, entityId) ? doc.entities[entityId] : undefined;
  if (entity === undefined || !is3D(entity))
    return { code: 'FLL_PRINT_GEOMETRY', message: `'${entityId}' is not a 3D solid of the document` };
  const lodOnly = displayOnlyMeshIds(doc, [entityId]);
  if (lodOnly.length > 0) return { code: 'MESH_ASSET_LOD_ONLY', message: displayOnlyMessage(lodOnly) };
  const materialId = entity.materialId;
  const material = materialId !== undefined && Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (material === undefined || materialId === undefined)
    return { code: 'FEA_MATERIAL_MISSING', message: `part '${entityId}' has no material (its Poisson ratio and density are read from it)` };
  const elastic = elasticConstants(material, materialId, ROOM_TEMPERATURE_K);
  if (isElasticRefusal(elastic)) return elastic;
  const mmPerUnit = toMetres(doc, 1) * 1000;
  const wall = (print.walls * print.lineWidthMm) / mmPerUnit;
  const topBottom = (print.topBottomLayers * print.layerHeightMm) / mmPerUnit;
  const skin = skinEstimate(solidTriangles(entity), print.layerAxis, wall, topBottom);
  if (skin === null)
    return {
      code: 'FLL_PRINT_GEOMETRY',
      message: `'${entityId}' has no closed geometry to measure the skin on (no triangles or zero volume)`,
    };
  const part = homogenise(print, elastic.nu, skin.fraction);
  if (!isStable(part))
    return {
      code: 'FLL_PRINT_STIFFNESS',
      message: `the orthotropic constants of '${entityId}' are not positive definite (E_xy ${part.E1.toPrecision(5)}, E_z ${part.E3.toPrecision(5)} MPa with nu ${elastic.nu}): the coupon moduli differ too much for that Poisson ratio`,
    };
  return {
    part,
    skin,
    nu: elastic.nu,
    nuSource: elastic.source,
    wallDocUnits: wall,
    topBottomDocUnits: topBottom,
    unverifiedReasons: [
      `shear moduli and Poisson ratios are not coupon-measured: nu12 = nu13 = nu23 = ${elastic.nu} from ${elastic.source}, G12 = E_xy / (2 (1 + nu)), G13 = G23 = E_z / (2 (1 + nu)) (the through-build shear uses the build-direction modulus)`,
      'skin fraction is a first-order estimate (walls and top / bottom layers per unit area, no corner overlap) and skin and core are mixed in parallel; along the build direction the top / bottom layers and the core act in series, which is softer, so the parallel E_z is non-conservative (an upper estimate)',
      `the infill exponent is ${print.exponent.basis === 'fit' ? 'fitted from coupons' : 'given'} for pattern ${print.infill.pattern}: valid near the infill densities it comes from`,
      'strengths are the solid coupon values and are not homogenised with infill density',
      ...elastic.unverifiedReasons,
    ],
  };
}
