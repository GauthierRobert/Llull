/**
 * @layer mcp
 *
 * MCP toolsets — named domain groups of tools. A host exposes a subset of the registry
 * (e.g. `core,3d,measure`) to keep `tools/list` small for clients that load every schema.
 * Filtering is a VIEW of the registry: commands stay registered and callable through
 * `execute()` (build_project steps, UI) whatever the MCP toolsets.
 *
 * @invariant every registered command + exchange tool belongs to exactly one toolset
 * @invariant `core` is always enabled
 * @pure
 */

import { pluginToolNames } from '@core/plugins/host';

export const TOOLSET_NAMES = [
  'core',
  '2d',
  '3d',
  'measure',
  'parametric',
  'assembly',
  'exchange',
  'building',
  'civil',
] as const;

export type ToolsetName = (typeof TOOLSET_NAMES)[number];

/** Tool names per toolset. `building` is derived from the building command module. */
export const TOOLSETS: Readonly<Record<ToolsetName, readonly string[]>> = {
  core: [
    'search_tools',
    'enable_toolset',
    'describe_scene',
    'find_entities',
    'build_project',
    'check_model',
    'render_view',
    'set_units',
    'load_document',
    'clear_document',
    'move_entity',
    'move_entities',
    'rotate_entity',
    'scale_entity',
    'mirror_entity',
    'duplicate_entity',
    'duplicate_entities',
    'delete_entity',
    'delete_entities',
    'array_linear',
    'array_polar',
    'group_entities',
    'ungroup_entities',
    'set_entity_name',
    'align',
    'distribute',
    'stack_on',
    'set_parameter',
    'delete_parameter',
    'add_layer',
    'rename_layer',
    'set_layer_visibility',
    'set_layer_lock',
    'set_entity_layer',
    'delete_layer',
    'set_camera',
    'look_at',
    'fit_view',
  ],
  '2d': [
    'draw_line',
    'draw_polyline',
    'draw_arc',
    'draw_circle',
    'draw_rectangle',
    'draw_point',
    'draw_ellipse',
    'draw_spline',
    'draw_involute',
    'draw_belt_around',
    'explode_polyline',
    'offset_2d',
    'trim',
    'extend',
    'fillet_2d',
    'chamfer_2d',
    'add_text',
    'add_dimension',
  ],
  '3d': [
    'add_box',
    'add_cylinder',
    'add_sphere',
    'add_cone',
    'add_torus',
    'add_wedge',
    'add_pyramid',
    'extrude_profile',
    'extrude_sketch',
    'revolve_profile',
    'boolean_union',
    'boolean_subtract',
    'boolean_intersect',
    'fillet_edge',
    'chamfer_edge',
    'shell_solid',
    'inspect_topology',
    'make_tube_between',
    'add_spur_gear',
    'array_along_path',
    'distribute_on_arc',
    'distribute_along_path',
    'instantiate_template',
    'create_material',
    'assign_material',
  ],
  measure: [
    'measure_distance',
    'measure_angle',
    'measure_area',
    'measure_perimeter',
    'measure_bounding_box',
    'measure_volume',
    'mass_properties',
  ],
  parametric: [
    'replay_history',
    'set_step_suppressed',
    'edit_step_params',
    'reorder_step',
    'delete_step',
    'insert_step',
    'create_configuration',
    'activate_configuration',
    'add_constraint',
    'delete_constraint',
    'update_constraint',
    'solve_constraints',
    'save_recipe',
    'instantiate_recipe',
  ],
  assembly: [
    'create_component',
    'insert_instance',
    'explode_instance',
    'add_mate',
    'bill_of_materials',
    'add_joint',
    'delete_joint',
    'set_joint_value',
    'add_drive_relation',
    'delete_drive_relation',
    'evaluate_motion',
    'bake_motion',
    'motion_study',
    'animate_spin',
    'animate_oscillate',
    'stop_animation',
  ],
  exchange: [
    'export_stl',
    'export_obj',
    'export_gltf',
    'export_step_exact',
    'export_code',
    'apply_code_trace',
    'import_mesh',
    'import_dxf',
    'export_step',
    'import_step',
    'import_dwg',
    'import_code',
  ],
  /** Contributed by the installed building + industrial plugins. */
  get building(): readonly string[] {
    return pluginToolNames('building');
  },
  /** Contributed by the installed civil (site / terrain / roads / drainage) plugin. */
  get civil(): readonly string[] {
    return pluginToolNames('civil');
  },
};

interface ParsedToolsets {
  /** Enabled toolsets; always contains `core`. */
  readonly enabled: ReadonlySet<ToolsetName>;
  /** Requested names that are not toolsets (ignored). */
  readonly unknown: readonly string[];
}

function isToolsetName(value: string): value is ToolsetName {
  return (TOOLSET_NAMES as readonly string[]).includes(value);
}

/**
 * Parse a comma-separated toolset list (the `LLULL_TOOLSETS` value).
 * @invariant unset / empty -> `core` only (agents load the rest via search_tools / enable_toolset)
 * @invariant `all` -> every toolset
 * @failure unknown names -> listed in `unknown`, otherwise ignored
 */
export function parseToolsets(raw: string | undefined): ParsedToolsets {
  const requested = (raw ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  const unknown = requested.filter((name) => name !== 'all' && !isToolsetName(name));
  if (requested.includes('all')) {
    return { enabled: new Set(TOOLSET_NAMES), unknown };
  }
  const enabled = new Set<ToolsetName>(['core', ...requested.filter(isToolsetName)]);
  return { enabled, unknown };
}

/** The toolset a tool belongs to, or `undefined` for a tool no toolset lists. */
export function toolsetOf(toolName: string): ToolsetName | undefined {
  return TOOLSET_NAMES.find((toolset) => TOOLSETS[toolset].includes(toolName));
}

/**
 * True when `toolName` is exposed under `enabled`.
 * @invariant a tool no toolset lists is always enabled (fail open: never hide a new tool)
 */
export function isToolEnabled(toolName: string, enabled: ReadonlySet<ToolsetName>): boolean {
  const toolset = toolsetOf(toolName);
  return toolset === undefined || enabled.has(toolset);
}

/** Prompts whose workflow calls a toolset's tools directly; unlisted prompts need only `core`. */
const PROMPT_TOOLSETS: Readonly<Record<string, ToolsetName>> = {
  design_building: 'building',
  design_factory: 'building',
  design_site: 'civil',
};

/** True when the MCP prompt `promptName` only references enabled tools. */
export function isPromptEnabled(promptName: string, enabled: ReadonlySet<ToolsetName>): boolean {
  const toolset = PROMPT_TOOLSETS[promptName];
  return toolset === undefined || enabled.has(toolset);
}
