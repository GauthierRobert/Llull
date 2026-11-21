/** fit_at_temperature phases: limits, temperature pairs, CTE providers, Lame inputs, the per-temperature rows and the report. */

import { codeOf, clearanceAt, lameAt, statusOf, type FitIntent, type LameInput, type Limits } from './fitMath';
import {
  explicitCteProvider,
  isCteRefusal,
  materialCteProvider,
  type CteBasis,
  type CteProvider,
  type CteRefusal,
} from '@core/model/materialCte';
import { convertTo, failed, toKelvin, type Quantity } from './thermoUnits';
import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { codedRejection, report } from '@core/commands/noop';
import { maxOf, minOf } from '@lib/arrayExtrema';

const FORMULA = 'D(T) = D_spec (1 + a_sec (T - T_spec))';
const MAX_ROWS = 200;
const PAIR_TOLERANCE = 1e-6;

type CteSide = 'hole' | 'shaft';

interface CteInput {
  readonly alpha: Quantity;
  readonly referenceTemperature: Quantity;
  readonly source?: string | undefined;
}

/** The params the phases read. */
export interface FitParams {
  readonly hole?: Limits | undefined;
  readonly shaft?: Limits | undefined;
  readonly specTemperature?: Quantity | undefined;
  readonly holeMaterial?: string | undefined;
  readonly shaftMaterial?: string | undefined;
  readonly holeCte?: CteInput | undefined;
  readonly shaftCte?: CteInput | undefined;
  readonly cteBasis?:
    | Record<string, { readonly kind: 'secant' | 'instantaneous'; readonly referenceTemperature?: Quantity | undefined }>
    | undefined;
  readonly temperatures?: Quantity[] | undefined;
  readonly range?: { readonly min: Quantity; readonly max: Quantity; readonly steps: number } | undefined;
  readonly holeTemperatures?: Quantity[] | undefined;
  readonly shaftTemperatures?: Quantity[] | undefined;
  readonly intent?: FitIntent | undefined;
  readonly lame?:
    | {
        readonly hubOuterDiameter: number;
        readonly hubE: Quantity;
        readonly hubNu: number;
        readonly shaftE: Quantity;
        readonly shaftNu: number;
      }
    | undefined;
}

export type Phase<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly result: CommandResult };
const proceed = <T>(value: T): Phase<T> => ({ ok: true, value });
const stop = (result: CommandResult): Phase<never> => ({ ok: false, result });

const refusal = (doc: CadDocument, code: string, reason: string, remediation: string, path: string, cause?: unknown): CommandResult => ({
  ...codedRejection(doc, 'fit_at_temperature', code, reason, remediation, [], [path]),
  data: { code, reason, remediation, path, ...(cause !== undefined ? { cause } : {}) },
});

const refusalOf = (doc: CadDocument, refused: CteRefusal): CommandResult =>
  refusal(doc, refused.code, refused.reason, refused.remediation, refused.path, refused.cause);

/** The specification temperature in kelvin and the hole and shaft limits, or the first refusal. */
export function limitsOf(doc: CadDocument, params: FitParams): Phase<{ specKelvin: number; hole: Limits; shaft: Limits }> {
  if (params.specTemperature === undefined) {
    return stop(
      refusal(
        doc,
        'TMC_SPEC_TEMPERATURE_MISSING',
        'specTemperature is required (the temperature the limits apply at)',
        'give the temperature the drawing limits apply at, e.g. specTemperature = { value: 20, unit: "degC" }',
        'specTemperature',
      ),
    );
  }
  const specKelvin = toKelvin(params.specTemperature);
  if (failed(specKelvin))
    return stop(refusal(doc, specKelvin.code, specKelvin.message, 'give specTemperature in K, degC or degF', 'specTemperature.unit'));
  if (params.hole === undefined || params.shaft === undefined) {
    return stop(
      refusal(
        doc,
        'TMC_FIT_LIMITS_MISSING',
        `${params.hole === undefined ? 'hole' : 'shaft'} limits are missing`,
        'give hole and shaft as { nominal, upper, lower } in document units (basic or untoleranced sizes have no limits)',
        params.hole === undefined ? 'hole' : 'shaft',
      ),
    );
  }
  const { hole, shaft } = params;
  for (const [side, part] of [
    ['hole', hole],
    ['shaft', shaft],
  ] as const) {
    if (!(part.upper >= part.lower)) {
      return stop(
        refusal(
          doc,
          'TMC_FIT_LIMITS_MISSING',
          `${side}.upper ${part.upper} is below ${side}.lower ${part.lower}`,
          'upper must be >= lower deviation',
          `${side}.upper`,
        ),
      );
    }
  }
  if (Math.abs(hole.nominal - shaft.nominal) > PAIR_TOLERANCE * Math.max(hole.nominal, shaft.nominal)) {
    return stop(
      refusal(
        doc,
        'TMC_FIT_NOT_A_PAIR',
        `hole nominal ${hole.nominal} and shaft nominal ${shaft.nominal} ${doc.units} differ by more than ${PAIR_TOLERANCE} relative`,
        'pick the mating hole and shaft features (equal nominal size)',
        'shaft.nominal',
      ),
    );
  }
  return proceed({ specKelvin, hole, shaft });
}

interface TemperaturePair {
  readonly hole: Quantity;
  readonly shaft: Quantity;
}

/** The operating temperatures of hole and shaft (together, a range, then per-part), or the refusal for too many, too few or unpaired ones. */
export function temperaturePairs(doc: CadDocument, params: FitParams): Phase<TemperaturePair[]> {
  const requested = (params.temperatures?.length ?? 0) + (params.range?.steps ?? 0) + (params.holeTemperatures?.length ?? 0);
  if (requested > MAX_ROWS) {
    return stop(
      refusal(
        doc,
        'TMC_FIT_TEMPERATURES_MISSING',
        `${requested} rows requested, the limit is ${MAX_ROWS}`,
        'give at most 200 temperatures in total (temperatures + range.steps + holeTemperatures)',
        'temperatures',
      ),
    );
  }
  const pairs: TemperaturePair[] = [];
  for (const temperature of params.temperatures ?? []) pairs.push({ hole: temperature, shaft: temperature });
  if (params.range !== undefined) {
    const top = convertTo(params.range.max, params.range.min.unit);
    if (failed(top))
      return stop(refusal(doc, top.code, top.message, 'give range.min and range.max in the same dimension', 'range.max.unit'));
    for (let i = 0; i < params.range.steps; i += 1) {
      const value = params.range.min.value + ((top - params.range.min.value) * i) / (params.range.steps - 1);
      pairs.push({ hole: { value, unit: params.range.min.unit }, shaft: { value, unit: params.range.min.unit } });
    }
  }
  const holeTemperatures = params.holeTemperatures ?? [];
  const shaftTemperatures = params.shaftTemperatures ?? [];
  if (holeTemperatures.length !== shaftTemperatures.length) {
    return stop(
      refusal(
        doc,
        'TMC_FIT_TEMPERATURES_MISSING',
        'holeTemperatures and shaftTemperatures differ in length',
        'give one shaft temperature per hole temperature',
        'shaftTemperatures',
      ),
    );
  }
  holeTemperatures.forEach((temperature, i) => pairs.push({ hole: temperature, shaft: shaftTemperatures[i] ?? temperature }));
  if (pairs.length === 0 || pairs.length > MAX_ROWS) {
    return stop(
      refusal(
        doc,
        'TMC_FIT_TEMPERATURES_MISSING',
        pairs.length === 0 ? 'no operating temperature given' : `${pairs.length} rows exceed the limit of ${MAX_ROWS}`,
        'give temperatures, range or holeTemperatures + shaftTemperatures (at most 200 rows)',
        'temperatures',
      ),
    );
  }
  return proceed(pairs);
}

/** The CTE basis stated per material name; a reference temperature in a bad unit is a refusal. */
function basesOf(doc: CadDocument, params: FitParams): Phase<Map<string, CteBasis>> {
  const bases = new Map<string, CteBasis>();
  for (const [name, given] of Object.entries(params.cteBasis ?? {})) {
    if (given.kind === 'instantaneous') bases.set(name, { kind: 'instantaneous' });
    else if (given.referenceTemperature === undefined) bases.set(name, { kind: 'unstated' });
    else {
      const referenceKelvin = toKelvin(given.referenceTemperature);
      if (failed(referenceKelvin))
        return stop(
          refusal(
            doc,
            referenceKelvin.code,
            referenceKelvin.message,
            'give the reference temperature in K, degC or degF',
            `cteBasis.${name}.referenceTemperature.unit`,
          ),
        );
      bases.set(name, { kind: 'secant', referenceKelvin });
    }
  }
  return proceed(bases);
}

function providerFor(doc: CadDocument, params: FitParams, bases: ReadonlyMap<string, CteBasis>, side: CteSide): CteProvider | CteRefusal {
  const material = side === 'hole' ? params.holeMaterial : params.shaftMaterial;
  const explicit = side === 'hole' ? params.holeCte : params.shaftCte;
  if (material !== undefined && explicit !== undefined) {
    return {
      code: 'TMC_CTE_SOURCE_CONFLICT',
      reason: `${side}Material and ${side}Cte are both given`,
      remediation: `give either ${side}Material or ${side}Cte`,
      path: `${side}Cte`,
    };
  }
  if (explicit !== undefined) {
    const alpha = convertTo(explicit.alpha, '1/K');
    const reference = toKelvin(explicit.referenceTemperature);
    if (failed(alpha)) return { code: alpha.code, reason: alpha.message, remediation: 'give alpha in 1/K', path: `${side}Cte.alpha.unit` };
    if (failed(reference))
      return {
        code: reference.code,
        reason: reference.message,
        remediation: 'give a temperature unit',
        path: `${side}Cte.referenceTemperature.unit`,
      };
    return explicitCteProvider(alpha, reference, explicit.source ?? '');
  }
  if (material === undefined) {
    return {
      code: 'TMC_MATERIAL_NO_CTE',
      reason: `the ${side} has neither a material nor an explicit CTE`,
      remediation: `give ${side}Material (with a thermalStrain or cte property model) or ${side}Cte`,
      path: `${side}Material`,
    };
  }
  return materialCteProvider(doc.materials, material, bases.get(material) ?? { kind: 'unstated' }, `${side}Material`);
}

/** The CTE providers of hole and shaft, or the first refusal (basis units, then hole, then shaft). */
export function cteProviders(doc: CadDocument, params: FitParams): Phase<{ hole: CteProvider; shaft: CteProvider }> {
  const bases = basesOf(doc, params);
  if (!bases.ok) return bases;
  const hole = providerFor(doc, params, bases.value, 'hole');
  if (isCteRefusal(hole)) return stop(refusalOf(doc, hole));
  const shaft = providerFor(doc, params, bases.value, 'shaft');
  if (isCteRefusal(shaft)) return stop(refusalOf(doc, shaft));
  return proceed({ hole, shaft });
}

/** The Lame inputs in MPa and document units (undefined without `lame`), or the refusal for bad moduli or hub size. */
export function lameInputOf(doc: CadDocument, params: FitParams, nominal: number): Phase<LameInput | undefined> {
  if (params.lame === undefined) return proceed(undefined);
  const hubE = convertTo(params.lame.hubE, 'MPa');
  const shaftE = convertTo(params.lame.shaftE, 'MPa');
  if (failed(hubE) || failed(shaftE)) {
    const failure = failed(hubE) ? hubE : (shaftE as Exclude<typeof shaftE, number>);
    return stop(refusal(doc, failure.code, failure.message, "give E in a pressure unit, e.g. 'MPa'", 'lame.hubE.unit'));
  }
  if (!(params.lame.hubOuterDiameter > nominal) || !(hubE > 0) || !(shaftE > 0)) {
    return stop(
      refusal(doc, 'TMC_FIT_LIMITS_MISSING', 'lame needs hubOuterDiameter > nominal and positive moduli', 'fix the lame inputs', 'lame'),
    );
  }
  return proceed({
    hubOuterRadius: params.lame.hubOuterDiameter / 2,
    hubE,
    hubNu: params.lame.hubNu,
    shaftE,
    shaftNu: params.lame.shaftNu,
  });
}

/** What every row of the fit is computed from. */
export interface FitBasis {
  readonly doc: CadDocument;
  readonly specKelvin: number;
  readonly hole: Limits;
  readonly shaft: Limits;
  readonly providers: { readonly hole: CteProvider; readonly shaft: CteProvider };
  readonly lame: LameInput | undefined;
  readonly intent: FitIntent;
}

function rowOf(basis: FitBasis, pair: TemperaturePair, holeStrain: StrainOf, shaftStrain: StrainOf): FitRow {
  const { hole, shaft, lame, intent } = basis;
  const fit = clearanceAt(hole, shaft, holeStrain.strain, shaftStrain.strain);
  const code = codeOf(fit.clearance, intent);
  const reasons = [
    ...new Set([
      ...holeStrain.unverifiedReasons,
      ...shaftStrain.unverifiedReasons,
      ...(lame !== undefined ? ['explicit E, nu without a sourced material record'] : []),
    ]),
  ];
  const elastic = lame !== undefined ? lameAt(fit.clearance, hole.nominal, lame) : undefined;
  const samplingError = Math.max(holeStrain.samplingError ?? 0, shaftStrain.samplingError ?? 0);
  return {
    rowKey: `hole ${pair.hole.value} ${pair.hole.unit} | shaft ${pair.shaft.value} ${pair.shaft.unit}`,
    temperature: { hole: pair.hole, shaft: pair.shaft },
    ...fit,
    status: statusOf(fit.clearance, intent),
    ...(code !== undefined ? { code } : {}),
    ...(elastic !== undefined ? { interferencePressureMPa: elastic.pressure, hubHoopStressMPa: { max: elastic.hubHoopMax } } : {}),
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
    reviewRequired: true as const,
    reviewReason: 'a fit verdict is an engineering disposition; the formula is linear thermal expansion only (see assumptions)',
    disposition: code !== undefined ? ('pending_human' as const) : ('none' as const),
    provenance: {
      formula: FORMULA,
      thermalStrain: { hole: holeStrain.strain, shaft: shaftStrain.strain },
      ...(samplingError > 0 ? { samplingError } : {}),
    },
  };
}

type StrainOf = Exclude<ReturnType<CteProvider['strainAt']>, CteRefusal>;
type FitRow = {
  readonly rowKey: string;
  readonly temperature: TemperaturePair;
  readonly code?: string;
  readonly unverified: boolean;
  readonly clearance: { readonly min: number; readonly max: number };
  readonly [key: string]: unknown;
};

/** One row per temperature pair, in order; the first bad unit or out-of-range CTE is a refusal. */
export function fitRows(basis: FitBasis, pairs: readonly TemperaturePair[]): Phase<FitRow[]> {
  const { doc, specKelvin, providers } = basis;
  const rows: FitRow[] = [];
  for (const pair of pairs) {
    const holeKelvin = toKelvin(pair.hole);
    const shaftKelvin = toKelvin(pair.shaft);
    if (failed(holeKelvin))
      return stop(refusal(doc, holeKelvin.code, holeKelvin.message, 'give temperatures in K, degC or degF', 'temperatures.unit'));
    if (failed(shaftKelvin))
      return stop(refusal(doc, shaftKelvin.code, shaftKelvin.message, 'give temperatures in K, degC or degF', 'temperatures.unit'));
    const holeStrain = providers.hole.strainAt(holeKelvin, specKelvin);
    if (isCteRefusal(holeStrain)) return stop(refusalOf(doc, holeStrain));
    const shaftStrain = providers.shaft.strainAt(shaftKelvin, specKelvin);
    if (isCteRefusal(shaftStrain)) return stop(refusalOf(doc, shaftStrain));
    rows.push(rowOf(basis, pair, holeStrain, shaftStrain));
  }
  return proceed(rows);
}

/** The report of the computed rows: summary text and the FitResult data. */
export function fitReport(basis: FitBasis, params: FitParams, rows: readonly FitRow[]): CommandResult {
  const { doc, hole, shaft, providers, lame, intent } = basis;
  const failing = rows.filter((row) => row.code !== undefined);
  const summary =
    `fit_at_temperature: ${rows.length} row(s), nominal ${hole.nominal} ${doc.units}, intent ${intent}${params.intent === undefined ? ' (derived from the limits)' : ''}, ` +
    `clearance ${minOf(rows.map((row) => row.clearance.min)).toPrecision(6)} … ${maxOf(rows.map((row) => row.clearance.max)).toPrecision(6)} ${doc.units}; ` +
    `${failing.length === 0 ? 'no row violates the intent' : `${failing.length} row(s) flagged ${[...new Set(failing.map((row) => row.code))].join(', ')} (pending human disposition)`}` +
    `${rows.some((row) => row.unverified) ? '; unverified CTE inputs' : ''}; every row needs review by a qualified engineer.`;
  const data = {
    unit: doc.units,
    specTemperature: params.specTemperature,
    intent,
    intentSource: params.intent === undefined ? 'derived_from_limits_at_spec_temperature' : 'given',
    rows,
    provenance: {
      formula: FORMULA,
      cte: [
        { part: 'hole', source: providers.hole.source, basis: providers.hole.basis, conversion: providers.hole.conversion },
        { part: 'shaft', source: providers.shaft.source, basis: providers.shaft.basis, conversion: providers.shaft.conversion },
      ],
      limits: [
        { part: 'hole', ...hole },
        { part: 'shaft', ...shaft },
      ],
    },
    assumptions: [
      'linear thermal expansion applied to every limit diameter, from the specification temperature',
      'uniform temperature inside each part; no elastic deformation, form error or gradient',
      'PMI size dimensions are not available: limits are explicit inputs',
      ...(lame !== undefined
        ? ['Lame: elastic, constant E and nu, solid shaft, hub outer diameter fixed, interference from the row clearance']
        : []),
    ],
    summary,
  };
  return report(doc, summary, data);
}
