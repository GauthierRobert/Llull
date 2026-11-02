/** PST-M3 fixtures: documents with building pipes, supports and stress models built through the registered commands only. */

import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply } from '../../../helpers/commandAssertions';

export const MM_PER_IN = 25.4;
export const PSI_TO_MPA = 0.00689476;
export const LBF_TO_N = 4.4482216;

/** NPS 10 Sch 40 in mm (PSI fixtures): OD 10.75 in, wall 0.365 in. */
export const NPS10 = { odMm: 10.75 * MM_PER_IN, wallMm: 0.365 * MM_PER_IN };
/** DN100 Sch 40: OD 114.3, wall 6.02. */
export const DN100 = { odMm: 114.3, wallMm: 6.02 };

export const baseDoc = (): CadDocument => apply(createEmptyDocument(), 'add_level', { name: 'Grade', elevation: 0 });

/** A building pipe through `points` (mm) with the given OD; returns the document and the pipe id. */
export function withPipe(
  doc: CadDocument,
  points: number[][],
  odMm: number,
  extra: Record<string, unknown> = {},
): { doc: CadDocument; id: string } {
  const result = execute(doc, 'add_pipe_run', { points, diameter: odMm, ...extra });
  if (result.rejected === true) throw new Error(result.summary);
  return { doc: result.document, id: result.affected[0] as string };
}

/** The model on `pipeIds` with rule B31.3-2018 and sharp corners unless overridden. */
export function withModel(doc: CadDocument, pipeIds: string[], extra: Record<string, unknown> = {}): { doc: CadDocument; id: string } {
  const result = execute(doc, 'create_stress_model', {
    name: 'M',
    pipeIds,
    rule: 'B31.3-2018',
    elbowRadiusFactor: 0,
    maxElementLengthMm: 100000,
    ...extra,
  });
  if (result.rejected === true) throw new Error(result.summary);
  return { doc: result.document, id: (result.data as { modelId: string }).modelId };
}

/** Carbon steel conditions with a constant secant coefficient (per K) and the allowables the caller reads from the code tables. */
export const steel = (over: Record<string, unknown> = {}, material: Record<string, unknown> = {}): Record<string, unknown> => ({
  installTempC: 21.1,
  temperatures: [{ name: 'T1', tempC: 260 }],
  cycles: 7000,
  corrosionAllowanceMm: 0,
  fluidDensityKgM3: 0,
  wallMm: DN100.wallMm,
  material: { youngsModulusMPa: 200000, ShMPa: 138, ScMPa: 138, thermal: { table: 'carbon-steel-c1' }, ...material },
  ...over,
});

export const conditioned = (
  doc: CadDocument,
  modelId: string,
  over: Record<string, unknown> = {},
  material: Record<string, unknown> = {},
): CadDocument => apply(doc, 'set_pipe_operating_conditions', { modelId, ...steel(over, material) });

export const anchorAt = (doc: CadDocument, modelId: string, pipeId: string, atMm: number): CadDocument =>
  apply(doc, 'add_stress_restraint', { modelId, at: { pipeId, atMm }, kind: 'anchor' });

export const cases = (doc: CadDocument, modelId: string, list: unknown[], forces?: unknown[]): CadDocument =>
  apply(doc, 'set_stress_load_cases', { modelId, cases: list, ...(forces === undefined ? {} : { forces }) });

export interface AnalysisData {
  status: string;
  findings: { code: string; severity: string; ids: string[]; message: string }[];
  governing: { case: string; nodeId: string; ratio: number; rule: string }[];
  cases: {
    name: string;
    type: string;
    iterations: number;
    residual: number;
    contacts: { sources: string[]; node: string; status: string; normalForceN: number }[];
  }[];
  model: { nodes: number; elements: number; dof: number; pipes: string[] };
  solver: { maxResidual: number };
  inputHash: string;
  resultHash: string;
  recorded: { status: string; stale: boolean } | null;
  provenance: { defaulted: string[] };
  details?: {
    displacements?: { case: string; node: string; uMm: number[]; rotDeg: number[] }[];
    reactions?: { nodeId: string; supportIds: string[]; case: string; forceN: number[]; momentNmm: number[] }[];
    stresses?: {
      case: string;
      element: string;
      node: string | null;
      xMm: number;
      stressMPa: number;
      allowableMPa: number;
      ratio: number;
      rule: string;
      sif: { ii: number; io: number };
    }[];
  };
}

/** The data of analyze_pipe_stress; throws with the summary when it was refused. */
export function analyzed(doc: CadDocument, modelId: string, extra: Record<string, unknown> = {}): AnalysisData {
  const result = execute(doc, 'analyze_pipe_stress', { modelId, ...extra });
  if (result.rejected === true) throw new Error(result.summary);
  return result.data as AnalysisData;
}

export const disp = (data: AnalysisData, caseName: string, node: string): { uMm: number[]; rotDeg: number[] } => {
  const row = data.details?.displacements?.find((entry) => entry.case === caseName && entry.node === node);
  if (row === undefined) throw new Error(`no displacement ${caseName} ${node}`);
  return row;
};

export const reaction = (data: AnalysisData, caseName: string, node: string): { forceN: number[]; momentNmm: number[] } => {
  const row = data.details?.reactions?.find((entry) => entry.case === caseName && entry.nodeId === node);
  if (row === undefined) throw new Error(`no reaction ${caseName} ${node}`);
  return row;
};

/** A passing model on a 4 m straight DN100 pipe between two anchors with sustained, operating and expansion cases, recorded. */
export function recordedModel(): { doc: CadDocument; id: string; pipeId: string } {
  const { doc: pipes, id: pipeId } = withPipe(
    baseDoc(),
    [
      [0, 0, 3000],
      [4000, 0, 3000],
    ],
    DN100.odMm,
  );
  const { doc, id } = withModel(pipes, [pipeId]);
  let d = conditioned(doc, id, { temperatures: [{ name: 'T1', tempC: 60 }] });
  d = anchorAt(anchorAt(d, id, pipeId, 0), id, pipeId, 4000);
  d = cases(d, id, [
    { name: 'SUS', type: 'SUS', basic: ['W'] },
    { name: 'OPE', type: 'OPE', basic: ['W', 'T1'] },
    {
      name: 'EXP',
      type: 'EXP',
      combine: [
        { case: 'OPE', factor: 1 },
        { case: 'SUS', factor: -1 },
      ],
    },
  ]);
  return { doc: apply(d, 'record_pipe_stress_results', { modelId: id }), id, pipeId };
}
