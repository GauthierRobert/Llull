/** Secant CTE of a document material for CalculiX `*EXPANSION, ZERO=` (PHY-04 §3.3, §5.1, §5.2), through PHY-01 property models only. */

import type { CteBasisSpec, TemperatureScale, ThermoMechSetup } from '@core/model/analysis';
import { isCteRefusal, materialCteProvider, type CteBasis, type CteProvider, type CteRefusal } from '@core/model/materialCte';
import { modelUnverifiedReasons, resolvePropertyModel, isRefused } from '@core/model/propertyModelEval';
import type { PropertyDirection } from '@core/model/propertyModel';
import type { CadDocument } from '@core/model/types';
import { canonicalJson } from '@lib/canonicalJson';
import { sha256Hex } from '@lib/sha256';
import { fromKelvin, temperatureIn } from './units';

/** Step between tabulated temperatures (K); the secant CTE is interpolated linearly between rows. */
const TABLE_STEP_KELVIN = 10;
/** Named guard: most rows of a secant table, whatever the range (a wide range gets a coarser step, never a longer table). */
const MAX_TABLE_INTERVALS = 1000;
/** Offset (K) at which the limit alpha_sec(T_ref) = alpha_inst(T_ref) is read from the strain (large enough to avoid cancellation). */
export const REFERENCE_PROBE_KELVIN = 0.5;

/** The stated `cte` basis of a material for this case; `unstated` when none was given or its reference is not a temperature. */
function cteBasisOf(setup: ThermoMechSetup, materialId: string): CteBasis {
  const spec: CteBasisSpec | undefined = Object.hasOwn(setup.cteBasis ?? {}, materialId) ? setup.cteBasis?.[materialId] : undefined;
  if (spec === undefined) return { kind: 'unstated' };
  if (spec.kind === 'instantaneous') return spec;
  const reference = temperatureIn(spec.referenceTemperature, 'K');
  return reference === null ? { kind: 'unstated' } : { kind: 'secant', referenceKelvin: reference };
}

export interface SecantExpansion {
  /** `[alpha, temperature]` rows in the case scale (a single `[alpha]` row = constant). */
  readonly rows: readonly (readonly [number] | readonly [number, number])[];
  readonly provider: CteProvider;
  readonly unverifiedReasons: readonly string[];
  /** sha256 of the canonical JSON of the property model the CTE was derived from. */
  readonly modelSha256: string;
}

/** The thermalStrain model when present, else the cte model: the one `materialCteProvider` reads. */
function sourceModelSha(doc: CadDocument, materialId: string, direction?: PropertyDirection): string {
  const material = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  const record = { name: materialId, ...(material?.propertyModels !== undefined ? { propertyModels: material.propertyModels } : {}) };
  const directed = direction === undefined ? {} : { direction };
  const strain = resolvePropertyModel(record, { property: 'thermalStrain', ...directed });
  const model = isRefused(strain) ? resolvePropertyModel(record, { property: 'cte', ...directed }) : strain;
  return isRefused(model) ? '' : sha256Hex(canonicalJson(model));
}

/** Provider of the material of `materialId` for this case, or a refusal (TMC_MATERIAL_NO_CTE, TMC_CTE_BASIS_UNKNOWN, PHY-01 codes). */
export function providerFor(
  doc: CadDocument,
  setup: ThermoMechSetup,
  materialId: string,
  path: string,
  direction?: PropertyDirection,
): CteProvider | CteRefusal {
  return materialCteProvider(doc.materials, materialId, cteBasisOf(setup, materialId), path, direction);
}

/**
 * Secant CTE table about `reference` covering [`lowKelvin`, `highKelvin`] (extended to contain the reference), rows in the case scale.
 * @invariant both ends of the range are evaluated BEFORE any table is allocated (a range outside the model validity is refused, never
 *   sampled), and the table has at most 1000 intervals
 * @failure PHY-01 range refusal (TMC_PROPERTY_OUT_OF_RANGE) when the field leaves the model validity; non-finite range -> THM_UNITS_MISMATCH
 */
export function secantExpansion(
  doc: CadDocument,
  materialId: string,
  provider: CteProvider,
  referenceKelvin: number,
  lowKelvin: number,
  highKelvin: number,
  scale: TemperatureScale,
  direction?: PropertyDirection,
): SecantExpansion | CteRefusal {
  const low = Math.min(lowKelvin, referenceKelvin);
  const high = Math.max(highKelvin, referenceKelvin);
  const reasons = new Set<string>();
  const secantAt = (kelvin: number): number | CteRefusal => {
    const atReference = Math.abs(kelvin - referenceKelvin) < 1e-6;
    const offsets = atReference ? [REFERENCE_PROBE_KELVIN, -REFERENCE_PROBE_KELVIN] : [kelvin - referenceKelvin];
    let refused: CteRefusal | undefined;
    for (const offset of offsets) {
      const result = provider.strainAt(referenceKelvin + offset, referenceKelvin);
      if (isCteRefusal(result)) {
        refused ??= result;
        continue;
      }
      result.unverifiedReasons.forEach((reason) => reasons.add(reason));
      return result.strain / offset;
    }
    return refused ?? { code: 'TMC_PROPERTY_OUT_OF_RANGE', reason: 'no temperature to evaluate', remediation: '', path: 'material' };
  };
  if (!Number.isFinite(low) || !Number.isFinite(high))
    return { code: 'THM_UNITS_MISMATCH', reason: 'the temperature range of the field is not finite', remediation: '', path: 'field' };
  for (const edge of [low, high]) {
    const atEdge = secantAt(edge);
    if (typeof atEdge !== 'number') return atEdge;
  }
  const intervals = high - low < 1e-9 ? 0 : Math.min(MAX_TABLE_INTERVALS, Math.ceil((high - low) / TABLE_STEP_KELVIN));
  const samples =
    intervals === 0 ? [referenceKelvin] : Array.from({ length: intervals + 1 }, (_, i) => low + ((high - low) * i) / intervals);
  const alphas: number[] = [];
  for (const kelvin of samples) {
    const alpha = secantAt(kelvin);
    if (typeof alpha !== 'number') return alpha;
    alphas.push(alpha);
  }
  const extreme = samples.reduce(
    (best, kelvin, i) => (Math.abs(kelvin - referenceKelvin) > Math.abs((samples[best] ?? 0) - referenceKelvin) ? i : best),
    0,
  );
  const first = alphas[0] ?? 0;
  const constant = alphas.every((alpha) => Math.abs(alpha - first) <= 1e-10 * Math.abs(first));
  const base = { provider, unverifiedReasons: [...reasons], modelSha256: sourceModelSha(doc, materialId, direction) };
  if (constant) return { ...base, rows: [[alphas[extreme] ?? first]] };
  return { ...base, rows: samples.map((kelvin, i) => [alphas[i] ?? first, fromKelvin(kelvin, scale)] as const) };
}

/** E / nu property-model flags of a material (PHY-01 `unverified`), for the OR rule of TR-TMC-30. */
export function elasticUnverifiedReasons(doc: CadDocument, materialId: string): string[] {
  const material = Object.hasOwn(doc.materials, materialId) ? doc.materials[materialId] : undefined;
  if (material?.propertyModels === undefined) return [];
  const record = { name: materialId, propertyModels: material.propertyModels };
  return ['E', 'nu'].flatMap((property) => {
    const model = resolvePropertyModel(record, { property });
    return isRefused(model) ? [] : modelUnverifiedReasons(model).map((reason) => `${property}: ${reason}`);
  });
}
