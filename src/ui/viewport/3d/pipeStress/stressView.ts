// Pure helpers of the pipe stress review surface (07 PST M4): parse the read-only `analyze_pipe_stress` answer, the ratio colour ramp, the
// per-pipe worst ratio the overlay paints and the worst-stations list of the panel. No React, no three.js.

import { isRecord } from '@lib/isRecord';
import {
  parseDisplacements,
  parseGeometry,
  parseReactions,
  type NodeDisplacement,
  type StressGeometry,
  type SupportReaction,
} from './stressGeometry';

export type RatioTone = 'pass' | 'warn' | 'fail' | 'unknown';

/** Ratio colour ramp (07 section 7): green below 0.8, amber 0.8 to 1, red above 1; a non-finite ratio is never a pass. */
const RATIO_WARN = 0.8;
const RATIO_FAIL = 1;

export const TONE_COLOR: Readonly<Record<RatioTone, string>> = { pass: '#34d399', warn: '#fbbf24', fail: '#f87171', unknown: '#818cf8' };

export function ratioTone(ratio: number | null): RatioTone {
  if (ratio === null) return 'unknown';
  if (!Number.isFinite(ratio)) return 'fail';
  if (ratio > RATIO_FAIL) return 'fail';
  return ratio >= RATIO_WARN ? 'warn' : 'pass';
}

export interface StressRow {
  readonly case: string;
  readonly caseType: string;
  readonly element: string;
  readonly pipeId: string;
  readonly node: string | null;
  /** Station position along the element from its first node, mm. */
  readonly xMm: number;
  readonly ratio: number;
  readonly stressMPa: number;
  readonly allowableMPa: number;
  readonly rule: string;
}

interface CaseSummary {
  readonly name: string;
  readonly type: string;
  readonly maxDisplacementMm: number | null;
  /** Largest code ratio of the case (from the governing list), null for a case without a code check (OPE). */
  readonly governingRatio: number | null;
  readonly governingNode: string | null;
}

interface StressFinding {
  readonly code: string;
  readonly severity: 'info' | 'warn' | 'fail';
  readonly message: string;
  readonly ids: readonly string[];
}

export interface StressView {
  readonly modelId: string;
  readonly status: 'pass' | 'fail' | 'incomplete';
  readonly rule: string;
  readonly cases: readonly CaseSummary[];
  readonly rows: readonly StressRow[];
  readonly findings: readonly StressFinding[];
  readonly inputHash: string;
  readonly resultHash: string;
  /** Node and element positions (mm); null when the answer carries none. */
  readonly geometry: StressGeometry | null;
  readonly reactions: readonly SupportReaction[];
  readonly displacements: readonly NodeDisplacement[];
  /** Recorded results of the model: their status and whether the inputs changed since. Null when nothing is recorded. */
  readonly recorded: { readonly status: string; readonly stale: boolean } | null;
}

export type StressOutcome = { readonly ok: true; readonly view: StressView } | { readonly ok: false; readonly summary: string };

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function parseRow(value: unknown): StressRow | null {
  if (!isRecord(value)) return null;
  const caseName = str(value['case']);
  const pipeId = str(value['pipeId']);
  const ratio = num(value['ratio']);
  if (caseName === null || pipeId === null || ratio === null) return null;
  return {
    case: caseName,
    caseType: str(value['caseType']) ?? '',
    element: str(value['element']) ?? '',
    pipeId,
    node: str(value['node']),
    xMm: num(value['xMm']) ?? 0,
    ratio,
    stressMPa: num(value['stressMPa']) ?? 0,
    allowableMPa: num(value['allowableMPa']) ?? 0,
    rule: str(value['rule']) ?? '',
  };
}

function parseFinding(value: unknown): StressFinding | null {
  if (!isRecord(value)) return null;
  const code = str(value['code']);
  const severity = value['severity'];
  if (code === null || (severity !== 'info' && severity !== 'warn' && severity !== 'fail')) return null;
  return {
    code,
    severity,
    message: str(value['message']) ?? '',
    ids: list(value['ids']).flatMap((id) => (typeof id === 'string' ? [id] : [])),
  };
}

interface Governing {
  readonly name: string;
  readonly ratio: number;
  readonly node: string | null;
}

function parseGoverning(data: Record<string, unknown>): Governing[] {
  return list(data['governing']).flatMap((entry): Governing[] => {
    if (!isRecord(entry)) return [];
    const name = str(entry['case']);
    const ratio = num(entry['ratio']);
    return name === null || ratio === null ? [] : [{ name, ratio, node: str(entry['nodeId']) }];
  });
}

function parseCases(data: Record<string, unknown>): CaseSummary[] {
  const governing = parseGoverning(data);
  return list(data['cases']).flatMap((entry): CaseSummary[] => {
    if (!isRecord(entry)) return [];
    const name = str(entry['name']);
    if (name === null) return [];
    const worst = governing
      .filter((g) => g.name === name)
      .reduce<Governing | null>((a, b) => (a === null || rank(b.ratio) > rank(a.ratio) ? b : a), null);
    const displacement = isRecord(entry['maxDisplacement']) ? num(entry['maxDisplacement']['mm']) : null;
    return [
      {
        name,
        type: str(entry['type']) ?? '',
        maxDisplacementMm: displacement,
        governingRatio: worst?.ratio ?? null,
        governingNode: worst?.node ?? null,
      },
    ];
  });
}

/** The view of an `analyze_pipe_stress` answer called with `include: ['stresses', 'geometry', 'reactions', 'displacements']`; null when `data` is not an analysis (a refused query has none). */
export function parseStressView(data: unknown): StressView | null {
  if (!isRecord(data)) return null;
  const status = data['status'];
  const modelId = str(data['modelId']);
  if (modelId === null || (status !== 'pass' && status !== 'fail' && status !== 'incomplete')) return null;
  const details = isRecord(data['details']) ? data['details'] : {};
  const recorded = isRecord(data['recorded']) ? data['recorded'] : null;
  return {
    modelId,
    status,
    rule: str(data['rule']) ?? '',
    cases: parseCases(data),
    rows: list(details['stresses']).flatMap((row) => parseRow(row) ?? []),
    findings: list(data['findings']).flatMap((finding) => parseFinding(finding) ?? []),
    inputHash: str(data['inputHash']) ?? '',
    resultHash: str(data['resultHash']) ?? '',
    geometry: parseGeometry(data['geometry']),
    reactions: parseReactions(details['reactions']),
    displacements: parseDisplacements(details['displacements']),
    recorded: recorded === null ? null : { status: str(recorded['status']) ?? '', stale: recorded['stale'] === true },
  };
}

/** A non-finite ratio ranks above every finite one. */
const rank = (ratio: number): number => (Number.isFinite(ratio) ? ratio : Number.POSITIVE_INFINITY);

/** The worst station ratio of every element (over `caseName`, or every case when null); an element without a station is absent. */
export function elementRatios(rows: readonly StressRow[], caseName: string | null): Map<string, number> {
  const worst = new Map<string, number>();
  for (const row of rows) {
    if (caseName !== null && row.case !== caseName) continue;
    const known = worst.get(row.element);
    if (known === undefined || rank(row.ratio) > rank(known)) worst.set(row.element, row.ratio);
  }
  return worst;
}

/** The `limit` worst stations, worst first, one per case / pipe / node (interior stations are keyed by element). */
export function worstStations(rows: readonly StressRow[], caseName: string | null, limit: number): StressRow[] {
  const seen = new Set<string>();
  return rows
    .filter((row) => caseName === null || row.case === caseName)
    .sort((a, b) => rank(b.ratio) - rank(a.ratio))
    .filter((row) => {
      const key = `${row.case}|${row.pipeId}|${row.node ?? row.element}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export type ApprovalStatus = 'approved' | 'stale' | 'not-recorded' | 'not-approved' | 'unverifiable';

/** What the panel says about the approval: it covers one fixed record, so a stale record or a different result hash is never "approved". */
export function approvalStatus(
  model: {
    readonly recorded?: { readonly resultHash: string } | undefined;
    readonly approval?: { readonly resultHash: string } | undefined;
  },
  outcome: StressOutcome,
): ApprovalStatus {
  if (model.recorded === undefined) return 'not-recorded';
  if (!outcome.ok) return 'unverifiable';
  if (outcome.view.recorded?.stale === true) return 'stale';
  return model.approval !== undefined && model.approval.resultHash === model.recorded.resultHash ? 'approved' : 'not-approved';
}
