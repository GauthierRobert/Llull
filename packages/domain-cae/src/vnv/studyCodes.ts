/** PHY-00 §7.1 remediation texts of the study commands (`record_convergence_study`, `check_verification`, `accept_verification_exception`, ...). */

import { tableRejection } from '@core/commands/noop';
import { feRemediation } from '../shared/feCodes';

const REMEDIATION: Readonly<Record<string, string>> = {
  VNV_ARTIFACT_NOT_FOUND: 'run run_convergence_study on a machine with the artifact store; never hand-write studies',
  VNV_SUMMARY_MISMATCH: 'pass the study exactly as run_convergence_study returned it; never hand-write values',
  VNV_LEVELS_INVALID:
    'give 3 to 6 levels (h, dt) or exactly 2 (p: order 2 then 1), finest first (index 0, 1, ...), with strictly increasing size h and finite values',
  VNV_MIXED_REFINEMENT: 'one study refines ONE thing: mesh size (h), time step (dt) or element order (p); run a separate study for each',
  VNV_LSQ_POOR_FIT: 'add finer levels or follow a smoother quantity; a reviewer may accept the fit (accept_verification_exception)',
  VNV_P_TWO_LEVEL: 'add an h study at order 2 to measure the observed order and the GCI',
  VNV_P_DIFFERENCE_ABOVE_TARGET: 'refine the mesh (h study at order 2) and re-run',
  VNV_QUANTITY_UNAVAILABLE:
    'name a quantity the results hold: a probe id (add_result_probe), field_max von_mises | u_mag of a load case, or a mode of a modal / buckling analysis',
  VNV_CASE_UNSUPPORTED:
    'studies cover solid tetrahedral meshes (C3D4 / C3D10); shell and plane-stress meshes are not studied yet; a time-step study needs a heat_transient analysis with an end time',
  VNV_STUDY_NOT_FOUND: 'list the studies with check_verification (studies[].id)',
  VNV_RATIO_TOO_SMALL: 'refine by a larger ratio (>= 1.3; below 1.1 is refused)',
  VNV_ORDER_NOT_CONVERGED: 'use levels with a constant refinement ratio',
  VNV_STUDY_STALE: 're-run the study (run_convergence_study): the analysis changed after it was run',
  VNV_NO_CONVERGENCE_STUDY: 'run run_convergence_study for the governing quantity',
  VNV_INPUT_UNVERIFIED: 'fix the material provenance (basis / source of the property models), then re-run the study',
  VNV_GCI_TARGET_UNSET: 'ask the owner or the company rule for a GCI target and pass gciTarget',
  VNV_HUMAN_GATE: 'hand the study to the qualified reviewer, who accepts the exception with a signature in the desktop app; do not retry',
  VNV_EXCEPTION_NOT_APPLICABLE: 'only a non-asymptotic, non-monotone or above-target study needs an exception; refine it instead',
  VNV_PARAM_INVALID: 'correct the value to the range given in the parameter description',
  VNV_STUDY_UNVERIFIED: 'run run_convergence_study on this machine: the study was recorded without its artifacts',
};

/** Remediation of a VNV code, else of the 05 code of the same name, else "see the command description". */
export const vnvRemediation = (code: string): string => REMEDIATION[code] ?? feRemediation(code);

/** `codedRejection` with the remediation registered for the code (VNV table, then the 05 table). */
export const refuseVnv = tableRejection(REMEDIATION, vnvRemediation);
