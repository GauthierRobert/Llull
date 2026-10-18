/**
 * The one density resolver (08 MAT TR-MAT-10), read by `mass_properties` and by dynamics. Order: the material's PHY-01 `density` property
 * model (the preferred one, at 20 degC) → the legacy `Material.density` (g per document unit³) → the caller's fallback. The source is
 * always named, a default is flagged `defaulted`, and `unverified` carries the reasons (AF-31 / AF-32).
 */

import type { CadDocument } from '../model/types';
import type { Basis } from '../model/propertyModel';
import { evaluatePropertyModel, isRefused, resolvePropertyModel, type PropertyEvaluationRefused } from '../model/propertyModelEval';
import { toMetres } from '../model/units';

/** Temperature at which a density model is read when the caller names none (the PHY-01 room temperature). */
const ROOM_TEMPERATURE_K = 293.15;

/** What the caller uses when the material gives no density: a `mass_properties` param, an `add_rigid_body` density or a named default. */
export interface DensityFallback {
  readonly kgPerM3: number;
  /** The value as given when it was given in g/(document unit)³: used as is, so legacy masses keep every digit. */
  readonly gPerDocUnit3?: number;
  readonly source: string;
  readonly defaulted: boolean;
}

interface ResolvedDensity {
  readonly available: true;
  readonly kgPerM3: number;
  /** Grams per document unit³ (the legacy `Material.density` unit): mass in g = volume in document units³ × this. */
  readonly gPerDocUnit3: number;
  readonly source: string;
  readonly materialId?: string;
  readonly modelId?: string;
  readonly basis?: Basis;
  readonly defaulted: boolean;
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
}

/** A density model exists but cannot be used: the chain stops (never a silent fallback to another value). */
interface DensityRefused {
  readonly available: false;
  readonly code: string;
  readonly reason: string;
  readonly remediation: string;
}

export type DensityResolution = ResolvedDensity | DensityRefused;

/** Cubic metres in one document unit³. */
const cubicMetresPerUnit3 = (doc: Pick<CadDocument, 'units'>): number => toMetres(doc, 1) ** 3;

/** g/(document unit)³ → kg/m³. */
export const kgPerM3FromDocDensity = (doc: Pick<CadDocument, 'units'>, gPerDocUnit3: number): number =>
  gPerDocUnit3 / 1000 / cubicMetresPerUnit3(doc);

/** Plausible density of a solid or liquid, g/cm³ (hydrogen-free foams excepted); `explicitUnit` lowers the floor to aerogel/foam density. */
const PLAUSIBLE_G_PER_CM3 = { min: 0.01, minExplicit: 0.0005, max: 25 } as const;

/** One line with the density in g/cm³ and kg/m³, e.g. `7.85 g/cm³ (7850 kg/m³)`. */
export function describeDensity(doc: Pick<CadDocument, 'units'>, gPerDocUnit3: number): string {
  const kgPerM3 = kgPerM3FromDocDensity(doc, gPerDocUnit3);
  return `${Number((kgPerM3 / 1000).toPrecision(6))} g/cm³ (${Number(kgPerM3.toPrecision(6))} kg/m³)`;
}

/**
 * Warning text when a density in g/(document unit)³ is implausible for matter (outside 0.01-25 g/cm³; 0.0005-25 when the unit was named
 * explicitly), naming the likely intended unit (the document unit's value read as kg/m³, g/cm³ or kg/mm³ that lands in range); else null.
 */
export function densityPlausibilityWarning(doc: Pick<CadDocument, 'units'>, gPerDocUnit3: number, explicitUnit: boolean): string | null {
  if (!(gPerDocUnit3 > 0) || !Number.isFinite(gPerDocUnit3)) return null;
  const gPerCm3 = kgPerM3FromDocDensity(doc, gPerDocUnit3) / 1000;
  if (gPerCm3 >= (explicitUnit ? PLAUSIBLE_G_PER_CM3.minExplicit : PLAUSIBLE_G_PER_CM3.min) && gPerCm3 <= PLAUSIBLE_G_PER_CM3.max)
    return null;
  const candidates = [
    { unit: 'kg/m^3', gPerCm3: gPerDocUnit3 / 1000 },
    { unit: 'g/cm^3', gPerCm3: gPerDocUnit3 },
    { unit: 'lb/ft^3', gPerCm3: gPerDocUnit3 * 0.0160185 },
    { unit: 'lb/in^3', gPerCm3: gPerDocUnit3 * 27.6799 },
  ].filter((c) => c.gPerCm3 >= PLAUSIBLE_G_PER_CM3.min && c.gPerCm3 <= PLAUSIBLE_G_PER_CM3.max);
  const guess = candidates[0];
  const hint =
    guess === undefined
      ? 'check the unit (pass densityUnit, e.g. "kg/m^3" or "g/cm^3")'
      : `did you mean ${gPerDocUnit3} ${guess.unit.replace('^3', '³')}? pass densityUnit "${guess.unit}"`;
  return (
    `density ${gPerDocUnit3} g/${doc.units}³ = ${Number(gPerCm3.toPrecision(6))} g/cm³ (${Number((gPerCm3 * 1000).toPrecision(6))} kg/m³) ` +
    `is implausible for matter; ${hint}`
  );
}

const resolved = (
  doc: Pick<CadDocument, 'units'>,
  kgPerM3: number,
  fields: Omit<ResolvedDensity, 'available' | 'kgPerM3' | 'gPerDocUnit3'>,
  gPerDocUnit3 = kgPerM3 * 1000 * cubicMetresPerUnit3(doc),
): ResolvedDensity => ({ available: true, kgPerM3, gPerDocUnit3, ...fields });

const refusedDensity = (materialId: string, refusal: PropertyEvaluationRefused): DensityRefused => ({
  available: false,
  code: refusal.code,
  reason: `material '${materialId}': ${refusal.reason}`,
  remediation: refusal.remediation,
});

/**
 * Density of a solid made of `materialId` (absent: no material), else `fallback`; null when neither gives one.
 * @invariant a material that has density models never falls back to its legacy density or to `fallback`
 * @failure density models ambiguous / out of range at 20 degC / non-finite -> available:false with the PHY-01 code;
 *          a legacy density <= 0 or NaN (a loaded document) -> MAT_DENSITY_INVALID
 */
export function resolveDensity(
  doc: Pick<CadDocument, 'materials' | 'units'>,
  materialId: string | undefined,
  fallback?: DensityFallback,
): DensityResolution | null {
  const material = materialId === undefined ? undefined : doc.materials[materialId];
  if (material !== undefined && materialId !== undefined) {
    if (material.record?.unresolved !== undefined)
      return {
        available: false,
        code: 'MAT_LIBRARY_UNRESOLVED',
        reason: `material '${materialId}' comes from private library '${material.record.libraryRef?.libraryId ?? '?'}' whose values are not on this machine (${material.record.unresolved.reason})`,
        remediation: 'register the library file (register_material_library), then run resolve_material_libraries',
      };
    if (material.propertyModels?.some((model) => model.property === 'density') === true) {
      const record = { name: materialId, propertyModels: material.propertyModels };
      const model = resolvePropertyModel(record, { property: 'density' });
      if (isRefused(model)) return refusedDensity(materialId, model);
      const value = evaluatePropertyModel(record, model, { T: { value: ROOM_TEMPERATURE_K, unit: 'K' } }, { outputUnit: 'kg/m^3' });
      if (isRefused(value)) return refusedDensity(materialId, value);
      if (!(value.value > 0))
        return {
          available: false,
          code: 'MAT_DENSITY_INVALID',
          reason: `material '${materialId}': density model '${model.id}' gives ${value.value} kg/m^3`,
          remediation: 'correct the density model (density must be > 0)',
        };
      return resolved(doc, value.value, {
        source: `material '${materialId}' property model '${model.id}'`,
        materialId,
        modelId: model.id,
        basis: value.basis,
        defaulted: false,
        unverified: value.unverified,
        unverifiedReasons: value.unverifiedReasons,
      });
    }
    if (!(material.density > 0))
      return {
        available: false,
        code: 'MAT_DENSITY_INVALID',
        reason: `material '${materialId}' has density ${String(material.density)}`,
        remediation:
          material.record !== undefined
            ? 'give the record a density with set_material_property (property density)'
            : 'redefine the material with create_material (density must be > 0)',
      };
    return resolved(
      doc,
      kgPerM3FromDocDensity(doc, material.density),
      {
        source:
          material.densityUnit === undefined
            ? `material '${materialId}' density (given without a source, g/${doc.units}³)`
            : `material '${materialId}' density (given in ${material.densityUnit}, no source; stored as g/${doc.units}³)`,
        materialId,
        defaulted: false,
        unverified: true,
        unverifiedReasons: [
          material.densityUnit === undefined
            ? 'density given without a source (unverified)'
            : `density given in ${material.densityUnit} without a source (unverified)`,
        ],
      },
      material.density,
    );
  }
  if (fallback === undefined) return null;
  return resolved(
    doc,
    fallback.kgPerM3,
    {
      source: fallback.source,
      defaulted: fallback.defaulted,
      unverified: true,
      unverifiedReasons: [fallback.defaulted ? `defaulted (${fallback.source})` : `given by the caller (${fallback.source})`],
    },
    fallback.gPerDocUnit3,
  );
}
