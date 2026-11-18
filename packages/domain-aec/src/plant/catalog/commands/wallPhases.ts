import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { BUNDLED_CATALOG_ID } from '../bundled';
import { refuse } from '../codes';
import { sizePair } from '../nominal';
import { BAR_PER_PSI } from '../ptRating';
import { findCatalog } from '../store';
import type { ComponentSize, NominalSize } from '../types';
import { pressureDesignWall } from '../wallDesign';

const MM_PER_INCH = 25.4;

export type PressureUnit = 'bar' | 'psi' | 'MPa';

/** MPa from a value in `unit` (gauge pressure or stress). */
const toMPa = (value: number, unit: PressureUnit): number =>
  unit === 'psi' ? value * BAR_PER_PSI * 0.1 : unit === 'bar' ? value * 0.1 : value;

interface Quantity {
  readonly value: number;
  readonly unit: PressureUnit;
}

export interface WallParams {
  readonly nps?: string | number | undefined;
  readonly dn?: string | number | undefined;
  readonly odMm?: number | undefined;
  readonly standard?: string | undefined;
  readonly catalogId?: string | undefined;
  readonly schedule?: string | undefined;
  readonly wallMm?: number | undefined;
  readonly pressure: Quantity;
  readonly allowableStress?: Quantity | undefined;
  readonly jointFactorE?: number | undefined;
  readonly weldStrengthW?: number | undefined;
  readonly coefficientY?: number | undefined;
  readonly corrosionAllowance?: { readonly value: number; readonly unit: 'mm' | 'in' } | undefined;
  readonly millTolerance?: number | undefined;
}

export interface Problem {
  readonly problem: {
    readonly code: string;
    readonly message: string;
    readonly paths: readonly string[];
    readonly ids?: readonly string[];
  };
}

export const isProblem = (value: object): value is Problem => 'problem' in value;

const problem = (code: string, message: string, paths: readonly string[], ids?: readonly string[]): Problem => ({
  problem: { code, message, paths, ...(ids === undefined ? {} : { ids }) },
});

export interface Candidate {
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

export interface DesignInputs {
  readonly allowableStress: Quantity;
  readonly jointFactorE: number;
  readonly weldStrengthW: number;
  readonly coefficientY: number;
  readonly corrosionAllowance: { readonly value: number; readonly unit: 'mm' | 'in' };
  readonly millTolerance: number;
}

/** The explicit design inputs (nothing is defaulted), or the problem when one is missing or the size / wall selection is ambiguous. */
export function designInputs(params: WallParams): DesignInputs | Problem {
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
    return problem('PSC_ALLOWABLE_MISSING', `give ${missing.join(', ')} explicitly (nothing is defaulted for pressure design)`, missing);
  if ([params.nps, params.dn, params.odMm].filter((value) => value !== undefined).length !== 1)
    return problem('PSC_SIZE_UNKNOWN', 'give exactly one of nps, dn, odMm', ['nps']);
  if (params.schedule !== undefined && params.wallMm !== undefined)
    return problem('PSC_WALL_INPUT_RANGE', 'give schedule or wallMm, not both', ['schedule']);
  return { allowableStress, jointFactorE, weldStrengthW, coefficientY, corrosionAllowance, millTolerance };
}

export interface PipeSize {
  readonly odMm: number;
  readonly candidates: Candidate[];
  readonly sizeNote: string | undefined;
}

/** The outside diameter and schedule candidates of the requested size, or the problem when it is unknown. */
export function resolveSize(doc: CadDocument, params: WallParams, standard: string): PipeSize | Problem {
  let odMm: number;
  let candidates: Candidate[] = [];
  let sizeNote: string | undefined;
  if (params.odMm !== undefined) {
    odMm = params.odMm;
    if (params.schedule !== undefined)
      return problem('PSC_SCHEDULE_UNKNOWN', 'a schedule needs a nominal size (nps / dn), not odMm', ['schedule']);
  } else {
    const pair = sizePair({ nps: params.nps, dn: params.dn });
    if (pair === null || pair.nps === null)
      return problem('PSC_SIZE_UNKNOWN', 'nps / dn is not a nominal size with an NPS pairing', ['nps']);
    const nps = pair.nps;
    const reference = params.catalogId ?? BUNDLED_CATALOG_ID;
    const catalog = findCatalog(doc, reference);
    if (catalog === undefined) return problem('PSC_CATALOG_UNKNOWN', `no catalogue "${reference}"`, ['catalogId'], [reference]);
    const rows = catalog.families
      .filter((family) => family.type === 'pipe' && normalise(family.standard) === normalise(standard))
      .flatMap((family) => family.sizes.filter((size) => sameNps(size, nps)));
    const od = rows.find((row) => row.dims['outsideDiameter'] !== undefined)?.dims['outsideDiameter'];
    if (od === undefined)
      return problem(
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
    return problem(
      'PSC_SCHEDULE_UNKNOWN',
      `${sizeNote ?? 'pipe'} has no schedule "${params.schedule}" (schedules there: ${candidates.map((candidate) => candidate.schedule).join(', ') || 'none'})`,
      ['schedule'],
    );
  return { odMm, candidates, sizeNote };
}

/** The pressure design wall and the schedule verdict: selected schedule or checked wall, or the coded refusal. */
export function wallReport(doc: CadDocument, params: WallParams, inputs: DesignInputs, size: PipeSize, standard: string): CommandResult {
  const fail = (
    code: string,
    message: string,
    paths: readonly string[] = [],
    ids: readonly string[] = [],
    detail?: Record<string, unknown>,
  ): CommandResult => refuse(doc, 'pipe_wall_check', code, message, ids, paths, detail);
  const { allowableStress, jointFactorE, weldStrengthW, coefficientY, corrosionAllowance, millTolerance } = inputs;
  const { odMm, candidates, sizeNote } = size;
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
}
