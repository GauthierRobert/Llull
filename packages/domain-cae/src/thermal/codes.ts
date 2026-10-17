/** PHY-03 §7.1 stable codes: remediation texts for refusals and check items. */

import type { CadDocument } from '@core/model/types';
import type { CommandResult } from '@core/commands/types';
import { refuseCode } from '../shared/codes';
import { codedRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  THM_CASE_TYPE: 'create a heat_steady / heat_transient analysis with create_analysis and use its id',
  THM_UNITS_MISMATCH: 'give { value, unit } with the documented unit: temperature degC | K | degF, W/(m^2*K) film, W/m^2 flux, W power',
  THM_EMISSIVITY_INVALID: 'give a hemispherical emissivity between 0 and 1 with a source (PHY-15 emissivityIr is not built)',
  THM_FILM_INVALID: 'give a positive film coefficient h in W/(m^2*K) with a source',
  THM_SOURCE_REQUIRED:
    'add source: { citation } (datasheet, correlation or company rule); film coefficients and emissivities are never defaulted',
  THM_AMPLITUDE_INVALID:
    'give strictly increasing finite times with finite factors (table), or positive periodS / sampleStepS / durationS (sine, ramp)',
  THM_AMPLITUDE_IN_USE: 'update or delete the thermal BCs that reference the amplitude first',
  THM_STEP_INVALID: 'set_thermal_step: endTimeS > 0 for a transient, increments > 0 (min <= initial <= max <= end), one output option',
  THM_INITIAL_TEMPERATURE_MISSING:
    'set_initial_temperature { analysisId, value, unit } (a transient case has no default; a steady cavity-radiation case should start near its expected temperatures)',
  THM_MATERIAL_NO_K: 'define_property_model on the part material with property k (W/(m*K)), a valid T range and a source',
  THM_MATERIAL_NO_CP:
    'define_property_model with property cp (J/(kg*K)); a transient also needs density (model or create_material density)',
  THM_MATERIAL_K_ORTHO:
    'give the conductivity models of directions 1, 2 and 3 (define_property_model with direction), or one model without a direction',
  THM_MATERIAL_ORTHO_ROTATED:
    'orthotropic k follows the document X / Y / Z axes: use a part with rotation [0, 0, 0] (model the part in the rotated position) or an isotropic k',
  THM_MATERIAL_UNVERIFIED: 'replace the typical / unstated value by a verified, sourced model; results stay flagged until then',
  THM_PROPERTY_OUT_OF_RANGE: 'widen the tabulation inside the model equation range, or define a model sourced for the temperatures reached',
  THM_NO_HEAT_PATH: 'add a sink: add_thermal_bc kind temperature, film or radiation (the steady problem has no unique solution)',
  THM_CONSTANT_INVALID:
    'give a finite positive Stefan-Boltzmann constant in W/(m^2*K^4) and source: { citation } naming where the value comes from',
  THM_RADIATION_SCALE: 'recreate the case with temperatureScale degC or K (radiation is evaluated on absolute temperature)',
  THM_CAVITY_INVALID: 'give a unique cavity name of at most 3 characters and at least 2 faces',
  THM_CONTACT_INVALID: 'give master and slave targets on different parts and a positive conductance in W/(m^2*K)',
  THM_CONTACT_NOT_FOUND: 'list the contacts with describe_analysis (ids are tc-<step>.<k>)',
  THM_BC_CONFLICT: 'keep one temperature BC per face (delete_thermal_bc), or move one to other faces, then re-mesh',
  THM_HEAT_BALANCE: 'refine the mesh or time step and check the boundary conditions; do not report the result as final',
  THM_NO_LIMITS: 'add_temperature_limit with a datasheet or rule citation',
  THM_LIMIT_SOURCE_REQUIRED: 'add source: { citation } (component datasheet, company rule or material record)',
  THM_LIMIT_INVALID: 'give an entityId or a target of a part of the case and at least one of min / max (min < max) as temperatures',
  THM_BC_NOT_FOUND: 'list the BCs with describe_analysis (ids are tb-<step>.<k>)',
  THM_AMPLITUDE_NOT_FOUND: 'list the amplitudes with describe_analysis (ids are am-<step>.<k>)',
  THM_LIMIT_NOT_FOUND: 'list the limits with describe_analysis or check_temperature_limits (row ids are <limitId>:<max|min>)',
  THM_LIMIT_EXCEEDED: 'redesign; only a qualified reviewer can disposition an exceeded limit (dispose_thermal_limit)',
  THM_LIMIT_MARGINAL: 'redesign or have a qualified reviewer disposition the row (dispose_thermal_limit)',
  THM_MARGINAL_BAND_UNSET: 'ask the owner or the company rule for a margin band in K and pass marginalBandK',
  THM_DISPOSITION_UNVERIFIED:
    'the stored disposition does not verify (no signing port, or no / a wrong signature): the qualified reviewer records it again with dispose_thermal_limit',
  THM_DISPOSITION_PENDING: 'a qualified reviewer dispositions the row in the desktop app (dispose_thermal_limit with a signature)',
  THM_HUMAN_GATE: 'hand over to the qualified reviewer: the disposition needs a human-held signature (09 PLM)',
  THM_TABLE_POINTS: 'narrow the temperature range or use a smoother property model: the solver table would exceed 500 points',
  FEA_RESULTS_STALE: 'the analysis inputs changed after the solve: run fea_mesh and fea_solve again',
  FEA_RESULTS_MISSING: 'run fea_mesh and fea_solve (the host must provide the artifact store)',
  PROP_OUT_OF_RANGE: 'stay inside the property model equation range or define a model sourced for the temperatures of the case',
};

export const remediationOf = (code: string): string => REMEDIATION[code] ?? 'see the command description';

/** `refuse` with the remediation of `code` (THM_* and results codes here, FEA_* set-up codes from the shared table). */
export function refuseThermal(
  doc: CadDocument,
  command: string,
  code: string,
  message: string,
  ids: readonly string[] = [],
  paths: readonly string[] = [],
): CommandResult {
  if (Object.hasOwn(REMEDIATION, code)) return codedRejection(doc, command, code, message, remediationOf(code), ids, paths);
  return refuseCode(doc, command, code, message, ids, paths);
}
