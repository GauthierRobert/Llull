/**
 * The content of a pipe stress report (07 PST M4): everything a reviewer reads, from the CURRENT analysis of a model and its recorded / approved state.
 * @invariant pure and deterministic: no clock (the approval time is the stored `at`), same document -> same record
 */

import type { Analysis, Finding, Governing, SupportLoad } from '../analysis';
import type { StressRow } from '../code/codeStress';
import type { StressModel } from '../model/schema';
import { SOLVER_VERSION } from '../solve/run';

export type ApprovalStatus = 'approved' | 'stale' | 'none';
export type RecordStatus = 'none' | 'current' | 'stale';

export interface CaseSummary {
  readonly name: string;
  readonly type: string;
  readonly governing: Governing | null;
  readonly pass: boolean | null;
}

export interface Station {
  readonly case: string;
  readonly pipeId: string;
  readonly element: string;
  readonly node: string | null;
  readonly xMm: number;
  readonly stressMPa: number;
  readonly allowableMPa: number;
  readonly ratio: number;
  readonly pass: boolean;
  readonly rule: string;
}

export interface ReportData {
  readonly modelId: string;
  readonly name: string;
  readonly code: string;
  readonly edition: string;
  readonly rule: string;
  readonly status: Analysis['status'];
  readonly pipes: readonly string[];
  readonly cases: readonly CaseSummary[];
  readonly stations: readonly Station[];
  readonly supportLoads: readonly SupportLoad[];
  readonly findings: readonly Finding[];
  /** Inputs the reviewer must verify: unverified material or edition findings. */
  readonly unverified: readonly Finding[];
  /** Inputs taken from a named default. */
  readonly defaulted: readonly string[];
  readonly record: { readonly status: RecordStatus; readonly recordedStatus: Analysis['status'] | null };
  readonly approval: { readonly status: ApprovalStatus; readonly signer: string | null; readonly at: string | null };
  readonly inputHash: string;
  readonly resultHash: string;
  readonly solverVersion: string;
}

const UNVERIFIED_CODES: ReadonlySet<string> = new Set(['PST_MATERIAL_UNVERIFIED', 'PST_SIF_EDITION']);

const stationOf = (row: StressRow): Station => ({
  case: row.case,
  pipeId: row.pipeId,
  element: row.element,
  node: row.node,
  xMm: row.xMm,
  stressMPa: row.stressMPa,
  allowableMPa: row.allowableMPa,
  ratio: row.ratio,
  pass: row.ratio <= 1,
  rule: row.rule,
});

/** Code and edition of a rule-set id (`B31.3-2018` -> B31.3, 2018). */
const splitRule = (rule: string): { code: string; edition: string } => {
  const at = rule.lastIndexOf('-');
  return at < 0 ? { code: rule, edition: '' } : { code: rule.slice(0, at), edition: rule.slice(at + 1) };
};

/** The report record of `analysis`; the record is `current` when its hashes equal the current analysis, else `stale` (an approval then no longer covers the design). */
export function buildReportData(model: StressModel, analysis: Analysis): ReportData {
  const recorded = model.recorded;
  const recordStatus: RecordStatus =
    recorded === undefined
      ? 'none'
      : recorded.inputHash === analysis.inputHash && recorded.resultHash === analysis.resultHash
        ? 'current'
        : 'stale';
  const approval = model.approval;
  const approvalStatus: ApprovalStatus =
    approval === undefined ? 'none' : recordStatus === 'current' && approval.resultHash === analysis.resultHash ? 'approved' : 'stale';
  const stale = recordStatus === 'stale' || approvalStatus === 'stale';
  const findings = [...analysis.findings];
  if (stale)
    findings.push({
      code: 'PST_RESULTS_STALE',
      severity: 'warn',
      ids: [model.id],
      paths: ['recorded'],
      message: `the recorded results of ${model.id} were computed from other inputs; this report shows the current analysis${approval === undefined ? '' : ' and the approval no longer covers it'}`,
      remediation: 'Run record_pipe_stress_results again after the edit; an approval covers one fixed set of results.',
    });
  return {
    modelId: model.id,
    name: model.name,
    ...splitRule(model.rule),
    rule: model.rule,
    status: analysis.status,
    pipes: analysis.built.sources.pipes.map((pipe) => pipe.id),
    cases: analysis.states.map((state) => {
      const governing = analysis.governing.find((entry) => entry.case === state.name) ?? null;
      return { name: state.name, type: state.type, governing, pass: governing === null ? null : governing.ratio <= 1 };
    }),
    stations: analysis.stress.rows.map(stationOf),
    supportLoads: analysis.supportLoads,
    findings,
    unverified: findings.filter((entry) => UNVERIFIED_CODES.has(entry.code)),
    defaulted: analysis.defaulted,
    record: { status: recordStatus, recordedStatus: recorded?.status ?? null },
    approval: { status: approvalStatus, signer: approval?.signer ?? null, at: approval?.at ?? null },
    inputHash: analysis.inputHash,
    resultHash: analysis.resultHash,
    solverVersion: SOLVER_VERSION,
  };
}
