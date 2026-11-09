/** Stable ENV_* codes of the space-environment commands (TECHNICAL_SPEC §7.1) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  ENV_PROFILE_UNSET:
    'set_mission_environment outgassingProfile=<id> (llull describe check_space_environment lists the shipped ids), or pass `profile`',
  ENV_PROFILE_UNKNOWN:
    'use a shipped id (nasa_gsfc_screening, ecss_q_st_70_02) or define a custom profile with its source in set_mission_environment',
  ENV_SOURCE_MISSING: 'state where the value comes from (report, standard, analysis revision) in `source`',
  ENV_PARAM_INVALID:
    'follow the parameter description (positive thickness / diffusivity, fractions strictly between 0 and 1, units of the right dimension)',
  ENV_PROPERTY_MISSING: 'give the value as a parameter or add the property to the material with set_material_property',
  ENV_FLUENCE_UNSET: 'pass `fluence` (with its source) or record it with set_mission_environment aoFluence',
  ENV_EQUIVALENT_TEMPERATURE_INVALID:
    'beta / alpha differs between directions: use the laminate hygrothermal path of the composites pack instead of an equivalent temperature',
};

export const refuseEnv = tableRejection(REMEDIATION);

/** A finding of a calculation or check, reported in `data.items`. */
export interface EnvItem {
  readonly code: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly message: string;
}

/** Warning carried by every result computed from a value that is user supplied without a source, typical or otherwise not a verified record. Not suppressible. */
export const unverifiedItem = (what: string): EnvItem => ({
  code: 'ENV_VALUE_UNVERIFIED',
  severity: 'warning',
  message: `${what} is not a verified value (no source, typical or secondary basis): replace it with sourced data before relying on the result`,
});
