/** The `FeaToolsPort` of the server and CLI: Gmsh through the llull-mesh sidecar, CalculiX through a tracked child, artifacts in the store. */

import type { FeaToolsPort } from '@protocol/index';
import { getGeometryKernel } from '@core/geometry/kernel';
import { positiveInteger } from '../env';
import { defaultFeArtifactStore } from './artifactStore';
import { caeHooks } from './caeHooks';
import { createCcxRunner } from './ccxProcess';
import { runFeaExport } from './feaExport';
import { runFeaImportField } from './feaImportField';
import { runFeaImportResults } from './feaImportResults';
import { runFeaMesh, type MesherResponse } from './feaMesh';
import { runFeaSolve } from './feaSolve';
import { callNativeMesher } from './nativeMesher';
import { nativeBinaryPath, nativeInstallHint } from '../native/nativeBinary';
import { createComputeRunner } from '../native/computeJob';
import { nativeMappingStep } from '../native/mapField';
import { randomPostStep } from '../native/randomField';

const DEFAULT_MESH_TIMEOUT_MS = 600_000;

/** Without llull-mesh meshing answers FEA_TOOL_MISSING; solving and exporting an existing mesh still work. */
export function createFeaToolsPort(env: NodeJS.ProcessEnv = process.env): FeaToolsPort {
  const timeoutMs = positiveInteger(env['LLULL_FEA_MESH_TIMEOUT_MS'], DEFAULT_MESH_TIMEOUT_MS);
  const store = defaultFeArtifactStore();
  const ccx = createCcxRunner(env);
  const keepJobs = env['LLULL_FEA_KEEP'] === '1';
  const runner = createComputeRunner(env);
  const beforeDeck = nativeMappingStep({ store, runner, env }, env);
  const randomPost = randomPostStep(runner, env);
  const mesher = async (request: Record<string, unknown>): Promise<MesherResponse> => {
    const binary = nativeBinaryPath('llull-mesh', env);
    if (binary === null) throw new Error(`${nativeInstallHint('llull-mesh')}; FEA_TOOL_MISSING`);
    return callNativeMesher(binary, request, timeoutMs, env);
  };
  return {
    mesh: (analysisId, host) => runFeaMesh(analysisId, host, { mesher, store, hooks: caeHooks, kernel: getGeometryKernel }),
    solve: (analysisId, options, host) =>
      runFeaSolve(analysisId, options.timeoutS, host, { store, hooks: caeHooks, ccx, keepJobs, beforeDeck, randomPost }),
    exportDeck: (analysisId, host, options) => Promise.resolve(runFeaExport(analysisId, host, { store, hooks: caeHooks }, options)),
    importResults: (analysisId, file, host) => Promise.resolve(runFeaImportResults(analysisId, file, host, { store, hooks: caeHooks })),
    importField: (analysisId, table, host) => Promise.resolve(runFeaImportField(analysisId, table, host, { store, hooks: caeHooks })),
  };
}
