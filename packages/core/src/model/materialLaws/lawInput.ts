/**
 * Input conventions of `add_material_model` (PHY-02 §3, §5.2, §5.4): the agent states HOW a law is written and llull converts it to the
 * canonical stored form, recording the conversion. Nothing here is defaulted — a missing convention is a refusal with its own code.
 */

import { convertValue, isUnitFailure } from '../../lib/quantity';
import { isRecord } from '../../lib/isRecord';
import { engineeringToCalculix } from './rambergOsgood';
import { ogden1972ToCanonical } from './hyperelastic';
import { failure, isLawFailure, type LawFailure } from './resolve';

export interface NormalizedLaw {
  readonly law: unknown;
  readonly conversion?: { readonly from: string; readonly note: string };
}

const isQuantity = (value: unknown): value is { value: number; unit: string } =>
  isRecord(value) && typeof value['value'] === 'number' && typeof value['unit'] === 'string';

const without = (source: Record<string, unknown>, ...keys: string[]): Record<string, unknown> =>
  Object.fromEntries(Object.entries(source).filter(([key]) => !keys.includes(key)));

function ogden(raw: Record<string, unknown>): NormalizedLaw | LawFailure {
  const convention = raw['convention'];
  if (convention !== 'calculix' && convention !== 'ogden1972')
    return failure(
      'MATL_LAW_PARAMS_INVALID',
      'model.convention',
      "state the Ogden convention: 'calculix' (W = Σ 2μ_i/α_i² (…)) or 'ogden1972' (W = Σ μ_p/α_p (…)); it is never defaulted",
      "set model.convention to 'calculix' or 'ogden1972'",
    );
  const rest = without(raw, 'convention');
  if (convention === 'calculix') return { law: rest };
  const terms = Array.isArray(raw['terms']) ? raw['terms'] : [];
  const converted = terms.map((term: unknown) =>
    isRecord(term) && typeof term['mu'] === 'number' && typeof term['alpha'] === 'number'
      ? { ...term, mu: ogden1972ToCanonical(term['mu'], term['alpha']) }
      : term,
  );
  return {
    law: { ...rest, terms: converted },
    conversion: {
      from: 'ogden1972',
      note: 'μ_i = μ_p α_p / 2 (canonical CalculiX / Abaqus convention W = Σ 2μ_i/α_i² (λ1^α + λ2^α + λ3^α − 3))',
    },
  };
}

function rambergOsgood(raw: Record<string, unknown>): NormalizedLaw | LawFailure {
  const form = raw['form'];
  if (form !== 'calculix' && form !== 'engineering')
    return failure(
      'MATL_LAW_PARAMS_INVALID',
      'model.form',
      "state the Ramberg-Osgood form: 'calculix' (E ε = σ + α (|σ|/σ0)^(n−1) σ, give sigma0 and alpha) or 'engineering' (ε = σ/E + 0.002 (σ/σ0.2)^n, give sigma02); it is never defaulted",
      "set model.form to 'calculix' or 'engineering'",
    );
  const base = { ...without(raw, 'form', 'sigma02'), theory: 'deformation' };
  if (form === 'calculix') return { law: base };
  const sigma02 = raw['sigma02'];
  const modulus = raw['E'];
  if (!isQuantity(sigma02) || !isQuantity(modulus))
    return failure(
      'MATL_LAW_PARAMS_INVALID',
      'model.sigma02',
      'the engineering form needs sigma02 and E as constant {value, unit} quantities',
      'give sigma02 and E with units',
    );
  const inSigmaUnit = convertValue(modulus.value, modulus.unit, sigma02.unit);
  if (isUnitFailure(inSigmaUnit)) return failure('MATL_LAW_PARAMS_INVALID', 'model.E.unit', inSigmaUnit.message);
  const { sigma0, alpha } = engineeringToCalculix(inSigmaUnit.value, sigma02.value);
  return {
    law: { ...base, sigma0: { value: sigma0, unit: sigma02.unit }, alpha },
    conversion: {
      from: 'ramberg_osgood engineering form',
      note: `σ0 = σ0.2 = ${sigma02.value} ${sigma02.unit}, α = 0.002 E/σ0.2 = ${alpha}`,
    },
  };
}

interface Measure {
  readonly stress: 'true' | 'engineering';
  readonly strain: 'plastic' | 'total';
  readonly strainKind: 'true' | 'engineering';
  readonly youngModulus?: { value: number; unit: string };
}

function parseMeasure(value: unknown): Measure | null {
  if (!isRecord(value)) return null;
  const { stress, strain, strainKind, youngModulus } = value;
  if (
    (stress !== 'true' && stress !== 'engineering') ||
    (strain !== 'plastic' && strain !== 'total') ||
    (strainKind !== 'true' && strainKind !== 'engineering')
  )
    return null;
  return { stress, strain, strainKind, ...(isQuantity(youngModulus) ? { youngModulus } : {}) };
}

/** Engineering / total curve → true stress vs equivalent plastic strain (§5.2); the first point is shifted to ε_p = 0 for total strain. */
function multilinear(
  isotropic: Record<string, unknown>,
): { isotropic: Record<string, unknown>; conversion?: NormalizedLaw['conversion'] } | LawFailure {
  const measure = parseMeasure(isotropic['inputMeasure']);
  if (measure === null)
    return failure(
      'MATL_CURVE_MEASURE_MISSING',
      'model.isotropic.inputMeasure',
      "state the curve measure { stress: 'true'|'engineering', strain: 'plastic'|'total', strainKind: 'true'|'engineering' } (+ youngModulus for total strain); it is never defaulted",
      'add model.isotropic.inputMeasure',
    );
  const rest = without(isotropic, 'inputMeasure');
  const stressUnit = typeof isotropic['stressUnit'] === 'string' ? isotropic['stressUnit'] : '';
  const identity = measure.stress === 'true' && measure.strain === 'plastic' && measure.strainKind === 'true';
  if (identity) return { isotropic: rest };
  let modulus = 0;
  if (measure.strain === 'total') {
    if (measure.youngModulus === undefined)
      return failure(
        'MATL_CURVE_MEASURE_MISSING',
        'model.isotropic.inputMeasure.youngModulus',
        'total strain needs youngModulus to subtract σ/E',
        'give inputMeasure.youngModulus',
      );
    const converted = convertValue(measure.youngModulus.value, measure.youngModulus.unit, stressUnit);
    if (isUnitFailure(converted))
      return failure('MATL_LAW_PARAMS_INVALID', 'model.isotropic.inputMeasure.youngModulus.unit', converted.message);
    modulus = converted.value;
  }
  const curves = Array.isArray(isotropic['curves']) ? isotropic['curves'] : [];
  const convertedCurves = curves.map((curve: unknown) => {
    if (!isRecord(curve) || !Array.isArray(curve['points'])) return curve;
    const trueEntries = (curve['points'] as unknown[]).map((point) => {
      if (!Array.isArray(point) || typeof point[0] !== 'number' || typeof point[1] !== 'number') return null;
      const [rawStress, rawStrain] = point as [number, number];
      const strainTrue = measure.strainKind === 'engineering' ? Math.log(1 + rawStrain) : rawStrain;
      const stressTrue = measure.stress === 'engineering' ? rawStress * Math.exp(strainTrue) : rawStress;
      return [stressTrue, measure.strain === 'total' ? strainTrue - stressTrue / modulus : strainTrue] as [number, number];
    });
    if (trueEntries.some((entry) => entry === null)) return curve;
    const shift = measure.strain === 'total' ? ((trueEntries[0] as [number, number] | null)?.[1] ?? 0) : 0;
    return { ...curve, points: trueEntries.map((entry) => [(entry as [number, number])[0], (entry as [number, number])[1] - shift]) };
  });
  const parts = [
    measure.stress === 'engineering' ? 'σ_t = σ_e (1 + ε_e)' : null,
    measure.strainKind === 'engineering' ? 'ε_t = ln(1 + ε_e)' : null,
    measure.strain === 'total' ? 'ε_p = ε_t − σ_t/E, first point shifted to ε_p = 0' : null,
  ].filter((part): part is string => part !== null);
  return {
    isotropic: { ...rest, curves: convertedCurves },
    conversion: {
      from: `${measure.stress} stress / ${measure.strain} ${measure.strainKind} strain curve`,
      note: `${parts.join('; ')} (true stress vs equivalent plastic strain)`,
    },
  };
}

function j2(raw: Record<string, unknown>): NormalizedLaw | LawFailure {
  const isotropic = raw['isotropic'];
  if (!isRecord(isotropic)) return { law: raw };
  if (isotropic['kind'] === 'linear' && isotropic['modulusKind'] === undefined)
    return failure(
      'MATL_HARDENING_MODULUS_KIND_MISSING',
      'model.isotropic.modulusKind',
      "say whether the hardening modulus is 'plastic' (slope of stress vs plastic strain) or 'tangent' (slope vs total strain); it is never defaulted",
      "set model.isotropic.modulusKind to 'plastic' or 'tangent'",
    );
  if (isotropic['kind'] !== 'multilinear') return { law: raw };
  const converted = multilinear(isotropic);
  if (isLawFailure(converted)) return converted;
  return {
    law: { ...raw, isotropic: converted.isotropic },
    ...(converted.conversion !== undefined ? { conversion: converted.conversion } : {}),
  };
}

/**
 * Canonical form of an input law.
 * @failure missing convention / measure / modulusKind -> the dedicated MATL_* code with the path; engineering Ramberg-Osgood without constants
 */
export function normalizeLawInput(raw: unknown): NormalizedLaw | LawFailure {
  if (!isRecord(raw) || typeof raw['kind'] !== 'string')
    return failure(
      'MATL_LAW_PARAMS_INVALID',
      'model.kind',
      'model must be an object with a string kind',
      'follow `llull describe add_material_model`',
    );
  switch (raw['kind']) {
    case 'hyper_ogden':
      return ogden(raw);
    case 'ramberg_osgood':
      return rambergOsgood(raw);
    case 'j2_plasticity':
      return j2(raw);
    default:
      return { law: raw };
  }
}
