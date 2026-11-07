// Typed reader over the `data` of check_verification (PHY-00): the studies of one analysis with their re-derived report, the check items and the
// exceptions a qualified reviewer accepted. Returns null when the command refused (the caller shows its summary). Nothing is computed here: every
// number is the command's; levels come from the document's recorded study.

import { isRecord } from '@lib/isRecord';
import type { StudyRefinement } from '@core/model/convergenceStudy';
import type { AnalysisCase } from '@core/model/analysis';

export type VerificationStatus = 'pass' | 'warn' | 'fail';
export type StudyStateName = 'current' | 'stale' | 'unverifiable' | 'untrusted';

export interface VerificationItemView {
  readonly code: string;
  readonly severity: 'error' | 'fail' | 'warning';
  readonly message: string;
  readonly remediation: string;
  /** The reviewer's acceptance (signature re-verified by the signing port now); absent = the finding stands. */
  readonly accepted: { readonly signer: string; readonly signatureId: string; readonly justification: string } | null;
}

interface LsqView {
  readonly method: string;
  readonly p: number;
  readonly f0: number;
  readonly standardErrorP: number | null;
  readonly standardDeviation: number;
  readonly rss: number;
  readonly degreesOfFreedom: number;
  readonly uncertaintyAbsolute: number;
  /** A FRACTION of the finest value (0.01 = 1 %); null when the finest value is 0. */
  readonly uncertaintyRelative: number | null;
}

export interface ReportView {
  readonly status: string;
  /** 'celik2008-gci' (3 levels), 'eca-hoekstra-lsq' (4 or more), 'order-difference' (an order study). */
  readonly method: string;
  readonly p: number | null;
  readonly extrapolated: number | null;
  /** GCI21 of the finest level, a FRACTION. */
  readonly gciFine: number | null;
  readonly gciAbs: number | null;
  readonly asymptoticRatio: number | null;
  readonly lsq: LsqView | null;
  readonly orderPair: {
    readonly quadratic: number;
    readonly linear: number;
    readonly absolute: number;
    readonly relative: number | null;
  } | null;
  readonly exception: { readonly code: string; readonly signer: string; readonly justification: string } | null;
}

export interface StudyView {
  readonly id: string;
  readonly refinement: StudyRefinement;
  readonly quantity: string;
  readonly unit: string;
  readonly state: StudyStateName;
  readonly levels: number;
  readonly codes: readonly string[];
  readonly reviewRequired: boolean;
  readonly reviewReasons: readonly string[];
  readonly unverified: boolean;
  /** Numbers of a CURRENT study only. */
  readonly report: ReportView | null;
}

export interface VerificationView {
  readonly status: VerificationStatus;
  readonly items: readonly VerificationItemView[];
  readonly studies: readonly StudyView[];
  readonly reviewRequired: boolean;
  readonly gciTarget: number | null;
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const isRefinement = (value: unknown): value is StudyRefinement => value === 'h' || value === 'dt' || value === 'p';
const isState = (value: unknown): value is StudyStateName =>
  value === 'current' || value === 'stale' || value === 'unverifiable' || value === 'untrusted';

/** The quantity of a study as one line: probe:ID (load case), von Mises of a load case, a mode. */
export function quantityText(quantity: unknown): string {
  if (!isRecord(quantity)) return '?';
  switch (quantity['kind']) {
    case 'probe':
      return `probe ${str(quantity['probeId'])}${typeof quantity['loadCase'] === 'string' ? ` (${quantity['loadCase']})` : ''}`;
    case 'field_max':
      return `max ${quantity['field'] === 'u_mag' ? 'displacement' : 'von Mises'} (${str(quantity['loadCase'])})`;
    case 'frequency':
      return `frequency, mode ${String(quantity['mode'])}`;
    case 'buckling_factor':
      return `buckling factor, mode ${String(quantity['mode'])}`;
    default:
      return '?';
  }
}

function parseItem(entry: unknown): VerificationItemView[] {
  if (!isRecord(entry) || typeof entry['code'] !== 'string') return [];
  const severity = entry['severity'];
  const accepted = entry['accepted'];
  return [
    {
      code: entry['code'],
      severity: severity === 'error' || severity === 'fail' ? severity : 'warning',
      message: str(entry['message']),
      remediation: str(entry['remediation']),
      accepted: isRecord(accepted)
        ? { signer: str(accepted['signer']), signatureId: str(accepted['signatureId']), justification: str(accepted['justification']) }
        : null,
    },
  ];
}

function parseLsq(raw: unknown): LsqView | null {
  if (!isRecord(raw)) return null;
  const residual = isRecord(raw['residual']) ? raw['residual'] : {};
  const uncertainty = isRecord(raw['uncertainty']) ? raw['uncertainty'] : {};
  const standardError = isRecord(raw['standardError']) ? raw['standardError'] : {};
  const p = num(raw['p']);
  const f0 = num(raw['f0']);
  const absolute = num(uncertainty['absolute']);
  if (p === null || f0 === null || absolute === null) return null;
  return {
    method: str(raw['method']),
    p,
    f0,
    standardErrorP: num(standardError['p']),
    standardDeviation: num(residual['standardDeviation']) ?? Number.NaN,
    rss: num(residual['rss']) ?? Number.NaN,
    degreesOfFreedom: num(residual['degreesOfFreedom']) ?? Number.NaN,
    uncertaintyAbsolute: absolute,
    uncertaintyRelative: num(uncertainty['relative']),
  };
}

function parseOrderPair(raw: unknown): ReportView['orderPair'] {
  if (!isRecord(raw)) return null;
  const difference = isRecord(raw['difference']) ? raw['difference'] : {};
  const quadratic = num(raw['quadratic']);
  const linear = num(raw['linear']);
  const absolute = num(difference['absolute']);
  return quadratic === null || linear === null || absolute === null
    ? null
    : { quadratic, linear, absolute, relative: num(difference['relative']) };
}

function parseReport(raw: unknown): ReportView | null {
  if (!isRecord(raw)) return null;
  const provenance = isRecord(raw['provenance']) ? raw['provenance'] : {};
  const gci = isRecord(raw['gci21']) ? raw['gci21'] : {};
  const exception = raw['exception'];
  return {
    status: str(raw['status'], '?'),
    method: str(provenance['procedure']),
    p: num(raw['p']),
    extrapolated: num(raw['extrapolated']),
    gciFine: num(gci['fine']),
    gciAbs: num(raw['gciAbs']),
    asymptoticRatio: num(raw['asymptoticRatio']),
    lsq: parseLsq(raw['lsq']),
    orderPair: parseOrderPair(raw['orderPair']),
    exception: isRecord(exception)
      ? { code: str(exception['code']), signer: str(exception['signer']), justification: str(exception['justification']) }
      : null,
  };
}

function parseStudy(entry: unknown): StudyView[] {
  if (!isRecord(entry) || typeof entry['id'] !== 'string' || !isRefinement(entry['refinement']) || !isState(entry['state'])) return [];
  const levels = num(entry['levels']);
  if (levels === null) return [];
  return [
    {
      id: entry['id'],
      refinement: entry['refinement'],
      quantity: quantityText(entry['quantity']),
      unit: str(entry['unit']),
      state: entry['state'],
      levels,
      codes: strings(entry['codes']),
      reviewRequired: entry['reviewRequired'] === true,
      reviewReasons: strings(entry['reviewReasons']),
      unverified: entry['unverified'] === true,
      report: parseReport(entry['report']),
    },
  ];
}

export function parseVerification(data: unknown): VerificationView | null {
  if (!isRecord(data) || !Array.isArray(data['studies']) || !Array.isArray(data['items'])) return null;
  const status = data['status'];
  return {
    status: status === 'pass' || status === 'fail' ? status : 'warn',
    items: data['items'].flatMap(parseItem),
    studies: data['studies'].flatMap(parseStudy),
    reviewRequired: data['reviewRequired'] === true,
    gciTarget: num(data['gciTarget']),
  };
}

export interface LevelRow {
  readonly index: number;
  /** The level's refinement size: mesh spacing h, time increment (s) or element order. */
  readonly size: string;
  readonly value: number;
  readonly elements: number;
}

/** The levels of a recorded study as the table shows them (kind-aware size column). */
export function levelRows(analysisCase: AnalysisCase, studyId: string): { readonly sizeLabel: string; readonly rows: readonly LevelRow[] } {
  const study =
    analysisCase.studies !== undefined && Object.hasOwn(analysisCase.studies, studyId) ? analysisCase.studies[studyId] : undefined;
  if (study === undefined) return { sizeLabel: 'h', rows: [] };
  const sizeLabel = study.refinement === 'dt' ? 'Δt (s)' : study.refinement === 'p' ? 'Element order' : 'h';
  return {
    sizeLabel,
    rows: study.levels.map((level) => ({
      index: level.index,
      size: study.refinement === 'p' ? String(level.controls.order) : String(level.h),
      value: level.value,
      elements: level.elements,
    })),
  };
}

export const REFINEMENT_LABEL: Readonly<Record<StudyRefinement, string>> = {
  h: 'Mesh size (h)',
  dt: 'Time step (dt)',
  p: 'Element order (p)',
};
