/**
 * CAE commands folded into a more general one: old name -> rewrite onto the replacement, applied to saved feature-history and recipe steps
 * on load (and to recorded plan actions).
 */

import type { RetiredCommandRewrite } from '@core/commands/types';

/** `delete_<kind>` with its own id key -> `delete_analysis_item { analysisId, itemId }`. */
const deleteItem =
  (idKey: string): RetiredCommandRewrite =>
  (params) => ({
    name: 'delete_analysis_item',
    params: { analysisId: params['analysisId'], ...(params[idKey] !== undefined ? { itemId: params[idKey] } : {}) },
  });

/** `<x>_report` -> `analysis_report` with the view the old command was. */
const reportView =
  (view: string): RetiredCommandRewrite =>
  (params) => ({ name: 'analysis_report', params: { ...params, view } });

const handCheck: RetiredCommandRewrite = (params) => ({ name: 'hand_check', params });

export const caeRetiredCommands: Readonly<Record<string, RetiredCommandRewrite>> = {
  delete_fea_constraint: deleteItem('constraintId'),
  delete_fea_load: deleteItem('loadId'),
  delete_result_probe: deleteItem('probeId'),
  delete_thermal_bc: deleteItem('bcId'),
  delete_thermal_contact: deleteItem('contactId'),
  delete_amplitude: deleteItem('amplitudeId'),
  delete_temperature_limit: deleteItem('limitId'),
  delete_contact: deleteItem('contactId'),
  delete_imposed_motion: deleteItem('motionId'),
  delete_rigid_wall: deleteItem('wallId'),
  fea_report: reportView('status'),
  thermal_report: reportView('thermal'),
  explicit_report: reportView('explicit'),
  dynamic_report: reportView('dynamic'),
  reliability_form: ({ sorm, ...params }) => ({
    name: 'run_reliability_study',
    params: { ...params, methods: sorm === true ? ['form', 'sorm'] : ['form'] },
  }),
  analytic_check: handCheck,
  explicit_quick_check: handCheck,
};
