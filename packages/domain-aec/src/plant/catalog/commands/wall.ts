/** `pipe_wall_check` (plant 01 PSC M4): ASME B31.3 eq. (3a) pressure design thickness and the lightest schedule that meets it. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { BUNDLED_CATALOG_ID } from '../bundled';
import { refuse } from '../codes';
import { sizePair } from '../nominal';
import { BAR_PER_PSI } from '../ptRating';
import { findCatalog } from '../store';
import type { ComponentSize, NominalSize } from '../types';
import { pressureDesignWall } from '../wallDesign';

const nominalParam = z.union([z.number(), z.string()]);
const MM_PER_INCH = 25.4;
const PRESSURE_UNITS = ['bar', 'psi', 'MPa'] as const;

/** MPa from a value in `unit` (gauge pressure or stress). */
const toMPa = (value: number, unit: (typeof PRESSURE_UNITS)[number]): number =>
  unit === 'psi' ? value * BAR_PER_PSI * 0.1 : unit === 'bar' ? value * 0.1 : value;

const quantity = (what: string): z.ZodType<{ value: number; unit: (typeof PRESSURE_UNITS)[number] }> =>
  z.object({ value: z.number().describe(`${what}: value.`), unit: z.enum(PRESSURE_UNITS).describe('bar, psi or MPa.') });

interface Candidate {
  readonly schedule: string;
  readonly wallMm: number;
  readonly verified: boolean;
}

const isNumbered = (schedule: string): boolean => /^\d+S?$/.test(schedule);

/** Lightest first; equal walls: numbered schedules before STD / XS / XXS, then by label. */
const byWeight = (a: Candidate, b: Candidate): number =>
  a.wallMm - b.wallMm || Number(isNumbered(b.schedule)) - Number(isNumbered(a.schedule)) || (a.schedule < b.schedule ? -1 : 1);

const normalise = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, '');

const sameNps = (size: ComponentSize, nps: NominalSize): boolean => size.size.system === 'NPS' && size.size.key === nps.key;

/**
 * @affects none; data = { pressureThicknessMm, minimumThicknessMm, requiredNominalMm, selectedSchedule?, selectedWallMm, lightestSchedule?, candidates, validity, provenance, reviewRequired }
 * @invariant read-only; every input explicit (nothing defaulted); eq. (3a) only for t < D/6 and P/(S E) <= 0.385, else refused; reviewRequired is always true
 * @failure missing S, E, W, Y, c or mill tolerance -> PSC_ALLOWABLE_MISSING; factor outside its range -> PSC_WALL_INPUT_RANGE; t >= D/6 or P/(S E) > 0.385 -> PSC_WALL_THICK_PIPE; wall below the requirement -> PSC_WALL_INSUFFICIENT; unknown size / schedule -> PSC_SIZE_UNKNOWN / PSC_SCHEDULE_UNKNOWN / PSC_CATALOG_ROW_MISSING
 */
export const pipeWallCheck = defineCommand({
  name: 'pipe_wall_check',
  description:
    'Pressure design wall of straight steel pipe under INTERNAL pressure, ASME B31.3 304.1.2 equation (3a): t = P D / (2 (S E W + P Y)), then tm = t + corrosion allowance and the required nominal wall = tm / (1 - mill tolerance). ' +
    'Give the size as nps / dn (outside diameter and schedules from the catalogue, ASME B36.10M by default, or standard "ASME B36.19M") or as odMm (no schedule choice). ' +
    'Nothing is defaulted (safety data): pressure (gauge), allowableStress S, jointFactorE, weldStrengthW, coefficientY, corrosionAllowance and millTolerance (fraction, 0.125 = 12.5 % for seamless pipe, 0 = none) must all be given, else PSC_ALLOWABLE_MISSING; allowable stresses are not shipped (take S from B31.3 Table A-1). ' +
    'The formula is used only where it is defined: t < D/6 and P/(S E) <= 0.385 (else PSC_WALL_THICK_PIPE, thick-wall design needs an engineer), E and W in (0, 1], Y in [0, 0.7], tolerance in [0, 0.5) (else PSC_WALL_INPUT_RANGE). External pressure, bends, branches and creep are out of scope. ' +
    'Without schedule / wallMm it returns the lightest schedule whose wall is at least the required nominal (ties: numbered schedule first); with schedule or wallMm it checks that wall (PSC_WALL_INSUFFICIENT, the lightest sufficient schedule in error.detail). ' +
    'Example: NPS 4, 1200 psi, S 19000 psi, E = W = 1, Y 0.4, c 3 mm, 12.5 %: t 3.5205 mm, required 7.452 mm, Sch 80. Always reviewRequired: a qualified engineer confirms. Next: edit_pipe_spec to put the schedule in a spec.',
  params: z.object({
    nps: nominalParam
      .describe('Nominal pipe size, inch designation ("4", "2-1/2") or number. Give exactly one of nps, dn, odMm.')
      .optional(),
    dn: nominalParam.describe('Nominal diameter DN (converted to NPS for the catalogue).').optional(),
    odMm: z
      .number()
      .positive()
      .describe('Outside diameter in mm, when the size is not a catalogue size (no schedule selection; give wallMm to check a wall).')
      .optional(),
    standard: z
      .string()
      .min(1)
      .describe(
        'Pipe standard whose schedules are searched: "ASME B36.10M" (default) or "ASME B36.19M"; "EN 10220" with an imported catalogue that holds its walls.',
      )
      .optional(),
    catalogId: z.string().describe('Catalogue id (list_piping_catalogs). Default: the bundled llull-open-piping.').optional(),
    schedule: z.string().describe('Check this schedule ("40", "XS", "10S") instead of selecting one.').optional(),
    wallMm: z.number().positive().describe('Check this nominal wall in mm instead of selecting a schedule.').optional(),
    pressure: quantity('Internal design pressure, gauge').describe('Internal design pressure (gauge) with its unit (bar, psi, MPa).'),
    allowableStress: quantity('Allowable stress S at design temperature')
      .describe('Allowable stress S at the design temperature with its unit, from B31.3 Table A-1 (not shipped).')
      .optional(),
    jointFactorE: z.number().describe('Quality factor E in (0, 1] (B31.3 Table A-1B).').optional(),
    weldStrengthW: z
      .number()
      .describe('Weld joint strength reduction factor W in (0, 1] (B31.3 302.3.5; 1 below the creep range).')
      .optional(),
    coefficientY: z
      .number()
      .describe('Coefficient Y in [0, 0.7] (B31.3 Table 304.1.1: 0.4 ferritic steel up to 482 degC, 0.5 austenitic up to 566 degC).')
      .optional(),
    corrosionAllowance: z
      .object({ value: z.number().describe('Allowance value, >= 0.'), unit: z.enum(['mm', 'in']).describe('mm or in.') })
      .describe('Corrosion / erosion / thread allowance c with its unit.')
      .optional(),
    millTolerance: z
      .number()
      .describe('Mill under-tolerance as a fraction of the nominal wall in [0, 0.5): 0.125 for seamless pipe, 0 for none.')
      .optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const fail = (
      code: string,
      message: string,
      paths: readonly string[] = [],
      ids: readonly string[] = [],
      detail?: Record<string, unknown>,
    ): CommandResult => refuse(doc, 'pipe_wall_check', code, message, ids, paths, detail);
    const { allowableStress, jointFactorE, weldStrengthW, coefficientY, corrosionAllowance, millTolerance } = params;
    const missing = (
      ['allowableStress', 'jointFactorE', 'weldStrengthW', 'coefficientY', 'corrosionAllowance', 'millTolerance'] as const
    ).filter((name) => params[name] === undefined);
    if (
      missing.length > 0 ||
      allowableStress === undefined ||
      jointFactorE === undefined ||
      weldStrengthW === undefined ||
      coefficientY === undefined ||
      corrosionAllowance === undefined ||
      millTolerance === undefined
    )
      return fail('PSC_ALLOWABLE_MISSING', `give ${missing.join(', ')} explicitly (nothing is defaulted for pressure design)`, missing);
    if ([params.nps, params.dn, params.odMm].filter((value) => value !== undefined).length !== 1)
      return fail('PSC_SIZE_UNKNOWN', 'give exactly one of nps, dn, odMm', ['nps']);
    if (params.schedule !== undefined && params.wallMm !== undefined)
      return fail('PSC_WALL_INPUT_RANGE', 'give schedule or wallMm, not both', ['schedule']);
    const standard = params.standard ?? 'ASME B36.10M';

    let odMm: number;
    let candidates: Candidate[] = [];
    let sizeNote: string | undefined;
    if (params.odMm !== undefined) {
      odMm = params.odMm;
      if (params.schedule !== undefined)
        return fail('PSC_SCHEDULE_UNKNOWN', 'a schedule needs a nominal size (nps / dn), not odMm', ['schedule']);
    } else {
      const pair = sizePair({ nps: params.nps, dn: params.dn });
      if (pair === null || pair.nps === null)
        return fail('PSC_SIZE_UNKNOWN', 'nps / dn is not a nominal size with an NPS pairing', ['nps']);
      const nps = pair.nps;
      const reference = params.catalogId ?? BUNDLED_CATALOG_ID;
      const catalog = findCatalog(doc, reference);
      if (catalog === undefined) return fail('PSC_CATALOG_UNKNOWN', `no catalogue "${reference}"`, ['catalogId'], [reference]);
      const rows = catalog.families
        .filter((family) => family.type === 'pipe' && normalise(family.standard) === normalise(standard))
        .flatMap((family) => family.sizes.filter((size) => sameNps(size, nps)));
      const od = rows.find((row) => row.dims['outsideDiameter'] !== undefined)?.dims['outsideDiameter'];
      if (od === undefined)
        return fail(
          'PSC_CATALOG_ROW_MISSING',
          `catalogue ${catalog.id} has no ${standard} pipe row for NPS ${nps.key}; give odMm (and wallMm) instead`,
          ['nps'],
        );
      odMm = od.value;
      candidates = rows.flatMap((row) => {
        const wall = row.dims['wall'];
        return wall === undefined || row.schedule === undefined
          ? []
          : [{ schedule: row.schedule, wallMm: wall.value, verified: wall.verified && od.verified }];
      });
      sizeNote = `${standard} NPS ${nps.key}`;
    }
    if (params.schedule !== undefined && !candidates.some((candidate) => candidate.schedule === params.schedule))
      return fail(
        'PSC_SCHEDULE_UNKNOWN',
        `${sizeNote ?? 'pipe'} has no schedule "${params.schedule}" (schedules there: ${candidates.map((candidate) => candidate.schedule).join(', ') || 'none'})`,
        ['schedule'],
      );

    const pressureMPa = toMPa(params.pressure.value, params.pressure.unit);
    const allowableStressMPa = toMPa(allowableStress.value, allowableStress.unit);
    const outcome = pressureDesignWall({
      outsideDiameterMm: odMm,
      pressureMPa,
      allowableStressMPa,
      jointFactorE,
      weldStrengthW,
      coefficientY,
      corrosionAllowanceMm: corrosionAllowance.unit === 'in' ? corrosionAllowance.value * MM_PER_INCH : corrosionAllowance.value,
      millTolerance,
    });
    if (!outcome.ok) return fail(outcome.code, outcome.message, [outcome.path]);
    const { design } = outcome;
    const required = design.requiredNominalMm;
    const ordered = [...candidates].sort(byWeight);
    const sufficient = ordered.filter((candidate) => candidate.wallMm >= required);
    const lightest = sufficient[0];
    const chosen: { readonly schedule?: string; readonly wallMm: number; readonly verified: boolean } | undefined =
      params.wallMm !== undefined
        ? { wallMm: params.wallMm, verified: true }
        : params.schedule !== undefined
          ? ordered.find((candidate) => candidate.schedule === params.schedule)
          : lightest;
    const head = `pipe_wall_check: ${sizeNote ?? 'pipe'} OD ${odMm} mm: t ${design.pressureThicknessMm.toFixed(4)} mm, tm ${design.minimumThicknessMm.toFixed(4)} mm, required nominal ${required.toFixed(4)} mm`;
    const common = {
      outsideDiameterMm: odMm,
      pressureThicknessMm: design.pressureThicknessMm,
      corrosionAllowanceMm: design.minimumThicknessMm - design.pressureThicknessMm,
      minimumThicknessMm: design.minimumThicknessMm,
      requiredNominalMm: required,
      validity: {
        thinWallLimitMm: design.thinWallLimitMm,
        pressureStressRatio: design.pressureStressRatio,
        rule: 't < D/6 and P/(S E) <= 0.385',
      },
      reviewRequired: true,
      provenance: {
        formula: 'ASME B31.3 304.1.2 eq. (3a): t = P D / (2 (S E W + P Y)); tm = t + c; nominal = tm / (1 - mill tolerance)',
        standard,
        inputs: { pressureMPa, allowableStressMPa, jointFactorE, weldStrengthW, coefficientY, millTolerance },
      },
    };
    if (candidates.length === 0 && params.wallMm === undefined)
      return report(doc, `${head}; no schedule list for an odMm size: give wallMm to check a wall; reviewRequired.`, common);
    if (chosen === undefined || chosen.wallMm < required) {
      const heaviest = ordered.at(-1);
      return fail(
        'PSC_WALL_INSUFFICIENT',
        chosen === undefined
          ? `${head}; no ${standard} schedule at this size reaches it (heaviest ${heaviest?.schedule ?? 'none'} ${heaviest?.wallMm ?? 'n/a'} mm)`
          : `${head}; ${chosen.schedule === undefined ? 'wall' : `schedule ${chosen.schedule}`} ${chosen.wallMm} mm is below it`,
        [params.schedule === undefined ? 'wallMm' : 'schedule'],
        [],
        {
          requiredNominalMm: required,
          pressureThicknessMm: design.pressureThicknessMm,
          checkedWallMm: chosen?.wallMm ?? null,
          ...(lightest === undefined ? {} : { lightestSchedule: lightest.schedule, lightestWallMm: lightest.wallMm }),
          reviewRequired: true,
        },
      );
    }
    const warnings = chosen.verified ? [] : [{ code: 'PSC_DATA_UNVERIFIED', schedule: chosen.schedule ?? null }];
    const picked =
      chosen.schedule === undefined
        ? `wall ${chosen.wallMm} mm is sufficient`
        : `${params.schedule === undefined ? 'lightest schedule' : 'schedule'} ${chosen.schedule} (${chosen.wallMm} mm)`;
    return report(doc, `${head}; ${picked}${chosen.verified ? '' : '; UNVERIFIED (PSC_DATA_UNVERIFIED)'}; reviewRequired.`, {
      ...common,
      ...(chosen.schedule === undefined ? {} : { selectedSchedule: chosen.schedule }),
      selectedWallMm: chosen.wallMm,
      marginMm: chosen.wallMm - required,
      ...(lightest === undefined ? {} : { lightestSchedule: lightest.schedule, lightestWallMm: lightest.wallMm }),
      candidates: sufficient.slice(0, 8),
      verified: chosen.verified,
      ...(warnings.length === 0 ? {} : { warnings }),
    });
  },
});
