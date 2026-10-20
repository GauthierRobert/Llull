/**
 * Nodal rms field of a random_response solve (TR-DYN-40/44, RS1 RS-7): every mesh node x component (relative displacement u_*_rel, absolute
 * acceleration a_*, and the six stress components when the frequency step wrote S) by the modal quadratic forms of randomResponse.ts.
 * Pure: builds the `llull-compute post random` job (job.json numbers + node-major modal.f64), runs the TypeScript reference
 * (`nodalRmsReference`) and stores a field in the results artifact (`FeResultsArtifact.nodalRms`); the host picks the engine.
 */

import type { CadDocument } from '@core/model/types';
import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { NodalRmsField } from '@core/model/structuralDynamics';
import { lengthUnitName, stressUnitName } from '../decks/units';
import { caseOf } from '../shared/access';
import { nodalRmsReference, type NodalFieldJob } from './math/randomResponse';
import { isPostProblem, randomPost, type PostProblem } from './randomSetup';

/** Node x component x modes^2 multiply-adds the TypeScript reference runs in fea_solve without llull-compute (§8 budget, ~10 s). */
export const TS_NODAL_WORK_LIMIT = 4e9;
const STRESS_COMPONENTS = ['s_xx', 's_yy', 's_zz', 's_xy', 's_yz', 's_zx'] as const;
const BASE_COMPONENTS = ['u_x_rel', 'u_y_rel', 'u_z_rel', 'a_x', 'a_y', 'a_z'] as const;

export interface RandomFieldInput {
  readonly job: NodalFieldJob;
  /** node-major nodeCount x modes x sources (ux, uy, uz [, sxx .. szx]) mode-shape values (not yet scaled by G_j). */
  readonly modal: Float64Array;
  readonly nodeIds: readonly number[];
  readonly components: readonly string[];
  readonly units: readonly string[];
}

/** `job.json` of `llull-compute post random` (field names of the Rust `RandomJob`). */
export function randomJobJson(input: RandomFieldInput): Record<string, unknown> {
  const { job } = input;
  return {
    task: 'random',
    nodeCount: job.nodeCount,
    modes: job.modes,
    sources: job.sources,
    fHz: job.grid.fHz,
    weight: job.grid.weight,
    omega: job.basis.omega,
    dampingA: job.basis.dampingA,
    dampingB: job.basis.dampingB,
    gamma: job.gamma,
    components: job.components.map((c) => ({ source: c.source, kind: c.kind, unity: c.unity, scale: c.scale })),
  };
}

/**
 * The job of `analysisId` over parsed results (mode shapes and tables of the frequency step).
 * @failure not a random_response case / random set-up problems -> its PostProblem code (DYN_*)
 */
export function randomFieldInput(
  doc: CadDocument,
  analysisId: string,
  mesh: FeMeshArtifact,
  results: FeResultsArtifact,
): RandomFieldInput | PostProblem {
  const analysis = caseOf(doc, analysisId);
  if (analysis?.type !== 'random_response')
    return { code: 'DYN_CASE_TYPE', message: `analysis '${analysisId}' is not a random_response case` };
  const post = randomPost(doc, analysis, results);
  if (isPostProblem(post)) return post;
  const withStress = post.kept.every((mode) => post.shapes[mode.mode - 1]?.stress !== undefined);
  const names = [...BASE_COMPONENTS, ...(withStress ? STRESS_COMPONENTS : [])];
  const sources = withStress ? 9 : 3;
  const modes = post.kept.length;
  const nodeIds: number[] = [];
  const values: number[] = [];
  for (const [node] of mesh.nodes) {
    const rows = post.kept.map((mode) => {
      const shape = post.shapes[mode.mode - 1];
      const disp = shape?.disp?.values[String(node)];
      const stress = withStress ? shape?.stress?.values[String(node)] : [];
      return disp === undefined || stress === undefined ? null : [...disp.slice(0, 3), ...stress.slice(0, sources - 3)];
    });
    if (rows.some((row) => row === null || row.length !== sources || row.some((v) => !Number.isFinite(v)))) continue;
    nodeIds.push(node);
    for (const row of rows) values.push(...(row ?? []));
  }
  const relative = { kind: 'relative' as const, unity: false, scale: post.gravity };
  const components = names.map((_name, index) =>
    index < 3
      ? { source: index, ...relative }
      : index < 6
        ? { source: index - 3, kind: 'absolute' as const, unity: index - 3 === post.direction, scale: 1 }
        : { source: index - 3, ...relative },
  );
  const length = lengthUnitName(analysis.unitSystem);
  const stressUnit = stressUnitName(analysis.unitSystem);
  return {
    job: { nodeCount: nodeIds.length, modes, sources, basis: post.basis, gamma: post.gamma, grid: post.grid, components },
    modal: Float64Array.from(values),
    nodeIds,
    components: names,
    units: names.map((name) => (name.startsWith('a_') ? 'g' : name.startsWith('u_') ? length : stressUnit)),
  };
}

/** Multiply-adds of the TypeScript reference for `input` (nodes x components x modes^2). */
export const nodalWork = (nodes: number, components: number, modes: number): number => nodes * components * modes * modes;

/** The TypeScript reference field (node-major nodeCount x components). */
export const randomFieldReference = (input: RandomFieldInput): Float64Array => nodalRmsReference(input.job, input.modal);

/**
 * `results` with the nodal rms field of `input` (computed by `engine`).
 * @failure wrong size or a non-finite value -> a message
 */
export function withNodalRms(
  results: FeResultsArtifact,
  input: RandomFieldInput,
  field: Float64Array,
  engine: NodalRmsField['engine'],
  solver: string,
  solverVersion: string,
): FeResultsArtifact | string {
  const width = input.components.length;
  if (field.length !== input.nodeIds.length * width)
    return `the field holds ${field.length} values, expected ${input.nodeIds.length * width}`;
  const bad = field.findIndex((value) => !Number.isFinite(value));
  if (bad >= 0) return `the rms of node ${input.nodeIds[Math.floor(bad / width)]} is not finite`;
  const values: Record<string, number[]> = {};
  input.nodeIds.forEach((node, index) => (values[String(node)] = Array.from(field.subarray(index * width, index * width + width))));
  return {
    ...results,
    nodalRms: {
      engine,
      solver,
      solverVersion,
      gridPoints: input.job.grid.fHz.length,
      components: [...input.components],
      units: [...input.units],
      values,
    },
  };
}
