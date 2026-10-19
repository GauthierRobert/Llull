/**
 * Orthotropic CTE (PHY-04 M4b, TR-TMC-25): a material whose `cte` / `thermalStrain` property models name the material directions 1, 2, 3
 * gets one secant table per direction, written as `*EXPANSION, TYPE=ORTHO, ZERO=<T_ref>` rows `a1, a2, a3[, T]`.
 */

import type { ThermoMechSetup } from '@core/model/analysis';
import { isCteRefusal, type CteRefusal } from '@core/model/materialCte';
import type { PropertyDirection } from '@core/model/propertyModel';
import type { CadDocument, Material } from '@core/model/types';
import type { DeckContext, DeckSections } from '../decks/context';
import { commentText, num } from '../decks/format';
import { providerFor, secantExpansion, type SecantExpansion } from './cte';
import { kelvinOf, temperatureIn } from './units';

export const ORTHO_DIRECTIONS = ['1', '2', '3'] as const satisfies readonly PropertyDirection[];

/** Directions 1 / 2 / 3 that carry a CTE (`cte` or `thermalStrain`) property model of the material. */
const directionsWithModels = (material: Material | undefined): readonly PropertyDirection[] =>
  ORTHO_DIRECTIONS.filter((direction) =>
    (material?.propertyModels ?? []).some(
      (model) => (model.property === 'cte' || model.property === 'thermalStrain') && model.direction === direction,
    ),
  );

/** True when some CTE model of the material names a material direction 1 / 2 / 3 (the material is orthotropic in expansion). */
export const isOrthotropicCte = (material: Material | undefined): boolean => directionsWithModels(material).length > 0;

/** The directions 1 / 2 / 3 of an orthotropic CTE that have no CTE model (empty when complete or isotropic). */
export const missingOrthoDirections = (material: Material | undefined): readonly PropertyDirection[] => {
  const have = directionsWithModels(material);
  return have.length === 0 ? [] : ORTHO_DIRECTIONS.filter((direction) => !have.includes(direction));
};

/** Refusal of an orthotropic material with directions missing (TMC_CTE_ORTHO_INCOMPLETE), else null. */
export function incompleteOrthoRefusal(material: Material | undefined, materialId: string): CteRefusal | null {
  const missing = missingOrthoDirections(material);
  return missing.length === 0
    ? null
    : {
        code: 'TMC_CTE_ORTHO_INCOMPLETE',
        reason: `material '${materialId}' has CTE models for some of the directions 1 / 2 / 3 but not for ${missing.join(', ')}`,
        remediation: `define_property_model with property cte (or thermalStrain) and direction ${missing.join(' / ')} on '${materialId}'`,
        path: 'material',
      };
}

export interface OrthotropicExpansion {
  /** `[a1, a2, a3]` (all directions constant) or `[a1, a2, a3, T]` rows on the temperature grid, T in the case scale. */
  readonly rows: readonly (readonly number[])[];
  readonly directions: readonly [SecantExpansion, SecantExpansion, SecantExpansion];
  readonly unverifiedReasons: readonly string[];
}

/**
 * The three directional secant tables of `materialId` about the case reference, merged on one temperature grid.
 * @invariant a direction with a constant CTE repeats its value on the grid of the others
 * @failure a direction missing -> TMC_CTE_ORTHO_INCOMPLETE; TMC_CTE_BASIS_UNKNOWN / TMC_PROPERTY_OUT_OF_RANGE / PHY-01 codes of a direction
 */
export function orthotropicExpansion(
  doc: CadDocument,
  setup: ThermoMechSetup,
  materialId: string,
  lowKelvin: number,
  highKelvin: number,
): OrthotropicExpansion | CteRefusal {
  const material = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  const incomplete = incompleteOrthoRefusal(material, materialId);
  if (incomplete !== null) return incomplete;
  const scale = setup.temperatureScale;
  const reference = temperatureIn(setup.referenceTemperature, scale);
  if (reference === null)
    return {
      code: 'THM_UNITS_MISMATCH',
      reason: 'the reference temperature has an invalid unit',
      remediation: '',
      path: 'referenceTemperature',
    };
  const referenceKelvin = kelvinOf(reference, scale);
  const tables: SecantExpansion[] = [];
  for (const direction of ORTHO_DIRECTIONS) {
    const provider = providerFor(doc, setup, materialId, `material direction ${direction}`, direction);
    if (isCteRefusal(provider)) return provider;
    const table = secantExpansion(doc, materialId, provider, referenceKelvin, lowKelvin, highKelvin, scale, direction);
    if ('code' in table) return table;
    tables.push(table);
  }
  const [a, b, c] = tables;
  if (a === undefined || b === undefined || c === undefined)
    return { code: 'TMC_CTE_ORTHO_INCOMPLETE', reason: `material '${materialId}' lacks a direction`, remediation: '', path: 'material' };
  const varying = tables.find((table) => table.rows.some((row) => row.length === 2));
  const valueAt = (table: SecantExpansion, i: number): number => table.rows[table.rows.length === 1 ? 0 : i]?.[0] ?? Number.NaN;
  const rows =
    varying === undefined
      ? [[valueAt(a, 0), valueAt(b, 0), valueAt(c, 0)]]
      : varying.rows.map((row, i) => [valueAt(a, i), valueAt(b, i), valueAt(c, i), row[1] ?? Number.NaN]);
  return { rows, directions: [a, b, c], unverifiedReasons: [...new Set(tables.flatMap((table) => table.unverifiedReasons))] };
}

/**
 * `*EXPANSION, TYPE=ORTHO` cards of an orthotropic material, with the model id / sha256 / basis per direction in comments.
 * @failure as `orthotropicExpansion`
 */
export function orthotropicExpansionCards(
  ctx: DeckContext,
  entityId: string,
  materialId: string,
  setup: ThermoMechSetup,
  low: number,
  high: number,
): DeckSections {
  const scale = setup.temperatureScale;
  const reference = temperatureIn(setup.referenceTemperature, scale) ?? Number.NaN;
  const result = orthotropicExpansion(ctx.doc, setup, materialId, kelvinOf(low, scale), kelvinOf(high, scale));
  if ('code' in result) return { code: result.code, message: result.reason, ids: [materialId, entityId] };
  const lines = [
    `** orthotropic thermal expansion of '${commentText(materialId)}' for part ${commentText(entityId)}: secant alpha about T_ref = ${num(reference)} ${scale}; directions 1 / 2 / 3 follow the part orientation`,
    ...result.directions.map(
      (table, i) =>
        `** direction ${i + 1}: source ${commentText(table.provider.source)}; basis ${commentText(table.provider.basis)}; model sha256 ${commentText(table.modelSha256)}`,
    ),
    ...(result.unverifiedReasons.length > 0 ? [`** UNVERIFIED: ${commentText(result.unverifiedReasons.join('; '), 400)}`] : []),
    `*EXPANSION, TYPE=ORTHO, ZERO=${num(reference)}`,
    ...result.rows.map((row) => row.map(num).join(', ')),
  ];
  return { text: `${lines.join('\n')}\n` };
}
