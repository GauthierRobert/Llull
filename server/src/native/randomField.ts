/**
 * fea_solve post-step of a random_response case (PHY-09 TR-DYN-44, RS1 RS-7): the nodal rms field (modes x frequencies x nodes x
 * components) runs in `llull-compute post random` when the binary is installed, else in the TypeScript reference within the Â§8 budget
 * (TS_NODAL_WORK_LIMIT), else the solve is refused with DYN_POST_TOO_LARGE before CalculiX starts. The pure @cae builder writes the job
 * and attaches the field to the results artifact (`nodalRms`); record_fea_results then recomputes the summary (nodal maxima) from it.
 * Environment: LLULL_NATIVE_RANDOM_MIN_NODES  node count from which the native job is used when installed (default 0 = always).
 */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import type { CadDocument } from '@core/model/types';
import {
  nodalWork,
  randomFieldInput,
  randomFieldReference,
  randomJobJson,
  TS_NODAL_WORK_LIMIT,
  withNodalRms,
  type RandomFieldInput,
} from '@cae/dynamics/nodalField';
import { isPostProblem } from '@cae/dynamics/randomSetup';
import { positiveInteger } from '../env';
import { f64Bytes, f64Values, readOutput, withJobFolder, type ComputeRunner } from './computeJob';
import { DEFAULT_NATIVE_TIMEOUT_S } from './fatigueField';

/** Components of the nodal field (relative displacement, absolute acceleration, six stresses) used for the pre-solve estimate. */
const ESTIMATE_COMPONENTS = 12;
const TS_SOLVER = 'llull random (TypeScript reference)';
const NATIVE_SOLVER = 'llull-compute post random';

interface PostFailure {
  readonly code: string;
  readonly message: string;
}

interface RandomPostResult {
  readonly results: FeResultsArtifact;
  readonly note: string;
  readonly engine: 'native-cpu' | 'ts';
  readonly elapsedMs: number;
}

export interface RandomPostStep {
  /** Refusal before the solve when the field would exceed the TypeScript budget and llull-compute is absent; null to go on. */
  precheck(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact): PostFailure | null;
  run(doc: CadDocument, analysisId: string, mesh: FeMeshArtifact, results: FeResultsArtifact): Promise<RandomPostResult | PostFailure>;
}

const tooLarge = (nodes: number, modes: number): PostFailure => ({
  code: 'DYN_POST_TOO_LARGE',
  message: `the nodal rms field of ${nodes} nodes x ${modes} modes exceeds the TypeScript budget and llull-compute is not installed`,
});

async function runNative(input: RandomFieldInput, runner: ComputeRunner, env: NodeJS.ProcessEnv): Promise<Float64Array | PostFailure> {
  const files = { 'job.json': JSON.stringify(randomJobJson(input)), 'modal.f64': f64Bytes(input.modal) };
  try {
    return await withJobFolder(
      files,
      async (folder) => {
        const run = await runner.run(['post', 'random'], folder, DEFAULT_NATIVE_TIMEOUT_S * 1000);
        if (!run.ok) return { code: run.code ?? 'NATIVE_JOB_FAILED', message: run.message ?? 'llull-compute failed' };
        return f64Values(await readOutput(folder, run, 'field.f64'));
      },
      env,
    );
  } catch (error) {
    return { code: 'NATIVE_PROTOCOL', message: error instanceof Error ? error.message : String(error) };
  }
}

/** The post-step of fea_solve for `runner` (native when installed and the mesh has at least LLULL_NATIVE_RANDOM_MIN_NODES nodes). */
export function randomPostStep(runner: ComputeRunner, env: NodeJS.ProcessEnv = process.env): RandomPostStep {
  const configured = env['LLULL_NATIVE_RANDOM_MIN_NODES'];
  const minNodes = configured === undefined || configured === '0' ? 0 : positiveInteger(configured, 0);
  const nativeFor = (nodes: number): boolean => runner.binary !== null && nodes >= minNodes;
  return {
    precheck(doc, analysisId, mesh) {
      const modes = doc.analysis?.cases[analysisId]?.modes ?? 0;
      if (runner.binary !== null) return null;
      return nodalWork(mesh.nodes.length, ESTIMATE_COMPONENTS, modes) > TS_NODAL_WORK_LIMIT ? tooLarge(mesh.nodes.length, modes) : null;
    },
    async run(doc, analysisId, mesh, results) {
      const input = randomFieldInput(doc, analysisId, mesh, results);
      if (isPostProblem(input)) return input;
      const started = Date.now();
      const { nodeCount, modes } = input.job;
      let native: Float64Array | PostFailure | null = null;
      if (nativeFor(nodeCount)) native = await runNative(input, runner, env);
      if (native !== null && !isPostProblem(native)) {
        const attached = withNodalRms(results, input, native, 'native-cpu', NATIVE_SOLVER, await runner.version());
        if (typeof attached === 'string') return { code: 'NATIVE_PROTOCOL', message: attached };
        const elapsedMs = Date.now() - started;
        return {
          results: attached,
          engine: 'native-cpu',
          elapsedMs,
          note: `nodal rms field of ${nodeCount} nodes in llull-compute (${elapsedMs} ms)`,
        };
      }
      if (nodalWork(nodeCount, input.components.length, modes) > TS_NODAL_WORK_LIMIT) return tooLarge(nodeCount, modes);
      const attached = withNodalRms(results, input, randomFieldReference(input), 'ts', TS_SOLVER, 'ts');
      if (typeof attached === 'string') return { code: 'DYN_RESULTS_MISSING', message: attached };
      const elapsedMs = Date.now() - started;
      const why =
        native === null
          ? runner.binary === null
            ? 'llull-compute not installed'
            : 'below the native threshold'
          : `native job failed: ${native.code}`;
      return {
        results: attached,
        engine: 'ts',
        elapsedMs,
        note: `nodal rms field of ${nodeCount} nodes in TypeScript (${why}, ${elapsedMs} ms)`,
      };
    },
  };
}
