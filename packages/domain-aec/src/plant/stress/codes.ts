/** Stable `PST_*` codes of the pipe stress commands (07 PST §7, AF-11) with their one-line remediation. */

import { tableRejection } from '@core/commands/noop';

const REMEDIATION: Readonly<Record<string, string>> = {
  PST_PARAM_INVALID: 'Fix the parameter named in the error paths (units are stated in each parameter description).',
  PST_MATERIAL_NOT_FOUND: 'Create the material first (create_material) or use table "carbon-steel-c1" / meanCtePerK.',
  PST_MATERIAL_NO_DATA: 'define_property_model with property thermalStrain (preferred) or cte on the material, or pass meanCtePerK.',
  PST_TEMPERATURE_OUT_OF_TABLE: 'Use temperatures inside the stated range or extend the material table; llull never extrapolates.',
};

export const refuse = tableRejection(REMEDIATION);

/** Non-hideable warning raised when the edition requires ASME B31J and only the appendix D value is available (07 PST §5.7). */
export const SIF_EDITION_WARNING = {
  code: 'PST_SIF_EDITION',
  message: 'this edition requires ASME B31J factors (tables not public); the code appendix D value is used and may under-state the SIF',
  remediation: 'Give the B31J values with rule "user" (userSif) or have a qualified engineer confirm.',
} as const;
