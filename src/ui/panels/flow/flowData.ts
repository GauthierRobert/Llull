// What the Flow panel reads from the document and from `cfd_report`: typed views and the wording of states. No flow is computed here;
// every number shown is a recorded value (summary, study) or a field of the read-only report command.

import type { CadDocument } from '@core/model/types';
import { isRecord } from '@lib/isRecord';
import { formatSignificant } from '@ui/panels/analysis/quantityFormat';
import type { StatusTone } from '@ui/panels/PanelParts';

type CfdSlice = NonNullable<CadDocument['cfd']>;
export type FlowCase = CfdSlice['cases'][string];
export type FlowResult = CfdSlice['results'][string];
export type FlowStudy = NonNullable<CfdSlice['studies']>[string];

interface FlowWarning {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
}

/** The parts of a `cfd_report` answer the panel shows. */
export interface FlowReport {
  readonly stale: boolean;
  readonly staleReasons: readonly string[];
  readonly trusted: boolean;
  readonly warnings: readonly FlowWarning[];
  readonly steps: number | null;
  readonly averagedSteps: number | null;
  /** Drag coefficient per monitor sample, step order. */
  readonly history: ReadonlyArray<{ readonly step: number; readonly cd: number }>;
  /** Warnings the solver itself raised (e.g. CFD_NOT_CONVERGED). */
  readonly solverWarnings: readonly { readonly code: string; readonly message: string }[];
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function warningsOf(value: unknown): FlowWarning[] {
  return Array.isArray(value)
    ? value.filter(isRecord).map((w) => ({ code: text(w['code']), message: text(w['message']), remediation: text(w['remediation']) }))
    : [];
}

/** Null when the answer is not a report (the command refused: no result yet, or the host is offline). */
export function parseFlowReport(data: unknown): FlowReport | null {
  if (!isRecord(data) || typeof data['stale'] !== 'boolean' || typeof data['trusted'] !== 'boolean') return null;
  const convergence = isRecord(data['convergence']) ? data['convergence'] : {};
  const history = Array.isArray(convergence['history']) ? convergence['history'].filter(isRecord) : [];
  return {
    stale: data['stale'],
    staleReasons: Array.isArray(data['staleReasons']) ? data['staleReasons'].map(text) : [],
    trusted: data['trusted'],
    warnings: warningsOf(data['warnings']),
    steps: finite(convergence['steps']),
    averagedSteps: finite(convergence['averagedSteps']),
    history: history.flatMap((row) => {
      const [step, cd] = [finite(row['step']), finite(row['cd'])];
      return step === null || cd === null ? [] : [{ step, cd }];
    }),
    solverWarnings: warningsOf(convergence['warnings']).map(({ code, message }) => ({ code, message })),
  };
}

export interface FlowBadge {
  readonly tone: StatusTone;
  readonly text: string;
}

/** The state of a case at a glance: unsolved, stale, not converged, unverified or current. */
export function caseBadge(result: FlowResult | undefined, report: FlowReport | null): FlowBadge {
  if (result === undefined) return { tone: 'info', text: 'Not solved' };
  if (report?.stale === true) return { tone: 'warn', text: 'Stale' };
  if (!result.converged) return { tone: 'warn', text: 'Not converged' };
  if (!result.verified || report?.trusted === false) return { tone: 'warn', text: 'Unverified' };
  return { tone: 'ok', text: 'Current' };
}

export const num = (value: number): string => formatSignificant(value, 4);

const QUANTITY_LABELS: Readonly<Record<FlowStudy['quantity'], string>> = { cd: 'Cd', cl: 'Cl', cdAM2: 'CdA' };

interface StudyLevelRow {
  readonly key: string;
  readonly cellText: string;
  readonly cellsText: string;
  readonly valueText: string;
  readonly converged: boolean;
}

export interface StudyView {
  readonly quantityLabel: string;
  readonly badge: FlowBadge;
  /** A note when the study no longer describes the case; empty when current. */
  readonly staleNote: string;
  /** Finest first. */
  readonly levels: readonly StudyLevelRow[];
  /** Verdict line: the GCI, or why there is none. */
  readonly verdict: { readonly tone: StatusTone; readonly text: string };
  /** Observed order, extrapolated value, asymptotic ratio: only the ones the study carries. */
  readonly details: ReadonlyArray<{ readonly key: string; readonly label: string; readonly value: string }>;
  readonly unconverged: boolean;
}

const percent = (fraction: number): string => `${formatSignificant(fraction * 100, 3)} %`;

function verdictOf(study: FlowStudy, label: string): StudyView['verdict'] {
  if (study.status === 'monotone' && study.gci21Fine !== undefined)
    return { tone: 'ok', text: `Fine-grid GCI of ${label}: ${percent(study.gci21Fine)} (monotone convergence)` };
  if (study.status === 'monotone' && study.gciAbs !== undefined)
    return { tone: 'ok', text: `Fine value is 0, so no relative GCI: absolute GCI ${num(study.gciAbs)} (the unit of ${label})` };
  if (study.status === 'converged_exactly') return { tone: 'ok', text: 'The grids agree exactly: no order or GCI to compute' };
  if (study.status === 'order_not_converged') return { tone: 'warn', text: 'Monotone, but the observed order did not converge: no GCI' };
  if (study.status === 'oscillatory') return { tone: 'bad', text: 'Non-monotone (oscillating) with refinement: no GCI' };
  if (study.status === 'divergent') return { tone: 'bad', text: 'Non-monotone (diverging) with refinement: no GCI' };
  return { tone: 'warn', text: `No GCI (${study.status})` };
}

/**
 * The study as the panel shows it. `stale`: the case or the flow surface changed since the study (the result of the same solve is stale, or
 * its case hash differs from the study's); the study is kept, like a stale result, and says so.
 */
export function studyView(study: FlowStudy, stale: boolean): StudyView {
  const label = QUANTITY_LABELS[study.quantity];
  const details = [
    ...(study.orderP === undefined ? [] : [{ key: 'order', label: 'Observed order p', value: num(study.orderP) }]),
    ...(study.extrapolated === undefined ? [] : [{ key: 'extrapolated', label: `${label} extrapolated`, value: num(study.extrapolated) }]),
    ...(study.asymptoticRatio === undefined ? [] : [{ key: 'asymptotic', label: 'Asymptotic ratio', value: num(study.asymptoticRatio) }]),
  ];
  return {
    quantityLabel: label,
    badge: study.verified ? { tone: 'ok', text: 'Verified' } : { tone: 'warn', text: 'Unverified' },
    staleNote: stale ? 'Stale: the case or geometry changed since this study. Solve it again.' : '',
    levels: study.levels.map((level) => ({
      key: level.resultsHash,
      cellText: `${num(level.cellM)} m`,
      cellsText: `${formatSignificant(level.cells, 3)} cells`,
      valueText: num(level.value),
      converged: level.converged,
    })),
    verdict: verdictOf(study, label),
    details,
    unconverged: study.levels.some((level) => !level.converged),
  };
}

/** Does the study still describe the case? Unknown (no result to compare with) counts as current. */
export function studyIsStale(study: FlowStudy, result: FlowResult | undefined, report: FlowReport | null): boolean {
  return report?.stale === true || (result !== undefined && result.caseHash !== study.caseHash);
}
