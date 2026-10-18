import { execute } from '@core/commands/registry';
import type { CadDocument } from '@core/model/types';
import { FRC_PLANS, runPlanBefore } from '../fatigue/support';

const RESIDUAL_PLAN = `${FRC_PLANS}/frc_residual_interval.plan.json`;
export type Json = Record<string, unknown>;
export const data = (result: { data?: unknown }): Json => (result.data ?? {}) as Json;
export const code = (result: { error?: { code: string } }): string | undefined => result.error?.code;
export const relative = (actual: number, expected: number): number => Math.abs(actual / expected - 1);
export const mm = (value: number): { value: number; unit: string } => ({ value, unit: 'mm' });

/** Document with material record dt_test (Fty 300 MPa, paris1 C 1e-11 m 3, kc1 Kc 60 MPa sqrt(m)) and nothing else. */
export const materialDoc = (): CadDocument => runPlanBefore(RESIDUAL_PLAN, 'define_load_history').document;

export interface Built {
  readonly doc: CadDocument;
  readonly crackId: string;
  readonly historyId: string;
  readonly caseId: string;
}

export interface BuildOptions {
  readonly doc?: CadDocument;
  readonly geometry?: Json;
  readonly history?: Json;
  readonly growth?: Json;
  readonly growthModelId?: string;
  readonly extra?: Json;
}

/** Centre crack W 200 mm, 0-150 MPa constant amplitude, a0 = 5 mm: the residual-interval plan set-up, with overrides. */
export function build(options: BuildOptions = {}): Built {
  const doc = options.doc ?? materialDoc();
  const history = execute(doc, 'define_load_history', {
    name: 'h',
    kind: 'stress',
    unit: 'MPa',
    data: { form: 'blocks', rows: [{ max: 150, min: 0, cycles: 1 }] },
    repeats: 'repeating',
    source: { citation: 'test' },
    ...options.history,
  });
  const crack = execute(history.document, 'define_crack', {
    name: 'c',
    geometry: { kind: 'center_through', a: mm(5), W: mm(200), t: mm(2), ...options.geometry },
  });
  const created = execute(crack.document, 'create_crack_growth_case', {
    name: 'g',
    crackId: crack.affected[0],
    material: { recordId: 'dt_test', growthModelId: options.growthModelId ?? 'paris1', toughnessModelId: 'kc1' },
    histories: [{ historyId: history.affected[0], scale: 1 }],
    growth: { aInitial: mm(5), aDetectable: mm(5), ...options.growth },
    ...options.extra,
  });
  return {
    doc: created.document,
    crackId: crack.affected[0] ?? '',
    historyId: history.affected[0] ?? '',
    caseId: created.affected[0] ?? '',
  };
}
