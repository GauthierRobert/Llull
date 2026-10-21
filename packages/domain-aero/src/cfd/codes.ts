/** Stable refusal / check codes of the cfd plugin (12 CFD §7, AF-11) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

export const CFD_REMEDIATION: Readonly<Record<string, string>> = {
  CFD_PARAM_INVALID: 'give finite values inside the documented ranges (see the command description)',
  CFD_CASE_EXISTS: 'pick another case id, or change the existing case with update_cfd_case',
  CFD_CASE_NOT_FOUND: 'list the cases with check_cfd and pass an existing case id',
  CFD_ENTITY_NOT_FOUND:
    'list entities with describe_scene / find_entities and pass ids that exist (boundary entities must be bodies of the case)',
  CFD_NO_GEOMETRY: 'put at least one 3D solid in entityIds (2D sketches have no flow surface; excluded ids are removed first)',
  CFD_KERNEL_REQUIRED:
    'overlapping bodies need a kernel union: install a geometry kernel (desktop app, or the CLI against a kernel backend), or separate the bodies',
  CFD_GEOMETRY_NOT_WATERTIGHT:
    'close the open edges (listed with positions), mesh_to_solid / boolean-union the parts, or tag the openings with set_cfd_boundary kind inlet / outlet',
  CFD_GEOMETRY_SELF_INTERSECTING:
    'remove the intersecting triangles (listed with positions): union overlapping parts with boolean, or exclude the offending entity',
  CFD_SMALL_FEATURE: 'exclude the entity, raise cellsPerReferenceLength / quality, or defeature the model (07 FTR recognize_features)',
  CFD_BLOCKAGE_TOO_HIGH: 'enlarge the domain (rule custom with a bigger box) or reduce the body: blockage above 3 % biases every result',
  CFD_BOUNDARY_CONFLICT:
    'an entity (or face) carries one boundary kind: clear the old tags with update_cfd_case boundaries, then tag again',
  CFD_REGIME_MISMATCH:
    'low_speed / lbm needs Mach < 0.3; compressible / euler needs 0.3 <= Mach <= 5: change the free stream, regime or solver',
  CFD_UNSTABLE_PARAMS: 'the LBM relaxation time is too close to 0.5: lower the speed or coarsen the grid',
  CFD_MEMORY_EXCEEDED: 'lower cellsPerReferenceLength to the largest value reported, or use a device with more memory',
  CFD_SOLVER_MISSING: 'install the llull-compute native binary (desktop bundle, or npm run native:build)',
  CFD_GPU_UNAVAILABLE: 'no usable GPU adapter: the CPU backend is used (slower)',
  CFD_NOT_CONVERGED: 'raise the step limit or timeout, or inspect the residual history before trusting the numbers',
  CFD_SOLVER_FAILED: 'the solver stopped on NaN / negative density: check the log tail, lower the speed or refine the geometry',
  CFD_TIMEOUT: 'raise --timeout; the partial result was recorded as not converged',
  CFD_NO_RESULT: 'solve the case first (cfd_solve)',
  CFD_RESULT_STALE: 'the case or geometry changed since the result: solve again',
  CFD_RESULT_MISSING: 'the result bundle is not in the store: solve again',
  CFD_RESULT_HASH_MISMATCH: 'the stored bundle does not match the summary: solve again',
  CFD_INPUT_STALE: 'the case or geometry changed while solving: solve again',
};

export const refuseCfd = tableRejection(CFD_REMEDIATION);
