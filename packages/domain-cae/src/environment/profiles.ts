/**
 * Outgassing limit profiles (FR-ENV-02) as data. Shipped profiles come from docs/physics/14-moisture-outgassing/validation/environment_rules.json:
 * NASA GSFC screening (database background, verified), ECSS-Q-ST-70-02C general acceptance (secondary: test-lab quotation of the standard).
 * No material E595 value is bundled: material data is the user's (set_material_property) or an imported library.
 */

import type { OutgassingLimit, OutgassingProfile } from './types';

const SHIPPED_PROFILES: Readonly<Record<string, OutgassingProfile>> = {
  nasa_gsfc_screening: {
    id: 'nasa_gsfc_screening',
    label: 'NASA GSFC outgassing screening (database background, ASTM E595)',
    limits: [
      { quantity: 'TML', op: '<=', value: 1.0, unit: '%' },
      { quantity: 'CVCM', op: '<=', value: 0.1, unit: '%' },
    ],
    testMethod: 'ASTM_E595',
    source:
      'outgassing.nasa.gov / GSFC ETD outgassing database background: maximum TML 1.0 %, maximum CVCM 0.10 % (ASTM E595); GSFC PD-1410 words it as strict less-than; programs may tailor',
    status: 'verified',
  },
  ecss_q_st_70_02: {
    id: 'ecss_q_st_70_02',
    label: 'ECSS-Q-ST-70-02C general acceptance',
    limits: [
      { quantity: 'RML', op: '<', value: 1.0, unit: '%' },
      { quantity: 'CVCM', op: '<', value: 0.1, unit: '%' },
    ],
    testMethod: 'ECSS_Q_ST_70_02',
    source:
      'ECSS-Q-ST-70-02C (2008) as quoted by a test-lab report: RML < 1.00 %, CVCM < 0.10 %; the standard notes acceptance depends on the application and can be more severe',
    status: 'secondary',
  },
};

export const SHIPPED_PROFILE_IDS: readonly string[] = Object.keys(SHIPPED_PROFILES);

/** Absolute guard (percent) on limit comparisons (TR-ENV-02): a value stored as a fraction and read back in percent must not flip at the limit. */
export const LIMIT_GUARD = 1e-12;

/** Whether `value` meets `limit`: `<` passes below the limit, `<=` at or below it. */
export function meetsLimit(value: number, limit: OutgassingLimit): boolean {
  return limit.op === '<' ? value < limit.value - LIMIT_GUARD : value <= limit.value + LIMIT_GUARD;
}

export function shippedProfile(id: string): OutgassingProfile | undefined {
  return Object.hasOwn(SHIPPED_PROFILES, id) ? SHIPPED_PROFILES[id] : undefined;
}

/** The profile a document or call names: a shipped id, a stored custom profile, or undefined for an unknown id. */
export function resolveProfile(reference: string | OutgassingProfile): OutgassingProfile | undefined {
  return typeof reference === 'string' ? shippedProfile(reference) : reference;
}
