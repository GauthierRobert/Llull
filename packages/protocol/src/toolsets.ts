/**
 * Toolsets: named tool groups (e.g. `core`, `3d`, `measure`) the `llull` CLI lists by (`llull toolsets`, `llull list <toolset>`)
 * and the UI command palette groups by. A VIEW of the registry: every command stays callable through `execute()`.
 * @invariant every registered command + exchange / FE / library / native tool belongs to exactly one toolset
 */

import { pluginToolNames } from '@core/plugins/host';
import { nativeToolNames } from './nativeTools';

export const TOOLSET_NAMES = [
  'core',
  '2d',
  '3d',
  'measure',
  'parametric',
  'assembly',
  'materials',
  'material-lab',
  'analysis',
  'review',
  'manufacturing',
  'fasteners',
  'aerodynamics',
  'fluids',
  'flow',
  'exchange',
  'building',
  'piping',
  'civil',
  'design',
  'pmi',
  'plm',
  'scan',
  'mesh',
  'implicit',
] as const;

export type ToolsetName = (typeof TOOLSET_NAMES)[number];

const words = (list: string): readonly string[] => list.split(' ');

const PMI_CORE_TOOLS = words(
  'set_pmi_standard add_datum_feature add_datum_target add_size_dimension add_location_dimension add_geometric_tolerance add_surface_texture add_pmi_note update_pmi delete_pmi create_saved_view update_saved_view delete_saved_view activate_saved_view list_pmi check_pmi accept_pmi_review analyze_stackup fastener_tolerance apply_pmi_set',
);

const ANALYSIS_CORE_TOOLS = words(
  'check_prototype check_assembly check_mechanism check_motion_clearance check_dynamics engine_quick_check compare_to_reference check_timestep_convergence fea_mesh fea_solve fea_export fea_import_field fea_import_results',
);

/** Core part-modelling features (07 FTR §4.1); the sheet-metal plugin adds its commands to the same toolset. */
const MANUFACTURING_CORE_TOOLS: readonly string[] = words(
  'add_hole add_tapped_hole add_external_thread add_pocket add_rib set_thread recognize_features holes_from_recognition check_machining hole_table',
);

/**
 * Tools an agent browsing one toolset looks for but that belong to another (each tool stays in exactly one toolset): listings point to them.
 * Holes, pockets and ribs are part features in most CAD tools, but here they are the 07 FTR `manufacturing` set (ENG-9).
 */
export const TOOLSET_SEE_ALSO: Partial<Record<ToolsetName, { readonly toolset: ToolsetName; readonly tools: readonly string[] }>> = {
  '3d': { toolset: 'manufacturing', tools: words('add_hole add_tapped_hole add_external_thread add_pocket add_rib') },
};

/** Industrial piping commands: contributed by the `building` (industrial) plugin, exposed as their own small toolset. */
const PIPING_TOOLS = words('add_pipe_run add_pipe_support add_cable_tray check_pipe_supports pipe_hydraulics');

/** Tool names per toolset; `building` / `civil` / the FE part of `analysis` come from their plugins. */
export const TOOLSETS: Readonly<Record<ToolsetName, readonly string[]>> = {
  core: words(
    'describe_scene find_entities build_project check_model render_view set_units load_document document_content_hash clear_document move_entities rotate_entity scale_entity mirror_entity duplicate_entities delete_entities array_linear array_polar group_entities ungroup_entities set_entity_name set_entity_color set_face_color align distribute stack_on set_parameter delete_parameter add_layer update_layer set_entity_layer delete_layer set_camera fit_view kernel_info set_modeling_tolerance set_selection',
  ),
  '2d': words(
    'draw_polyline draw_arc draw_rectangle draw_point draw_ellipse draw_spline draw_involute draw_belt_around create_sketch_plane place_on_sketch_plane project_edges_to_sketch break_sketch_link explode_polyline offset_2d trim extend fillet_2d chamfer_2d add_text add_dimension add_image_underlay calibrate_underlay set_underlay image_to_world create_sheet create_drawing_view add_section_view add_detail_view update_drawing_view delete_drawing_view update_sheet delete_sheet export_sheet_svg',
  ),
  '3d': words(
    'add_box add_cylinder add_sphere add_cone add_torus add_coil add_helix add_bearing add_wedge add_pyramid extrude_profile revolve_profile sweep_profile loft_sections boolean blend_union fillet_edge chamfer_edge probe_fillet shell_solid draft_faces push_pull_face split_face replace_face split_body inspect_topology inspect_faces add_spur_gear add_internal_gear add_planetary_gearset add_bevel_gear add_bevel_gear_pair add_spline_shaft add_keyed_shaft pattern_along_path add_decal delete_decal add_subdivision_solid edit_subdivision_cage set_cage_crease set_cage_symmetry extrude_cage_faces inset_cage_faces loop_cut_cage select_cage_elements evaluate_subdivision check_subdivision surface_from_curves create_nurbs_curve interpolate_curve create_conic edit_nurbs inspect_nurbs analyze_curve_curvature create_nurbs_surface surface_from_points loft_surface fill_surface trim_surface sew_surfaces thicken_surface blend_surfaces approximate_curve analyze_surface_curvature check_continuity measure_deviation analyze_draft check_surface_quality inspect_sweep check_sweep_loft ruled_surface sweep_surface network_surface scale_nonuniform twist_body taper_body stretch_body bend_body analyze_deformation check_deformation import_font list_fonts text_outline unwrap_face wrap_to_face project_to_face emboss_on_face check_wrap',
  ),
  measure: words(
    'check_blends measure_distance measure_angle measure_area measure_perimeter measure_bounding_box mass_properties geometric_validation_properties',
  ),
  parametric: words(
    'replay_history set_step_suppressed edit_step_params reorder_step delete_step insert_step create_configuration activate_configuration add_constraint delete_constraint update_constraint solve_constraints save_recipe instantiate_recipe',
  ),
  assembly: words(
    'create_component insert_instance explode_instance bill_of_materials add_joint delete_joint set_joint_value add_drive_relation delete_drive_relation evaluate_motion motion_study create_contact_set delete_contact_set drive_joint_to create_exploded_view set_active_exploded_view delete_exploded_view animate stop_animation ' +
      'add_rigid_body add_body_joint add_gear_coupling add_spring add_motor add_propeller add_cylinder_pressure set_engine_losses add_reference_data set_gravity delete_dynamics_item set_dynamics_solver inspect_dynamics list_dynamics_loads simulate_motion plot_simulation render_motion',
  ),
  materials: words(
    'create_material assign_material define_material_record set_material_property get_material get_material_allowable convert_quantity import_material_library delete_material_library resolve_material_libraries diff_material_libraries set_export_marking check_materials register_material_library ' +
      'define_property_model delete_property_model evaluate_property sample_property fit_property_model check_property_models add_material_model delete_material_model define_constitutive_set check_material_models',
  ),
  'material-lab': words('fit_material_model material_point_response export_material_cards'),
  review: words(
    'allow_interference delete_interference_intent set_part_grounded save_viewpoint list_viewpoints delete_viewpoint create_walkthrough delete_walkthrough render_walkthrough create_review_issue delete_review_issue export_bcf set_review_disposition',
  ),
  exchange: words(
    'export_stl export_obj export_gltf export_3mf export_urdf mesh_to_solid export_step_ap242 export_iges import_iges verify_exchange_file export_code apply_code_trace import_mesh import_dxf import_step_exact export_step import_step import_dwg import_code',
  ),
  /** Core analytic checks plus the finite-element commands contributed by the installed cae plugin. */
  get analysis(): readonly string[] {
    return [...ANALYSIS_CORE_TOOLS, ...pluginToolNames('analysis'), ...nativeToolNames('analysis')];
  },
  /** GD&T / PMI commands plus the native Monte Carlo stack-up transport. */
  get pmi(): readonly string[] {
    return [...PMI_CORE_TOOLS, ...nativeToolNames('pmi')];
  },
  /** Core hole / pocket / recognition commands plus the sheet-metal plugin's commands. */
  get manufacturing(): readonly string[] {
    return [...MANUFACTURING_CORE_TOOLS, ...pluginToolNames('manufacturing')];
  },
  /** Contributed by the installed fasteners plugin. */
  get fasteners(): readonly string[] {
    return pluginToolNames('fasteners');
  },
  /** Contributed by the installed aerodynamics plugin (atmosphere, airfoils, wings, drag, cycling) + the native vortex-lattice transport. */
  get aerodynamics(): readonly string[] {
    return [...pluginToolNames('aerodynamics'), ...nativeToolNames('aerodynamics')];
  },
  /** Contributed by the installed fluids plugin (compressible flow, rocket nozzles). */
  get fluids(): readonly string[] {
    return pluginToolNames('fluids');
  },
  /** Contributed by the installed cfd plugin (flow cases, geometry preparation, checks, records) + the native `cfd_solve` transport; palette group "Flow". */
  get flow(): readonly string[] {
    return [...pluginToolNames('flow'), ...nativeToolNames('flow')];
  },
  /** Contributed by the installed building + industrial plugins. */
  get building(): readonly string[] {
    return pluginToolNames('building').filter((name) => !PIPING_TOOLS.includes(name));
  },
  /** Industrial pipe runs, supports, cable trays and hydraulics (industrial plugin) plus the plant piping plugin (02 RTE). */
  get piping(): readonly string[] {
    return [
      ...pluginToolNames('building').filter((name) => PIPING_TOOLS.includes(name)),
      ...pluginToolNames('piping'),
      ...nativeToolNames('piping'),
    ];
  },
  /** Contributed by the installed civil (site / terrain / roads / drainage) plugin. */
  get civil(): readonly string[] {
    return pluginToolNames('civil');
  },
  /** Contributed by the installed PLM plugin (revisions, release, change control, effectivity, traceability). */
  get plm(): readonly string[] {
    return pluginToolNames('plm');
  },
  /** Contributed by the installed design-language plugin (`.lld`). */
  get design(): readonly string[] {
    return pluginToolNames('design');
  },
  /** Triangle-mesh modelling (07 MSH): file import, analyze / check, hull, Minkowski, offset, hollow, wrap, subdivision. */
  mesh: words('import_mesh_file analyze_mesh check_mesh convex_hull minkowski_sum offset_mesh hollow_mesh repair_mesh subdivide_mesh'),
  /** Implicit / field modelling and lattices (05 IMP): contributed by the installed implicit plugin. */
  get implicit(): readonly string[] {
    return pluginToolNames('implicit');
  },
  /** Point clouds (plant 10): the host transport `scan_import` plus the installed scan plugin's commands. */
  get scan(): readonly string[] {
    return [...nativeToolNames('scan'), ...pluginToolNames('scan')];
  },
};

export function isToolsetName(value: string): value is ToolsetName {
  return (TOOLSET_NAMES as readonly string[]).includes(value);
}

/** The toolset a tool belongs to, or `undefined` for a tool no toolset lists. */
export function toolsetOf(toolName: string): ToolsetName | undefined {
  return TOOLSET_NAMES.find((toolset) => TOOLSETS[toolset].includes(toolName));
}
