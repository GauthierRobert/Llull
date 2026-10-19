/** PHY-09 §7.1 stable codes: remediation texts for refusals and check items (AF-11). */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { codedRejection } from '@core/commands/noop';
import { refuseCode } from '../shared/codes';
import { feRemediation } from '../shared/feCodes';

const REMEDIATION: Readonly<Record<string, string>> = {
  DYN_CASE_TYPE: 'create a frequency_response or random_response analysis with create_analysis and use its id',
  DYN_BASIS_MISSING: 'pass modes (1-100, e.g. enough to pass 1.5 x the top of the excitation band) or fMaxHz to create_analysis',
  DYN_DAMPING_UNSET: 'set_dynamic_damping with a cited value (there is no default damping), or pass zeta / Q to the quick check',
  DYN_DAMPING_INVALID: 'keep 0 <= zeta < 1, alpha >= 0, beta >= 0, f1Hz < f2Hz, mode ranges 1 <= from <= to; cite the source',
  DYN_MATERIAL_NO_DAMPING:
    'add a structuralLossFactor property model to the part material (define_property_model, PHY-01) or use modal damping',
  DYN_POST_TOO_LARGE: 'install the desktop bundle (llull-compute) or build it with cargo build --release in solver/, or mesh more coarsely',
  DYN_SWEEP_INVALID: 'give 0 < fMinHz < fMaxHz, pointsPerInterval >= 2 and bias >= 1 (CalculiX limits)',
  DYN_SWEEP_UNSET: 'set_frequency_sweep { analysisId, fMinHz, fMaxHz }',
  DYN_BASE_UNSET: 'set_base_excitation with a direction and a spectrum (random) or amplitudeG (frequency response)',
  DYN_BASE_INVALID:
    'random_response needs spectrum (a defined vibration spectrum) and no amplitudeG; frequency_response needs amplitudeG > 0',
  DYN_BASE_NO_CONSTRAINT:
    'add a fixed, pinned or zero-displacement constraint on the base faces for that direction (*BASE MOTION drives every homogeneous constraint of the DOF)',
  DYN_SPECTRUM_INVALID: 'give >= 2 breakpoints [fHz, level] with strictly increasing fHz > 0 and level > 0, or a library name',
  DYN_SPECTRUM_UNKNOWN: 'define_vibration_spectrum first (list them with describe_vibration_library)',
  DYN_SPECTRUM_IN_USE: 'point the analyses that use it to another spectrum first (set_base_excitation)',
  DYN_SPECTRUM_UNVERIFIED: 'replace the spectrum with the primary standard values (grade A) before a qualification decision',
  DYN_NAME_TAKEN: 'choose another name or delete the existing entry first',
  DYN_NAME_INVALID: 'names are 1-40 characters of a-z, 0-9 and _',
  DYN_HISTORY_INVALID: 'give equal-length finite timeS / values with strictly increasing times (uniform sampling for SRS input)',
  DYN_HISTORY_UNKNOWN: 'define_time_history first',
  DYN_SAMPLING_TOO_COARSE: 'resample the history (dt <= 1 / (10 fMaxHz)) or lower fMaxHz',
  DYN_BAND_ABOVE_MODES: 'increase modes: keep modes up to 1.5 x the top of the excitation band',
  DYN_MODAL_TRUNCATION: 'increase modes until the cumulative effective mass reaches the threshold (residual vectors are V2)',
  DYN_TRUNCATION_THRESHOLD_UNSET: 'set_dynamic_basis modalTruncationThreshold (the company rule; llull ships no default)',
  DYN_PSD_GRID_NOT_CONVERGED: 'report it: the adaptive grid failed its halving check (an internal accuracy signal)',
  DYN_RESULTS_STALE: 'run fea_mesh and fea_solve again: an input changed since the solve',
  DYN_RESULTS_MISSING: 'run fea_mesh and fea_solve on this machine (the results artifact must be in the store)',
  DYN_MILES_NOT_ANSWER: "Miles' equation is a quick check: run a random_response analysis and use its probe or nodal rms",
  DYN_TARGET_NOT_STATIC: 'create a static analysis (create_analysis analysisType static) and pass its id as targetAnalysisId',
  DYN_PROBE_NOT_FOUND: 'name an acceleration probe (a_x / a_y / a_z) of the random_response case',
  DYN_PROBE_QUANTITY: 'random_response probes read a_x/y/z, u_x/y/z_rel, s_xx/yy/zz; frequency_response probes u_x/y/z, s_xx/yy/zz',
  DYN_REVIEW_PENDING: 'a qualified reviewer dispositions the result before any qualification decision (05 dispose_margin)',
  DYN_PARAM_NOT_APPLICABLE: 'drop the parameter: it does not apply to this kind of input',
};

const dynRemediation = (code: string): string => REMEDIATION[code] ?? feRemediation(code);

/** Refusal with the remediation of `code` (DYN_* here, FEA_* set-up codes from the shared table). */
export function refuseDyn(
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): CommandResult {
  if (Object.hasOwn(REMEDIATION, code)) return codedRejection(doc, command, code, message, dynRemediation(code), ids, paths);
  return refuseCode(doc, command, code, message, ids, paths);
}

export interface DynamicCheckItem {
  readonly code: string;
  readonly severity: 'error' | 'warning';
  readonly ids: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

export const checkItem = (
  code: string,
  severity: DynamicCheckItem['severity'],
  message: string,
  ids: readonly string[],
): DynamicCheckItem => ({ code, severity, ids, message, remediation: dynRemediation(code) });

export const REVIEW_REASON =
  'computed by llull, not approved: a qualified dynamics engineer must review the damping, the spectrum and the modal basis';
