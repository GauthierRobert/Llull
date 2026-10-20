/**
 * fea_import_results: an external CalculiX `.frd` or Nastran `.op2` computed on the CURRENT mesh -> `FeResultsArtifact` -> store -> `record_fea_results`
 * (the same trust path as `fea_solve`: the recorded summary is recomputed from the stored artifact). A file of another mesh is refused, not imported
 * as a review-only result (deferred, see 05 TECHNICAL_SPEC §13).
 */

import type { FeMeshArtifact, FeResultsArtifact } from '@core/model/analysis';
import { bindingOf, frdBoundHashes, mismatchMessage, UNBOUND_WARNING } from '@cae/results/inputBinding';
import type { FeaHost, FeaToolResult, ResultsFileInput } from '@protocol/index';
import type { FeArtifactStore } from './artifactStore';
import type { CaeHooks } from './caeHooks';
import { currentMesh, feaFailure, isFailure } from './feaCommon';

/** Named guard: largest results file imported, in bytes (parsed into memory several times over). */
const MAX_RESULTS_BYTES = 256 * 1024 * 1024;

/** `FEA_RESULTS_MESH_MISMATCH` message when the FRD displacement nodes are not exactly the mesh nodes, else null. */
function frdMeshProblem(steps: FeResultsArtifact['steps'], mesh: FeMeshArtifact): string | null {
  const known = new Set(mesh.nodes.map((node) => String(node[0])));
  for (const step of steps) {
    const nodes = Object.keys(step.fields['DISP']?.values ?? {});
    if (nodes.length === 0) continue;
    const stray = nodes.find((node) => !known.has(node));
    if (stray !== undefined) return `node ${stray} of the file is not a node of the current mesh`;
    if (nodes.length !== known.size) return `the file has ${nodes.length} displacement nodes, the current mesh ${known.size}`;
  }
  return null;
}

/**
 * @failure unknown analysis / missing or stale mesh -> the shared codes; file above the cap -> FEA_RESULTS_TOO_LARGE; unreadable OP2 -> FEA_OP2_INVALID;
 *   a file without result sets -> FEA_RESULTS_EMPTY; a file of another mesh -> FEA_RESULTS_MESH_MISMATCH / FEA_OP2_MESH_MISMATCH; non-finite values ->
 *   FEA_SOLVER_FAILED; a file marked with the input hash of another set-up -> FEA_RESULTS_INPUT_MISMATCH (no marker: imported with binding 'imported-unbound'); a record_fea_results refusal -> its summary; the document is unchanged on every failure
 */
export function runFeaImportResults(
  analysisId: string,
  file: ResultsFileInput,
  host: FeaHost,
  deps: { store: FeArtifactStore; hooks: CaeHooks },
): FeaToolResult {
  const tool = 'fea_import_results';
  const doc = host.getDoc();
  const current = currentMesh(tool, doc, analysisId, deps.store, deps.hooks);
  if (isFailure(current)) return current;
  if (file.bytes.byteLength > MAX_RESULTS_BYTES)
    return feaFailure(tool, 'FEA_RESULTS_TOO_LARGE', `the file is ${file.bytes.byteLength} bytes (cap ${MAX_RESULTS_BYTES})`, [analysisId]);
  const inputHash = deps.hooks.analysisInputHash(doc, analysisId, 'full');
  let results: FeResultsArtifact;
  let warnings: readonly string[] = [];
  if (file.format === 'op2') {
    const read = deps.hooks.readOp2(file.bytes);
    if ('code' in read) return feaFailure(tool, read.code, read.message, [analysisId]);
    const mapped = deps.hooks.op2ToResults(doc, analysisId, current.mesh, current.meshHash, read);
    if ('code' in mapped) return feaFailure(tool, mapped.code, mapped.message, [analysisId]);
    results = mapped.artifact;
    warnings = mapped.warnings;
  } else {
    const text = new TextDecoder().decode(file.bytes);
    const binding = bindingOf(frdBoundHashes(text), inputHash);
    if (binding.kind === 'mismatch') return feaFailure(tool, 'FEA_RESULTS_INPUT_MISMATCH', mismatchMessage(binding.found), [analysisId]);
    const steps = deps.hooks.parseFrd(text);
    if (steps.length === 0) return feaFailure(tool, 'FEA_RESULTS_EMPTY', 'the .frd holds no result set', [analysisId]);
    const nonFinite = deps.hooks.firstNonFinite(steps);
    if (nonFinite !== null)
      return feaFailure(tool, 'FEA_SOLVER_FAILED', `the .frd holds non-finite results (${nonFinite}); the solution is not usable`, [
        analysisId,
      ]);
    const problem = frdMeshProblem(steps, current.mesh);
    if (problem !== null)
      return feaFailure(tool, 'FEA_RESULTS_MESH_MISMATCH', `${problem}: the file was computed on another mesh`, [analysisId]);
    results = {
      kind: 'fe_results',
      meshHash: current.meshHash,
      inputHash,
      solver: 'calculix',
      solverVersion: 'frd import',
      ...(binding.kind === 'unbound' ? { binding: 'imported-unbound' as const } : {}),
      steps,
    };
    if (binding.kind === 'unbound') warnings = [UNBOUND_WARNING];
  }
  const resultsHash = deps.store.put(results);
  const stored = deps.store.get(resultsHash);
  if (stored === null || stored.kind !== 'fe_results')
    return feaFailure(
      tool,
      'FEA_ARTIFACT_NOT_FOUND',
      `the results artifact ${resultsHash.slice(0, 12)} cannot be read back from the store`,
      [analysisId],
    );
  const recorded = host.applyCommand('record_fea_results', {
    analysisId,
    summary: deps.hooks.resultsSummary(doc, analysisId, current.mesh, stored, resultsHash),
  });
  const note = warnings.length === 0 ? '' : ` WARNING: ${warnings.join('; ')}`;
  return {
    summary: `fea_import_results: ${file.format} ${results.solver} ${results.solverVersion}, ${results.steps.length} result set(s) for mesh ${current.meshHash.slice(0, 12)}…. ${recorded.summary}${note}`,
    affected: recorded.affected,
    isError: recorded.isError,
    data: { resultsHash, format: file.format, steps: results.steps.length, solver: results.solver, warnings },
  };
}
