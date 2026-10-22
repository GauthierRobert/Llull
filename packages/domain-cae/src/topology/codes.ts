/** Stable TOP_* codes (PHY-17 TECHNICAL_SPEC 7.1, 15) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

export const REMEDIATION: Readonly<Record<string, string>> = {
  TOP_ANALYSIS_MISSING: 'create the analysis first (create_analysis, set_part_idealization, add_fea_constraint, add_fea_load)',
  TOP_STUDY_NOT_FOUND: 'create it with create_topology_study (affected[0] is the study id)',
  TOP_DOMAIN_INVALID: 'pass ids of existing 3D solids that are parts of the analysis (set_part_idealization)',
  TOP_GRID_TOO_LARGE: 'increase `voxel` (the suggested value is in the message)',
  TOP_VOLUME_FRACTION_INVALID: 'give a fraction in (0, 1), e.g. 0.7 to keep 70 % of the volume (30 % lighter)',
  TOP_REGION_OUTSIDE_DOMAIN: 'move the region onto the design domain',
  TOP_KEEPIN_EXCEEDS_BUDGET: 'raise volumeFraction or shrink the keep-in regions',
  TOP_TARGET_UNMAPPED: 'refine `voxel` or move the target points onto the intended face / edge of the design domain',
  TOP_LOAD_OUTSIDE_DOMAIN: 'put the load on an entity of the design domain',
  TOP_SETUP_INVALID: 'give the analysis supports and loads (add_fea_constraint / add_fea_load) and consistent study parameters',
  TOP_OPTIMIZER_MISMATCH:
    'the min_volume objective needs optimizer mma (set_topology_settings optimizer=mma); oc handles the volume constraint only',
  TOP_MEMBER_SIZE_UNRESOLVED: 'use a voxel of at most half the minimum member size (re-create the study) or a larger minimum member size',
  TOP_FILTER_TOO_SMALL: 'use a filter radius of at least 1.5 voxels',
  TOP_NOT_CONVERGED: 'raise maxIterations (set_topology_settings) or relax changeTol, then re-run topology_solve',
  TOP_CONSTRAINT_VIOLATED: 'raise maxIterations or relax the limit (maxCompliance / volumeFraction), then re-run topology_solve',
  TOP_GREY_HIGH:
    'use the density filter with a projection (set_topology_settings projection) and a larger penalty, or accept a fuzzier layout',
  TOP_RESULT_MISSING: 'run topology_solve',
  TOP_RESULT_STALE: 'the study or the analysis changed after the solve: re-run topology_solve',
  TOP_ARTIFACT_NOT_FOUND: 'run the topology_solve transport on a machine with the artifact store; never hand-write results',
  TOP_SUMMARY_MISMATCH: 'pass the summary exactly as the transport returned it, or omit it; never hand-write results',
  TOP_DERIVED_READ_ONLY:
    'rebuild the part with ordinary commands (suggest_rebuild, extrude_profile, boolean); the iso-surface is read-only',
  TOP_REBUILD_MISSING: 'run suggest_rebuild, model the part, then compare_to_topology',
  TOP_REBUILD_DEVIATION: 'follow the contours of suggest_rebuild more closely',
  TOP_REBUILD_NOT_ANALYSED: 'run the 05 analysis on the rebuilt part',
  TOP_INPUT_UNVERIFIED: 'replace the unverified material property with a verified, sourced value',
  TOP_RESULT_NOT_RELEASABLE: 'release the rebuilt part instead of the topology iso-surface',
  TOP_TOOL_MISSING: 'install the desktop bundle (llull-compute) or use a coarser 2D grid',
  TOP_SOLVER_FAILED: 'check supports and keep-out regions',
  TOP_SOLVER_TIMEOUT: 'the run is checkpointed: re-run topology_solve with resumeFromLast=true (or a larger timeoutS, or a coarser voxel)',
};

export const refuseTopology = tableRejection(REMEDIATION);
