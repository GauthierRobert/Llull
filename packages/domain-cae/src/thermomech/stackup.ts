/**
 * stackup_at_temperature (PHY-04 M4b, FR-TMC-07 fit stack-ups): a one-dimensional dimension chain whose contributors expand with their own CTE,
 * evaluated at operating temperatures. Stands in for the 03 GDT `analyze_stackup` at-temperature mode, which is not built (see TECHNICAL_SPEC §16).
 */

import { defineCommand, z } from '@core/commands/schema';
import { codedRejection, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { explicitCteProvider, isCteRefusal, materialCteProvider, type CteBasis, type CteProvider } from '@core/model/materialCte';
import type { CadDocument } from '@core/model/types';
import { convertValue, isUnitFailure } from '@lib/quantity';
import { toleranceBasis } from '@core/geometry/pmiText';
import { type StackContributor, contributions, rssHalf, worstCaseHalf } from '@lib/stackup';
import { remediationOf } from './refusal';
import { temperatureIn } from './units';

const FORMULA = 'D_i(T) = D_i,spec (1 + a_sec,i (T - T_spec)); gap(T) = sum_i s_i D_i(T)';
const MAX_CONTRIBUTORS = 50;
const MAX_TEMPERATURES = 50;
/** Named default (03 GDT TR-GDT-21 style): a tolerance half-range is this many sigmas for the RSS combination. */
const DEFAULT_SIGMA_PER_HALF_TOLERANCE = 3;

const quantity = z.object({ value: z.number().describe('Value.'), unit: z.string().describe("Unit, e.g. 'degC', 'K', 'degF', '1/K'.") });

const contributorSchema = z.object({
  name: z.string().min(1).describe('Unique contributor name, e.g. "bore depth".'),
  nominal: z
    .number()
    .optional()
    .describe(
      'Nominal dimension in document length units at specTemperature (> 0). Required unless pmiId is given (then measured from the PMI item).',
    ),
  upper: z
    .number()
    .optional()
    .describe('Upper deviation from nominal, document units, at specTemperature (e.g. +0.05). Required unless pmiId is given.'),
  lower: z
    .number()
    .optional()
    .describe('Lower deviation from nominal, document units, at specTemperature; must not exceed upper. Required unless pmiId is given.'),
  pmiId: z
    .string()
    .optional()
    .describe(
      'Id of a 03 GDT size or location dimension (list_pmi): its measured nominal and tolerance become nominal / upper / lower (at specTemperature), and the contributor is verified unless verified: false.',
    ),
  sensitivity: z
    .number()
    .optional()
    .describe(
      'Coefficient of this dimension in the gap: +1 (default) when growing it increases the gap, -1 when it decreases it. Any non-zero real.',
    ),
  material: z
    .string()
    .optional()
    .describe('create_material name whose thermalStrain / cte property model gives the CTE (cte models need cteBasis[material]).'),
  cte: z
    .object({
      alpha: quantity.describe("Secant CTE in 1/K, e.g. { value: 23e-6, unit: '1/K' }. 0 is allowed for a dimension that does not expand."),
      referenceTemperature: quantity.describe('Temperature the secant CTE is referenced to (the datasheet statement).'),
      source: z.string().optional().describe('Where the value comes from (recorded; it stays unverified without a material record).'),
    })
    .optional()
    .describe('Explicit secant CTE (alternative to material).'),
  verified: z
    .boolean()
    .optional()
    .describe(
      'true when the limits are confirmed against their source. Default true for a pmiId-linked contributor, false for typed limits (unverified).',
    ),
});

type Given = z.output<typeof contributorSchema>;
/** A contributor with its limits resolved (typed, or taken from its PMI item). */
type Contributor = Omit<Given, 'nominal' | 'upper' | 'lower'> & { nominal: number; upper: number; lower: number };

const rejection = (doc: CadDocument, code: string, message: string, remediation: string, path: string): CommandResult => ({
  ...codedRejection(doc, 'stackup_at_temperature', code, message, remediation, [], [path]),
  data: { code, reason: message, remediation, path },
});

/** The contributor with its limits resolved: typed, or the measured nominal and tolerance of its 03 PMI dimension; or why it cannot be. */
function resolveContributor(doc: CadDocument, given: Given): Contributor | string {
  const { nominal, upper, lower, pmiId, verified, ...rest } = given;
  if (pmiId === undefined) {
    if (nominal === undefined || upper === undefined || lower === undefined)
      return `contributor '${given.name}' needs nominal, upper and lower (or a pmiId)`;
    return { ...rest, nominal, upper, lower, ...(verified === undefined ? {} : { verified }) };
  }
  const item = doc.pmi !== undefined && Object.hasOwn(doc.pmi.items, pmiId) ? doc.pmi.items[pmiId] : undefined;
  if (item === undefined) return `contributor '${given.name}': no PMI item '${pmiId}' (list_pmi shows the ids)`;
  const basis = toleranceBasis(item);
  if (typeof basis === 'string') return `contributor '${given.name}': ${basis}`;
  return { ...rest, ...basis, verified: verified ?? true };
}

interface Evaluated {
  readonly contributor: Contributor;
  readonly provider: CteProvider;
}

/** Number or null for a quantity in a unit. */
function valueIn(q: { value: number; unit: string }, unit: string): number | null {
  const converted = convertValue(q.value, q.unit, unit);
  return isUnitFailure(converted) ? null : converted.value;
}

/**
 * @affects nothing — read-only; data { unit, specTemperature, rows[{ temperatureKelvin, mean, worstCase{min,max,halfTolerance}, rss{sigma,min,max,halfRange},
 *   shiftFromSpec, contributions[], status?, code?, unverified, reviewRequired, disposition }], specRow, provenance, assumptions, summary }
 * @invariant spec temperature never defaulted; every row reviewRequired; scaling applies to every limit dimension of every contributor
 *   (so the specTemperature row reproduces the typed limits exactly); worst case = sum |s_i| half_i, RSS = sqrt(sum (s_i half_i)^2)
 * @failure TMC_SPEC_TEMPERATURE_MISSING, TMC_FIT_TEMPERATURES_MISSING, TMC_STACKUP_INVALID, TMC_FIT_LIMITS_MISSING, TMC_MATERIAL_NO_CTE,
 *   TMC_CTE_BASIS_UNKNOWN, TMC_CTE_SOURCE_CONFLICT, TMC_PROPERTY_OUT_OF_RANGE, MAT_RECORD_NOT_FOUND -> rejection (unchanged doc)
 */
export const stackupAtTemperature = defineCommand({
  name: 'stackup_at_temperature',
  annotations: { readOnly: true },
  description:
    'Worst-case and RSS gap of a one-dimensional dimension chain at operating temperatures, every contributor expanding with its own CTE. ' +
    'Give contributors { name, nominal, upper, lower, sensitivity (+1 / -1), material (create_material name) or cte (explicit secant ' +
    'alpha with its reference temperature) } in document length units valid at specTemperature, specTemperature (NO default) and ' +
    'temperatures. D(T) = D_spec (1 + a_sec (T - T_spec)) is applied to the nominal and to both limits of each contributor; the gap is ' +
    'sum(sensitivity x dimension). Returns per temperature the mean gap, worst-case min/max, RSS sigma and range (half tolerance / ' +
    "sigmaPerHalfTolerance, default 3), the shift against specTemperature, each contributor's share, and with lowerSpecLimit / upperSpecLimit " +
    'a status (within_worst_case, within_rss_only, outside) and code TMC_STACKUP_WC_EXCEEDED / TMC_STACKUP_OUT_OF_SPEC. Typed limits are ' +
    'unverified unless verified is true; every row needs review by a qualified engineer. Use it for gap, float or preload stack-ups of mixed ' +
    'materials; for a two-part hole/shaft fit use fit_at_temperature.',
  params: z.object({
    contributors: z.array(contributorSchema).describe(`The dimension chain, 1 to ${MAX_CONTRIBUTORS} contributors.`),
    specTemperature: quantity
      .optional()
      .describe('REQUIRED, never defaulted: temperature the limits apply at, e.g. { value: 20, unit: "degC" }.'),
    temperatures: z
      .array(quantity)
      .optional()
      .describe(`Operating temperatures (every contributor at the same temperature), 1 to ${MAX_TEMPERATURES}.`),
    cteBasis: z
      .record(
        z.string(),
        z.object({
          kind: z
            .enum(['secant', 'instantaneous'])
            .describe('secant: alpha(T) is referenced to referenceTemperature; instantaneous: d(strain)/dT.'),
          referenceTemperature: quantity.optional().describe('Required when kind is secant.'),
        }),
      )
      .optional()
      .describe('Basis of the cte model per material name (PHY-01 models carry no basis field).'),
    lowerSpecLimit: z.number().optional().describe('Smallest acceptable gap, document units (optional).'),
    upperSpecLimit: z.number().optional().describe('Largest acceptable gap, document units (optional).'),
    sigmaPerHalfTolerance: z
      .number()
      .positive()
      .optional()
      .describe(
        `Sigmas in a tolerance half-range for the RSS combination. Default ${DEFAULT_SIGMA_PER_HALF_TOLERANCE} (named in the result).`,
      ),
  }),
  run: (doc, params): CommandResult => {
    const { contributors: given, specTemperature } = params;
    if (specTemperature === undefined)
      return rejection(
        doc,
        'TMC_SPEC_TEMPERATURE_MISSING',
        'specTemperature is required (the temperature the limits apply at)',
        remediationOf('TMC_SPEC_TEMPERATURE_MISSING'),
        'specTemperature',
      );
    const specKelvin = temperatureIn(specTemperature, 'K');
    if (specKelvin === null || !(specKelvin > 0))
      return rejection(
        doc,
        'THM_UNITS_MISMATCH',
        'specTemperature has an invalid unit or is at or below absolute zero',
        remediationOf('THM_UNITS_MISMATCH'),
        'specTemperature.unit',
      );
    const temperatures = params.temperatures ?? [];
    if (temperatures.length === 0 || temperatures.length > MAX_TEMPERATURES)
      return rejection(
        doc,
        'TMC_FIT_TEMPERATURES_MISSING',
        temperatures.length === 0
          ? 'no operating temperature given'
          : `${temperatures.length} temperatures exceed the limit of ${MAX_TEMPERATURES}`,
        `give 1 to ${MAX_TEMPERATURES} temperatures`,
        'temperatures',
      );
    const kelvins: number[] = [];
    for (const temperature of temperatures) {
      const kelvin = temperatureIn(temperature, 'K');
      if (kelvin === null || !(kelvin > 0))
        return rejection(
          doc,
          'THM_UNITS_MISMATCH',
          'a temperature has an invalid unit or is at or below absolute zero',
          remediationOf('THM_UNITS_MISMATCH'),
          'temperatures',
        );
      kelvins.push(kelvin);
    }
    if (given.length === 0 || given.length > MAX_CONTRIBUTORS)
      return rejection(
        doc,
        'TMC_STACKUP_INVALID',
        `1 to ${MAX_CONTRIBUTORS} contributors are needed, got ${given.length}`,
        remediationOf('TMC_STACKUP_INVALID'),
        'contributors',
      );
    const contributors: Contributor[] = [];
    for (const [index, entry] of given.entries()) {
      const resolved = resolveContributor(doc, entry);
      if (typeof resolved === 'string')
        return rejection(doc, 'TMC_STACKUP_INVALID', resolved, remediationOf('TMC_STACKUP_INVALID'), `contributors[${index}]`);
      contributors.push(resolved);
    }
    const names = new Set<string>();
    for (const [index, contributor] of contributors.entries()) {
      const where = `contributors[${index}]`;
      if (names.has(contributor.name))
        return rejection(
          doc,
          'TMC_STACKUP_INVALID',
          `contributor name '${contributor.name}' is used twice`,
          remediationOf('TMC_STACKUP_INVALID'),
          `${where}.name`,
        );
      names.add(contributor.name);
      if (
        !(contributor.nominal > 0) ||
        !(contributor.upper >= contributor.lower) ||
        contributor.sensitivity === 0 ||
        !Number.isFinite(contributor.sensitivity ?? 1)
      )
        return rejection(
          doc,
          'TMC_FIT_LIMITS_MISSING',
          `contributor '${contributor.name}': nominal must be > 0, upper >= lower, sensitivity non-zero`,
          'fix the limits of the contributor',
          where,
        );
    }
    const { lowerSpecLimit, upperSpecLimit } = params;
    if (lowerSpecLimit !== undefined && upperSpecLimit !== undefined && lowerSpecLimit > upperSpecLimit)
      return rejection(
        doc,
        'TMC_STACKUP_INVALID',
        'lowerSpecLimit exceeds upperSpecLimit',
        remediationOf('TMC_STACKUP_INVALID'),
        'lowerSpecLimit',
      );

    const bases = new Map<string, CteBasis>();
    for (const [name, given] of Object.entries(params.cteBasis ?? {})) {
      const reference = given.referenceTemperature === undefined ? null : temperatureIn(given.referenceTemperature, 'K');
      bases.set(
        name,
        given.kind === 'instantaneous'
          ? { kind: 'instantaneous' }
          : reference === null
            ? { kind: 'unstated' }
            : { kind: 'secant', referenceKelvin: reference },
      );
    }
    const evaluated: Evaluated[] = [];
    for (const [index, contributor] of contributors.entries()) {
      const where = `contributors[${index}]`;
      if (contributor.material !== undefined && contributor.cte !== undefined)
        return rejection(
          doc,
          'TMC_CTE_SOURCE_CONFLICT',
          `contributor '${contributor.name}' gives both material and cte`,
          'give either material or cte',
          `${where}.cte`,
        );
      if (contributor.cte !== undefined) {
        const alpha = valueIn(contributor.cte.alpha, '1/K');
        const reference = temperatureIn(contributor.cte.referenceTemperature, 'K');
        if (alpha === null || reference === null)
          return rejection(
            doc,
            'THM_UNITS_MISMATCH',
            `contributor '${contributor.name}': cte.alpha must be in 1/K and the reference a temperature`,
            'give alpha in 1/K and a temperature unit',
            `${where}.cte`,
          );
        evaluated.push({ contributor, provider: explicitCteProvider(alpha, reference, contributor.cte.source ?? '') });
        continue;
      }
      if (contributor.material === undefined)
        return rejection(
          doc,
          'TMC_MATERIAL_NO_CTE',
          `contributor '${contributor.name}' has neither a material nor an explicit CTE`,
          remediationOf('TMC_MATERIAL_NO_CTE'),
          where,
        );
      const provider = materialCteProvider(
        doc.materials,
        contributor.material,
        bases.get(contributor.material) ?? { kind: 'unstated' },
        `${where}.material`,
      );
      if (isCteRefusal(provider))
        return {
          ...codedRejection(doc, 'stackup_at_temperature', provider.code, provider.reason, provider.remediation, [], [provider.path]),
          data: { ...provider },
        };
      evaluated.push({ contributor, provider });
    }

    const k = params.sigmaPerHalfTolerance ?? DEFAULT_SIGMA_PER_HALF_TOLERANCE;
    const rowAt = (kelvin: number): { row: Row } | CommandResult => {
      const parts: Part[] = [];
      const reasons = new Set<string>();
      for (const { contributor, provider } of evaluated) {
        const strain = provider.strainAt(kelvin, specKelvin);
        if (isCteRefusal(strain))
          return {
            ...codedRejection(doc, 'stackup_at_temperature', strain.code, strain.reason, strain.remediation, [], [strain.path]),
            data: { ...strain },
          };
        strain.unverifiedReasons.forEach((reason) => reasons.add(`${contributor.name}: ${reason}`));
        if (contributor.verified !== true) reasons.add(`${contributor.name}: typed limits, not confirmed against their source`);
        const scale = 1 + strain.strain;
        const low = (contributor.nominal + contributor.lower) * scale;
        const high = (contributor.nominal + contributor.upper) * scale;
        const sensitivity = contributor.sensitivity ?? 1;
        parts.push({ name: contributor.name, sensitivity, strain: strain.strain, mid: (low + high) / 2, half: (high - low) / 2 });
      }
      return { row: combine(parts, kelvin, k, [...reasons], lowerSpecLimit, upperSpecLimit) };
    };
    const base = rowAt(specKelvin);
    if (!('row' in base)) return base;
    const rows: Row[] = [];
    for (const kelvin of kelvins) {
      const built = rowAt(kelvin);
      if (!('row' in built)) return built;
      rows.push({ ...built.row, shiftFromSpec: built.row.mean - base.row.mean });
    }
    const flagged = rows.filter((row) => row.code !== undefined);
    const gap = (value: number): string => value.toPrecision(6);
    const summary =
      `stackup_at_temperature: ${evaluated.length} contributor(s), ${rows.length} temperature(s); at spec the gap is ${gap(base.row.mean)} ${doc.units} (worst case ${gap(base.row.worstCase.min)} … ${gap(base.row.worstCase.max)}); ` +
      `mean gap ${gap(Math.min(...rows.map((row) => row.mean)))} … ${gap(Math.max(...rows.map((row) => row.mean)))} ${doc.units} over the temperatures, worst case ${gap(Math.min(...rows.map((row) => row.worstCase.min)))} … ${gap(Math.max(...rows.map((row) => row.worstCase.max)))}; ` +
      `${flagged.length === 0 ? (lowerSpecLimit === undefined && upperSpecLimit === undefined ? 'no spec limit given' : 'no row violates the spec limits') : `${flagged.length} row(s) flagged ${[...new Set(flagged.map((row) => row.code))].join(', ')} (pending human disposition)`}` +
      `${rows.some((row) => row.unverified) ? '; unverified inputs' : ''}; every row needs review by a qualified engineer.`;
    return report(doc, summary, {
      unit: doc.units,
      specTemperature,
      specRow: base.row,
      rows,
      provenance: {
        formula: FORMULA,
        sigmaPerHalfTolerance: {
          value: k,
          source: 'llull named default (03 GDT sigmaPerHalfTolerance)',
          defaulted: params.sigmaPerHalfTolerance === undefined,
        },
        cte: evaluated.map(({ contributor, provider }) => ({
          contributor: contributor.name,
          source: provider.source,
          basis: provider.basis,
          conversion: provider.conversion,
        })),
        contributors: contributors.map(({ name, nominal, upper, lower, sensitivity }) => ({
          name,
          nominal,
          upper,
          lower,
          sensitivity: sensitivity ?? 1,
        })),
      },
      assumptions: [
        'one-dimensional chain: each dimension expands linearly with its secant CTE from the specification temperature',
        'uniform temperature per row, equal for every contributor; no elastic deformation, form error, gradient or assembly clearance',
        'worst case = sum of |sensitivity| x half tolerance; RSS = sqrt of the sum of (sensitivity x half tolerance)^2 (normal, k sigma per half tolerance)',
        'worst case, RSS and contribution shares are the 03 GDT stack-up formulas (lib/stackup.ts); limits are typed (unverified unless verified is true) or linked to a PMI dimension by pmiId; Monte Carlo and expression stacks are analyze_stackup (not at temperature)',
      ],
      summary,
    });
  },
});

interface Part {
  readonly name: string;
  readonly sensitivity: number;
  readonly strain: number;
  readonly mid: number;
  readonly half: number;
}

interface Row {
  readonly temperatureKelvin: number;
  readonly mean: number;
  readonly worstCase: { readonly min: number; readonly max: number; readonly halfTolerance: number };
  readonly rss: { readonly sigma: number; readonly min: number; readonly max: number; readonly halfRange: number };
  readonly shiftFromSpec: number;
  readonly contributions: ReadonlyArray<{
    readonly name: string;
    readonly thermalStrain: number;
    readonly scaledNominal: number;
    readonly halfTolerance: number;
    readonly wcPercent: number;
    readonly rssPercent: number;
  }>;
  readonly status?: 'within_worst_case' | 'within_rss_only' | 'outside';
  readonly code?: 'TMC_STACKUP_WC_EXCEEDED' | 'TMC_STACKUP_OUT_OF_SPEC';
  readonly unverified: boolean;
  readonly unverifiedReasons: readonly string[];
  readonly reviewRequired: true;
  readonly disposition: 'none' | 'pending_human';
}

/** Chain statistics of the scaled contributors at one temperature (pure). */
function combine(parts: readonly Part[], kelvin: number, k: number, reasons: readonly string[], lower?: number, upper?: number): Row {
  const mean = parts.reduce((sum, part) => sum + part.sensitivity * part.mid, 0);
  const chain = parts.map(
    (part): StackContributor => ({
      name: part.name,
      nominal: part.mid,
      lower: -part.half,
      upper: part.half,
      sensitivity: part.sensitivity,
      distribution: 'normal',
    }),
  );
  const wc = worstCaseHalf(chain);
  const rss = rssHalf(chain);
  const shares = contributions(chain, k);
  const within = (half: number): boolean => (lower === undefined || mean - half >= lower) && (upper === undefined || mean + half <= upper);
  const limited = lower !== undefined || upper !== undefined;
  const status = !limited ? undefined : within(wc) ? 'within_worst_case' : within(rss) ? 'within_rss_only' : 'outside';
  const code = status === 'within_rss_only' ? 'TMC_STACKUP_WC_EXCEEDED' : status === 'outside' ? 'TMC_STACKUP_OUT_OF_SPEC' : undefined;
  return {
    temperatureKelvin: kelvin,
    mean,
    worstCase: { min: mean - wc, max: mean + wc, halfTolerance: wc },
    rss: { sigma: rss / k, min: mean - rss, max: mean + rss, halfRange: rss },
    shiftFromSpec: 0,
    contributions: parts.map((part, index) => ({
      name: part.name,
      thermalStrain: part.strain,
      scaledNominal: part.mid,
      halfTolerance: part.half,
      wcPercent: shares[index]?.wcPercent ?? 0,
      rssPercent: shares[index]?.rssPercent ?? 0,
    })),
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    unverified: reasons.length > 0,
    unverifiedReasons: reasons,
    reviewRequired: true,
    disposition: code !== undefined ? 'pending_human' : 'none',
  };
}
