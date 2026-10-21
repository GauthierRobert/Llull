/**
 * Rewrites for retired overlapping commands: `export_step_exact` into `export_step_ap242`, `bake_motion` into `evaluate_motion`,
 * `add_helix_spring` into `add_coil`, and the `remove_*` names that became `delete_*`.
 */

import type { RetiredCommandRewrite } from '../types';

type Params = Record<string, unknown>;

/** `{ name, params }` with the entries of `entries` whose value is defined. */
function call(name: string, entries: Params): ReturnType<RetiredCommandRewrite> {
  return { name, params: Object.fromEntries(Object.entries(entries).filter(([, v]) => v !== undefined)) };
}

/** Same params under the `delete_*` name. */
const renamedTo =
  (name: string): RetiredCommandRewrite =>
  (params) => ({ name, params });

export const RETIRED_MERGE_COMMANDS: Readonly<Record<string, RetiredCommandRewrite>> = {
  /** The simple exporter wrote AP214 without validation properties unless told otherwise. */
  export_step_exact: (params) => ({
    name: 'export_step_ap242',
    params: { ...params, schema: params['schema'] ?? 'ap214', includeValidationProperties: false },
  }),
  bake_motion: (params) => ({ name: 'evaluate_motion', params: { ...params, apply: true } }),

  /** A round-wire coil: wire -> section, coilRadius -> radius; the spring default colour is kept. */
  add_helix_spring: ({ wireRadius, wireDiameter, coilRadius, pitch, turns, length, closedEnds, position, axis, color, name }) =>
    call('add_coil', {
      sectionRadius: wireRadius,
      sectionDiameter: wireDiameter,
      radius: coilRadius,
      pitch,
      turns,
      length,
      closedEnds,
      position,
      axis,
      color: color ?? '#8a8f98',
      name,
    }),

  remove_decal: renamedTo('delete_decal'),
  remove_material_model: renamedTo('delete_material_model'),
  remove_property_model: renamedTo('delete_property_model'),
  remove_material_library: renamedTo('delete_material_library'),
  remove_interference_intent: renamedTo('delete_interference_intent'),
};
