/** Solved nonlinear_static fixtures with a chosen load-displacement curve (`.dat` tables in the ccx 2.21 layout), recorded through the commands. */
import { defaultContext } from '@core/commands/context';
import { execute } from '@core/commands/registry';
import type { ExecutionContext } from '@core/commands/types';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import { analysisInputHash } from '@cae/hash/inputHash';
import { parseDat } from '@cae/results/datReader';
import { meshSummary, resultsSummary } from '@cae/results/summary';
import { hashOf, portOf } from '../deckFixtures';
import { meshOf, pressureBar, pulledBar } from './support';

const sci = (value: number): string =>
  value
    .toExponential(7)
    .toUpperCase()
    .replace(/E([+-])(\d)$/, (_match, sign: string, digit: string) => `E${sign}0${digit}`);

const setName = (name: string): string => name.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

function displacementTable(set: string, time: number, ux: number): string[] {
  return ['', ` displacements (vx,vy,vz) for set ${set} and time  ${sci(time)}`, '', `         2  ${sci(ux)}  ${sci(0)}  ${sci(0)}`];
}

export interface SolvedCurve {
  readonly doc: CadDocument;
  readonly analysisId: string;
  readonly probeId: string;
  readonly ctx: ExecutionContext;
  readonly mesh: FeMeshArtifact;
  readonly results: FeResultsArtifact;
}

/** Record `mesh` + `results` of `analysisId` on `doc` through record_fe_mesh / record_fea_results. */
function recorded(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
): { doc: CadDocument; ctx: ExecutionContext } {
  const ctx: ExecutionContext = { ...defaultContext(), feaArtifacts: portOf(mesh, results) };
  const meshed = execute(doc, 'record_fe_mesh', { analysisId, summary: meshSummary(mesh, hashOf(mesh)) }, ctx);
  if (meshed.error !== undefined) throw new Error(meshed.summary);
  const summary = resultsSummary(meshed.document, analysisId, mesh, results, hashOf(results));
  const solved = execute(meshed.document, 'record_fea_results', { analysisId, summary }, ctx);
  if (solved.error !== undefined) throw new Error(solved.summary);
  return { doc: solved.document, ctx };
}

/** The pulled bar (displacement control, reaction-x probe) solved with reaction magnitudes `loads` at ux = 0.01 x time, time = (k + 1) / n. */
export function solvedPull(loads: readonly number[]): SolvedCurve {
  const bar = pulledBar();
  const mesh = meshOf(bar);
  const times = loads.map((_, index) => (index + 1) / loads.length);
  const text = times
    .flatMap((time, index) => [
      ...displacementTable(setName(`N_${bar.probeId}`), time, 0.01 * time),
      '',
      ` total force (fx,fy,fz) for set ${setName(`C_${bar.constraints['x0']}`)} and time  ${sci(time)}`,
      '',
      `  ${sci(-(loads[index] ?? 0))}  ${sci(0)}  ${sci(0)}`,
    ])
    .join('\n');
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(mesh),
    inputHash: analysisInputHash(bar.doc, bar.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: times.map((time) => ({
      step: 1,
      time,
      fields: { DISP: { components: ['D1', 'D2', 'D3'], values: { '2': [0.01 * time, 0, 0] } } },
    })),
    dat: parseDat(text),
  };
  return { ...recorded(bar.doc, bar.analysisId, mesh, results), analysisId: bar.analysisId, probeId: bar.probeId, mesh, results };
}

/** The pressure bar (load probe on pressure p = 1 x LC1; LC1 ramps to 50 then back to 0) solved with the bore opening then closing. */
export function solvedPressure(): SolvedCurve {
  const bar = pressureBar();
  const times = [0.5, 1, 1.5, 2];
  const ux = [0.001, 0.002, 0.0015, 0.0005];
  const text = times.flatMap((time, index) => displacementTable(setName(`N_${bar.probeId}`), time, ux[index] ?? 0)).join('\n');
  const results: FeResultsArtifact = {
    kind: 'fe_results',
    meshHash: hashOf(bar.mesh),
    inputHash: analysisInputHash(bar.doc, bar.analysisId, 'full'),
    solver: 'CalculiX',
    solverVersion: '2.21',
    steps: times.map((time, index) => ({
      step: time <= 1 ? 1 : 2,
      time,
      fields: { DISP: { components: ['D1', 'D2', 'D3'], values: { '2': [ux[index] ?? 0, 0, 0] } } },
    })),
    dat: parseDat(text),
  };
  return {
    ...recorded(bar.doc, bar.analysisId, bar.mesh, results),
    analysisId: bar.analysisId,
    probeId: bar.probeId,
    mesh: bar.mesh,
    results,
  };
}
