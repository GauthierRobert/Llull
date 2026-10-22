/**
 * Golden replay corpus — representative `build_project` plans.
 * Plans reference earlier results via `as` aliases, never literal ids.
 */

import { pngDataUrl } from '../helpers/imageFixtures';
import { xy, xyz } from '../helpers/xy';
import { referenceEnginePlan } from './referenceEnginePlan';
import { swgPlan } from '../helpers/swgPack';

export interface GoldenAction {
  command?: string;
  params?: Record<string, unknown>;
  as?: string;
  repeat?: { count: number | string; as?: string };
  for_each?: { values: unknown[] | string; as: string };
  step?: { command: string; params?: Record<string, unknown> };
  for?: { var: string; from: number | string; to: number | string; step?: number | string };
  actions?: GoldenAction[];
}

const CUBE_COMPONENT: GoldenAction[] = [
  { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
  { command: 'create_component', params: { name: 'Cube', entityIds: ['$b'], componentId: 'comp-cube' } },
];

const cubeInstance = (x: number, as: string): GoldenAction => ({
  command: 'insert_instance',
  params: { componentId: 'comp-cube', position: [x, 0, 0] },
  as,
});

export const plans: Record<string, GoldenAction[]> = {
  '2d_lines_polylines': [
    { command: 'draw_polyline', params: { points: xy(0, 0, 10, 5) } },
    { command: 'draw_polyline', params: { points: xy(0, 0, 4, 0, 4, 3), closed: false } },
    { command: 'draw_polyline', params: { points: xy(0, 0, 5, 0, 5, 5, 0, 5), closed: true } },
    { command: 'draw_point', params: { position: [1, 1, 0] } },
  ],
  '2d_arcs_circles': [
    { command: 'draw_arc', params: { center: [0, 0], radius: 5, startAngle: 0, endAngle: Math.PI } },
    { command: 'draw_arc', params: { center: [3, 3], radius: 2 } },
    { command: 'draw_arc', params: { center: [-3, 3], radius: 1.5, color: '#ff0000' } },
  ],
  '2d_rectangles': [
    { command: 'draw_rectangle', params: { width: 10, height: 4 } },
    { command: 'draw_rectangle', params: { width: 2, height: 2, position: [5, 5, 0] } },
  ],
  '2d_spline_ellipse': [
    { command: 'draw_spline', params: { points: xy(0, 0, 2, 3, 5, 1, 8, 4) } },
    { command: 'draw_spline', params: { points: xy(0, 0, 3, 0, 3, 3, 0, 3), closed: true } },
    { command: 'draw_ellipse', params: { center: [0, 0], radiusX: 6, radiusY: 3 } },
  ],
  '2d_image_underlay': [
    { command: 'add_image_underlay', params: { dataUrl: pngDataUrl(400, 300) }, as: 'scan' },
    {
      command: 'calibrate_underlay',
      params: {
        id: '$scan',
        pixelA: [50, 250],
        pixelB: [350, 245],
        distance: 450,
        origin: { pixel: [50, 250], world: [0, 0, 0] },
        align: 'x',
      },
    },
    { command: 'set_underlay', params: { id: '$scan', opacity: 0.3, locked: true } },
  ],
  '2d_text_dimensions': [
    { command: 'draw_point', params: { position: [0, 0, 0] }, as: 'p1' },
    { command: 'draw_point', params: { position: [10, 0, 0] }, as: 'p2' },
    { command: 'add_text', params: { content: 'Hello', position: [0, 5, 0], height: 2 } },
    { command: 'add_dimension', params: { dimensionKind: 'linear', entityIds: ['$p1', '$p2'], offset: 3 } },
    { command: 'add_dimension', params: { dimensionKind: 'aligned', entityIds: ['$p1', '$p2'] } },
  ],
  modify2d_offset_trim_extend: [
    { command: 'draw_polyline', params: { points: xy(0, 0, 10, 0) }, as: 'a' },
    { command: 'draw_polyline', params: { points: xy(5, -5, 5, 5) }, as: 'b' },
    { command: 'draw_polyline', params: { points: xy(0, 3, 3, 3) }, as: 'c' },
    { command: 'draw_polyline', params: { points: xy(8, -4, 8, 8) }, as: 'd' },
    { command: 'trim', params: { id: '$a', boundaryId: '$b' } },
    { command: 'extend', params: { id: '$c', boundaryId: '$d' } },
    { command: 'draw_polyline', params: { points: xy(0, 10, 5, 10, 5, 15) }, as: 'pl' },
    { command: 'offset_2d', params: { id: '$pl', distance: 1 } },
  ],
  modify2d_fillet_chamfer_explode: [
    { command: 'draw_polyline', params: { points: xy(0, 0, 10, 0, 10, 10) }, as: 'f' },
    { command: 'fillet_2d', params: { id: '$f', radius: 2, vertexIndex: 1 } },
    { command: 'draw_polyline', params: { points: xy(20, 0, 30, 0, 30, 10) }, as: 'c' },
    { command: 'chamfer_2d', params: { id: '$c', distance: 2, vertexIndex: 1 } },
    { command: 'draw_polyline', params: { points: xy(0, 20, 5, 20, 5, 25, 0, 25), closed: true }, as: 'e' },
    { command: 'explode_polyline', params: { id: '$e' } },
  ],
  '3d_box_cylinder_sphere': [
    { command: 'add_box', params: { size: [2, 3, 4] } },
    { command: 'add_cylinder', params: { radius: 1, height: 5, position: [5, 0, 0] } },
    { command: 'add_sphere', params: { radius: 1.5, position: [10, 0, 0], color: '#00ff00' } },
  ],
  '3d_cone_torus_wedge_pyramid': [
    { command: 'add_cone', params: { radius: 2, height: 4 } },
    { command: 'add_torus', params: { ringRadius: 3, tubeRadius: 0.5, position: [8, 0, 0] } },
    { command: 'add_wedge', params: { size: [2, 2, 2], position: [0, 8, 0] } },
    { command: 'add_pyramid', params: { baseWidth: 3, baseDepth: 3, height: 4, position: [8, 8, 0] } },
  ],
  extrude_profile_from_sketch_and_points: [
    { command: 'draw_rectangle', params: { width: 4, height: 2 }, as: 'r' },
    { command: 'extrude_profile', params: { id: '$r', depth: 3 } },
    { command: 'extrude_profile', params: { profile: xy(0, 0, 4, 0, 2, 3), depth: 2, position: [10, 0, 0] } },
  ],
  revolve_profile: [
    { command: 'revolve_profile', params: { profile: xy(1, 0, 2, 0, 2, 1, 1, 1), axis: 'z', angle: Math.PI * 2, segments: 8 } },
    { command: 'revolve_profile', params: { profile: xy(1, 0, 3, 0, 3, 2), axis: 'y', angle: Math.PI, segments: 6, position: [10, 0, 0] } },
  ],
  closed_sweep_and_chain_pattern: [
    { command: 'draw_arc', params: { center: [0, 0], radius: 40 }, as: 'loop' },
    { command: 'sweep_profile', params: { pathId: '$loop', radius: 3, innerRadius: 2 } },
    { command: 'add_box', params: { size: [8, 2, 4] }, as: 'link' },
    { command: 'pattern_along_path', params: { sourceId: '$link', count: 12, pathId: '$loop', rollStep: Math.PI / 2 } },
  ],
  subdivision_saddle: [
    {
      command: 'add_subdivision_solid',
      params: { box: { size: [270, 140, 30], segments: [4, 2, 1] }, levels: 2, name: 'saddle' },
      as: 'saddle',
    },
    {
      command: 'edit_subdivision_cage',
      params: { id: '$saddle', region: { min: [60, -100, -50], max: [200, 100, 50] }, scale: [1, 0.3, 0.7], falloff: 60 },
    },
    {
      command: 'edit_subdivision_cage',
      params: { id: '$saddle', region: { min: [-200, -100, -50], max: [-100, 100, 50] }, translate: [0, 0, 12] },
    },
    { command: 'edit_subdivision_cage', params: { id: '$saddle', region: { min: [-200, -100, -50], max: [200, 100, -1] }, crease: true } },
  ],
  surface_from_curves_hood: [
    {
      command: 'surface_from_curves',
      params: {
        curves: [xyz(0, 0, 0, 40, 0, 18, 80, 0, 0), xyz(0, 50, 0, 40, 50, 10, 80, 50, 0)],
        thickness: 2,
        cells: [6, 4],
        name: 'hood',
      },
      as: 'hood',
    },
    {
      command: 'edit_subdivision_cage',
      params: { id: '$hood', region: { min: [30, -10, 0], max: [50, 60, 40] }, translate: [0, 0, 4], falloff: 20 },
    },
  ],
  loft_and_variable_sweep: [
    {
      command: 'loft_sections',
      params: {
        sections: [
          { center: [0, 0, 0], radius: 2 },
          { center: [0, 0, 4], section: xy(-1.5, -1.5, 1.5, -1.5, 1.5, 1.5, -1.5, 1.5) },
          { center: [1, 0, 8], radiusX: 2.5, radiusY: 0.8, rotation: [0, 0.25, 0] },
        ],
      },
    },
    {
      command: 'sweep_profile',
      params: {
        path: xyz(6, 0, 0, 16, 0, 0, 16, 0, 10),
        bendRadius: 4,
        stations: [
          { at: 0, radius: 1.2 },
          { at: 0.5, radiusX: 0.8, radiusY: 1.6 },
          { at: 1, radius: 0.6 },
        ],
      },
    },
  ],
  bell_nozzle_and_plumbing: [
    { command: 'draw_spline', params: { points: xy(3, 0, 1.5, 3, 4, 7, 6, 10) }, as: 'wall' },
    { command: 'draw_polyline', params: { points: xy(6, 10, 5.6, 10) }, as: 'lip' },
    { command: 'draw_spline', params: { points: xy(5.6, 10, 3.7, 7, 1.2, 3, 2.6, 0) }, as: 'inner' },
    { command: 'draw_polyline', params: { points: xy(2.6, 0, 3, 0) }, as: 'base' },
    { command: 'revolve_profile', params: { profileIds: ['$wall', '$lip', '$inner', '$base'], segments: 24 }, as: 'bell' },
    {
      command: 'sweep_profile',
      params: { path: xyz(3.5, 0, 1, 8, 0, 1, 8, 0, 9), radius: 0.4, innerRadius: 0.3, bendRadius: 1.5 },
      as: 'feed',
    },
    { command: 'sweep_profile', params: { path: xyz(-3, 0, 2, -6, 2, 4, -5, 4, 8), smooth: true, radius: 0.25 } },
  ],
  transforms_move_rotate_scale_mirror: [
    { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
    { command: 'move_entities', params: { ids: ['$b'], delta: [3, 2, 1] } },
    { command: 'rotate_entity', params: { id: '$b', delta: [0, 0, Math.PI / 4] } },
    { command: 'scale_entity', params: { id: '$b', factor: 2 } },
    { command: 'mirror_entity', params: { id: '$b', axis: 'x' } },
  ],
  transforms_arrays: [
    { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
    { command: 'array_linear', params: { id: '$b', count: 4, offset: [3, 0, 0] } },
    { command: 'add_cylinder', params: { radius: 0.5, height: 2, position: [5, 0, 0] }, as: 'c' },
    { command: 'array_polar', params: { id: '$c', count: 6, center: [0, 0, 0] } },
  ],
  duplicate_group_ungroup: [
    { command: 'add_box', params: { size: [1, 2, 3] }, as: 'b' },
    { command: 'duplicate_entities', params: { ids: ['$b'], offset: [5, 0, 0] }, as: 'dup' },
    { command: 'group_entities', params: { ids: ['$b', '$dup'], name: 'pair' }, as: 'g' },
    { command: 'set_entity_name', params: { id: '$b', name: 'original', tags: ['a', 'b'] } },
  ],
  layers: [
    { command: 'add_layer', params: { name: 'Walls', color: '#ff0000' }, as: 'l1' },
    { command: 'add_layer', params: { name: 'Doors' }, as: 'l2' },
    { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
    { command: 'set_entity_layer', params: { entityId: '$b', layerId: '$l1' } },
    { command: 'update_layer', params: { id: '$l2', name: 'Windows' } },
    { command: 'update_layer', params: { id: '$l2', visible: false } },
    { command: 'update_layer', params: { id: '$l1', locked: true } },
  ],
  materials_assign: [
    { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
    { command: 'create_material', params: { name: 'steel', density: 0.00785, color: '#808080', metalness: 0.9, roughness: 0.3 } },
    { command: 'assign_material', params: { materialName: 'steel', entityIds: ['$b'] } },
  ],
  parameters_expressions: [
    { command: 'set_parameter', params: { name: 'w', expression: '10' } },
    { command: 'set_parameter', params: { name: 'h', expression: 'w / 2' } },
    { command: 'add_box', params: { size: ['=w', '=h', '=w * 2'] } },
    { command: 'add_cylinder', params: { radius: '=h', height: '=w', position: [20, 0, 0] } },
  ],
  loops_repeat_for_each: [
    { command: 'set_parameter', params: { name: 'n', expression: '4' } },
    { repeat: { count: '=n' }, step: { command: 'add_box', params: { size: [1, 1, 1], position: ['=$i * 3', 0, 0] } } },
    { for_each: { values: [1, 2, 3], as: 'r' }, step: { command: 'add_sphere', params: { radius: '=$r', position: ['=$r * 10', 5, 0] } } },
  ],
  loops_polar_pattern: [
    { command: 'set_parameter', params: { name: 'n', expression: '7' } },
    { command: 'set_parameter', params: { name: 'r', expression: '50' } },
    {
      repeat: { count: '=n', as: 'i' },
      actions: [
        {
          command: 'add_cylinder',
          as: 'piston{i}',
          params: { radius: 4, height: 30, position: ['=r*cos(2*pi*i/n)', '=r*sin(2*pi*i/n)', 80] },
        },
      ],
    },
    { command: 'move_entities', params: { ids: ['$piston0'], delta: [0, 0, 5] } },
  ],
  configurations: [
    { command: 'set_parameter', params: { name: 'w', expression: '10' } },
    { command: 'insert_step', params: { name: 'add_box', params: { size: ['=w', '=w', '=w'] } } },
    { command: 'create_configuration', params: { name: 'small', parameterValues: { w: '10' } } },
    { command: 'create_configuration', params: { name: 'large', parameterValues: { w: '40' } } },
    { command: 'activate_configuration', params: { name: 'large' } },
  ],
  recipes: [
    { command: 'add_box', params: { size: [2, 2, 2] } },
    { command: 'save_recipe', params: { name: 'cube', label: 'a cube' } },
    { command: 'instantiate_recipe', params: { name: 'cube' } },
  ],
  constraints_add_solve: [
    { command: 'draw_polyline', params: { points: xy(0, 0, 10, 0) }, as: 'a' },
    { command: 'draw_polyline', params: { points: xy(0, 1, 10, 4) }, as: 'b' },
    { command: 'add_constraint', params: { constraint: { kind: 'parallel', a: { entityId: '$a' }, b: { entityId: '$b' } } } },
    { command: 'add_constraint', params: { constraint: { kind: 'distance', a: { entityId: '$a' }, b: { entityId: '$b' }, value: 4 } } },
    { command: 'solve_constraints', params: {} },
  ],
  constraints_fully_constrained_sketch: [
    { command: 'draw_polyline', params: { points: xy(0, 0, 40, 1) }, as: 'bottom' },
    { command: 'draw_polyline', params: { points: xy(40, 1, 41, 20) }, as: 'right' },
    { command: 'draw_polyline', params: { points: xy(41, 20, 1, 21) }, as: 'top' },
    { command: 'draw_polyline', params: { points: xy(1, 21, 0, 0) }, as: 'left' },
    {
      command: 'add_constraint',
      params: { constraint: { kind: 'coincident', a: { entityId: '$bottom', kind: 'end' }, b: { entityId: '$right', kind: 'start' } } },
    },
    {
      command: 'add_constraint',
      params: { constraint: { kind: 'coincident', a: { entityId: '$right', kind: 'end' }, b: { entityId: '$top', kind: 'start' } } },
    },
    {
      command: 'add_constraint',
      params: { constraint: { kind: 'coincident', a: { entityId: '$top', kind: 'end' }, b: { entityId: '$left', kind: 'start' } } },
    },
    {
      command: 'add_constraint',
      params: { constraint: { kind: 'coincident', a: { entityId: '$left', kind: 'end' }, b: { entityId: '$bottom', kind: 'start' } } },
    },
    { command: 'add_constraint', params: { constraint: { kind: 'horizontal', a: { entityId: '$bottom' } } } },
    { command: 'add_constraint', params: { constraint: { kind: 'horizontal', a: { entityId: '$top' } } } },
    { command: 'add_constraint', params: { constraint: { kind: 'vertical', a: { entityId: '$right' } } } },
    { command: 'add_constraint', params: { constraint: { kind: 'vertical', a: { entityId: '$left' } } } },
    { command: 'add_constraint', params: { constraint: { kind: 'aligned', a: { entityId: '$bottom' }, value: 40 } } },
    { command: 'add_constraint', params: { constraint: { kind: 'aligned', a: { entityId: '$right' }, value: 20 } } },
    { command: 'add_constraint', params: { constraint: { kind: 'fix', a: { entityId: '$bottom', kind: 'start' } } } },
    { command: 'solve_constraints', params: {} },
  ],
  assembly_components_instances: [
    ...CUBE_COMPONENT,
    { command: 'insert_instance', params: { componentId: 'comp-cube', position: [5, 0, 0] } },
    { command: 'insert_instance', params: { componentId: 'comp-cube', position: [10, 0, 0], rotation: [0, 0, 1] } },
  ],
  assembly_mates: [
    ...CUBE_COMPONENT,
    cubeInstance(5, 'ia'),
    cubeInstance(20, 'ib'),
    { command: 'add_constraint', params: { constraint: { kind: 'distance', a: { entityId: '$ia' }, b: { entityId: '$ib' }, value: 5 } } },
  ],
  assembly_joints: [
    ...CUBE_COMPONENT,
    cubeInstance(0, 'ia'),
    cubeInstance(3, 'ib'),
    { command: 'add_joint', params: { kind: 'revolute', a: { instanceId: '$ia' }, b: { instanceId: '$ib' }, axis: 'z' }, as: 'j' },
    { command: 'set_joint_value', params: { id: '$j', value: 0.5 } },
  ],
  mechanism_four_bar_exploded: [
    ...CUBE_COMPONENT,
    cubeInstance(0, 'ground'),
    { command: 'insert_instance', params: { componentId: 'comp-cube', position: [0, 3, 0] }, as: 'crank' },
    { command: 'insert_instance', params: { componentId: 'comp-cube', position: [4, 3, 0] }, as: 'coupler' },
    { command: 'insert_instance', params: { componentId: 'comp-cube', position: [4, 0, 0] }, as: 'rocker' },
    {
      command: 'add_joint',
      params: { kind: 'revolute', a: { instanceId: '$ground' }, b: { instanceId: '$crank' }, axis: 'z', pivot: [0, 0, 0] },
      as: 'drive',
    },
    {
      command: 'add_joint',
      params: { kind: 'revolute', a: { instanceId: '$crank' }, b: { instanceId: '$coupler' }, axis: 'z', pivot: [0, 3, 0], passive: true },
    },
    {
      command: 'add_joint',
      params: { kind: 'revolute', a: { instanceId: '$coupler' }, b: { instanceId: '$rocker' }, axis: 'z', pivot: [4, 3, 0], passive: true },
    },
    {
      command: 'add_joint',
      params: { kind: 'revolute', a: { instanceId: '$ground' }, b: { instanceId: '$rocker' }, axis: 'z', pivot: [4, 0, 0], passive: true },
    },
    { command: 'set_joint_value', params: { id: '$drive', value: 0.5 } },
    { command: 'evaluate_motion', params: { apply: true } },
    { command: 'create_contact_set', params: { name: 'links', pairs: [['$crank', '$rocker']] } },
    {
      command: 'create_exploded_view',
      params: { name: 'service', auto: { axis: 'z', spacing: 10, order: ['$ground', '$crank', '$coupler', '$rocker'] } },
      as: 'view',
    },
    { command: 'set_active_exploded_view', params: { id: '$view', step: 2 } },
  ],
  gears_spur_and_belt: [
    { command: 'add_spur_gear', params: { module: 2, teeth: 20, faceWidth: 5 } },
    { command: 'add_spur_gear', params: { module: 2, teeth: 30, faceWidth: 5, position: [50, 0, 0], name: 'big' } },
    {
      command: 'draw_belt_around',
      params: {
        pulleys: [
          { center: [0, 20], radius: 5 },
          { center: [20, 20], radius: 5 },
        ],
      },
    },
  ],
  distribute_align_stack: [
    { command: 'add_box', params: { size: [1, 1, 1], position: [0, 0, 0] }, as: 'a' },
    { command: 'add_box', params: { size: [1, 1, 1], position: [7, 2, 0] }, as: 'b' },
    { command: 'add_box', params: { size: [1, 1, 1], position: [20, 4, 0] }, as: 'c' },
    { command: 'distribute', params: { targetIds: ['$a', '$b', '$c'], axis: 'x' } },
    { command: 'align', params: { targetIds: ['$b', '$c'], edge: 'min-y', referenceId: '$a' } },
    { command: 'stack_on', params: { movingId: '$c', baseId: '$a' } },
  ],
  document_settings_camera: [
    { command: 'set_units', params: { units: 'mm', displayPrecision: 2 } },
    { command: 'add_box', params: { size: [10, 10, 10] }, as: 'b' },
    { command: 'set_camera', params: { azimuth: 0.5, polar: 1, distance: 30 } },
    { command: 'animate', params: { targetId: '$b', mode: 'spin', speed: 1 } },
  ],
  building_shell_from_primitives: [
    { command: 'add_layer', params: { name: 'Walls' }, as: 'lw' },
    { command: 'add_box', params: { size: [10, 0.3, 3], position: [0, 0, 1.5] }, as: 'w1' },
    { command: 'add_box', params: { size: [10, 0.3, 3], position: [0, 8, 1.5] }, as: 'w2' },
    { command: 'add_box', params: { size: [0.3, 8, 3], position: [-5, 4, 1.5] }, as: 'w3' },
    { command: 'add_box', params: { size: [0.3, 8, 3], position: [5, 4, 1.5] }, as: 'w4' },
    { command: 'add_box', params: { size: [10.3, 8.3, 0.2], position: [0, 4, 3.1] } },
    { command: 'group_entities', params: { ids: ['$w1', '$w2', '$w3', '$w4'], name: 'walls' } },
    { command: 'set_entity_layer', params: { entityId: '$w1', layerId: '$lw' } },
  ],
  building_house_template: [{ command: 'add_building_template', params: { template: 'house' } }],
  civil_site_terrain_road_drainage: [
    { command: 'set_units', params: { units: 'm' } },
    {
      command: 'import_survey_points',
      params: {
        name: 'Topo',
        points: [0, 20, 40, 60].flatMap((x) => [0, 20, 40, 60].map((y) => ({ x, y, z: 100 + x * 0.05 + y * 0.02 }))),
      },
    },
    { command: 'create_surface', params: { contourInterval: 1, majorEvery: 2 } },
    { command: 'add_platform', params: { surfaceId: 'surface-1', boundary: xy(20, 20, 35, 20, 35, 35, 20, 35), elevation: 102 } },
    { command: 'balance_platform', params: { platformId: 'platform-1' } },
    { command: 'add_alignment', params: { points: xy(5, 5, 50, 5, 50, 55), radii: [15], surfaceId: 'surface-1' } },
    {
      command: 'set_alignment_profile',
      params: {
        alignmentId: 'alignment-1',
        pvis: [
          { station: 0, elevation: 100.5 },
          { station: 45, elevation: 102.5, curveLength: 20 },
          { station: 88, elevation: 103 },
        ],
      },
    },
    { command: 'set_road_section', params: { alignmentId: 'alignment-1' } },
    { command: 'add_manhole', params: { location: [10, 50], invertElevation: 99.5, surfaceId: 'surface-1' } },
    { command: 'add_manhole', params: { location: [40, 50], invertElevation: 99.2, surfaceId: 'surface-1' } },
    { command: 'add_drainage_pipe', params: { fromId: 'manhole-1', toId: 'manhole-2' } },
    { command: 'size_drainage_pipes', params: {} },
  ],
  building_walls_openings_slab: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_grid_system', params: { xSpacings: [5000, 5000], ySpacings: [4000] } },
    { command: 'draw_walls', params: { points: xy(0, 0, 10000, 0) } },
    { command: 'draw_walls', params: { points: xy(10000, 0, 10000, 8000) } },
    { command: 'draw_walls', params: { points: xy(10000, 8000, 0, 8000) } },
    { command: 'draw_walls', params: { points: xy(0, 8000, 0, 0) } },
    { command: 'add_door', params: { wallId: 'wall-1', offset: 1500 } },
    { command: 'add_window', params: { wallId: 'wall-2', offset: 3000 } },
    { command: 'add_slab', params: { wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'] } },
    { command: 'add_column', params: { location: [5000, 4000] } },
    { command: 'add_beam', params: { start: [0, 4000], end: [10000, 4000] } },
    { command: 'add_level', params: { name: 'First' } },
    { command: 'update_wall', params: { wallId: 'wall-1', height: 2800 } },
  ],
  building_mixed_model_edited: [
    { command: 'add_level', params: { name: 'Ground', height: 4000 } },
    { command: 'draw_walls', params: { points: xy(0, 0, 6000, 0, 6000, 5000, 0, 5000), closed: true, thickness: 200 } },
    { command: 'add_door', params: { wallId: 'wall-1', offset: 1500 } },
    { command: 'add_window', params: { wallId: 'wall-2', offset: 2500 } },
    { command: 'add_curved_wall', params: { start: [7000, 0], through: [8000, 1000], end: [9000, 0], thickness: 200 } },
    { command: 'add_slab', params: { wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'] } },
    { command: 'add_slab_opening', params: { slabId: 'slab-1', boundary: xy(1000, 1000, 2000, 1000, 2000, 2000, 1000, 2000) } },
    { command: 'add_column', params: { location: [3000, 2500] } },
    { command: 'add_beam', params: { start: [0, 2500], end: [6000, 2500] } },
    { command: 'add_stair', params: { start: [4000, 500], angle: 0 } },
    { command: 'add_room', params: { name: 'Hall', wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'] } },
    { command: 'update_wall', params: { wallId: 'wall-3', thickness: 250 } },
    { command: 'update_opening', params: { openingId: 'door-1', width: 1000 } },
    { command: 'move_building_element', params: { elementIds: ['column-1'], delta: [200, 0] } },
    { command: 'update_level', params: { levelId: 'level-1', height: 4200 } },
    { command: 'delete_building_element', params: { elementIds: ['room-1'] } },
  ],
  industrial_hall_piping_equipment: [
    {
      command: 'add_portal_frame_building',
      params: {
        span: 12000,
        length: 12000,
        baySpacing: 6000,
        eaveHeight: 6000,
        purlinSpacing: 3000,
        railSpacing: 3000,
        cladding: false,
        floorSlab: false,
        footings: false,
        basePlates: false,
      },
    },
    { command: 'add_equipment', params: { name: 'Pump', mark: 'P-1', location: [3000, 3000], size: [1500, 800, 900] } },
    { command: 'add_pipe_run', params: { points: xyz(1000, 3000, 1500, 9000, 3000, 1500), dn: 100, line: 'L-1', from: 'P-1' } },
    { command: 'add_pipe_support', params: { pipeId: 'pipe-1', spacing: 4000 } },
    { command: 'add_cable_tray', params: { points: xyz(1000, 5000, 3000, 9000, 5000, 3000) } },
    { command: 'update_equipment', params: { elementId: 'equipment-1', location: [3500, 3000] } },
  ],
  industrial_portal_frame: [
    { command: 'add_portal_frame_building', params: { span: 18000, length: 30000, baySpacing: 6000, eaveHeight: 6000, roofPitch: 6 } },
  ],
  industrial_portal_crane: [
    {
      command: 'add_portal_frame_building',
      params: {
        span: 18000,
        length: 30000,
        baySpacing: 6000,
        eaveHeight: 6000,
        roofPitch: 6,
        footings: false,
        cladding: false,
        floorSlab: false,
        crane: { capacity: 16, railHeight: 4500 },
      },
    },
  ],
  drawing_sheet_part: [
    { command: 'add_box', params: { size: [100, 60, 40] } },
    { command: 'create_sheet', params: { name: 'Part', paper: 'A3', title: 'Block', partNumber: 'P-1', date: '2026-01-01' }, as: 'sheet' },
    { command: 'create_drawing_view', params: { sheetId: '$sheet', direction: 'front' }, as: 'front' },
    { command: 'create_drawing_view', params: { sheetId: '$sheet', direction: 'top' } },
    { command: 'add_section_view', params: { sheetId: '$sheet', direction: 'right', offset: 0, parentViewId: '$front' } },
    { command: 'add_detail_view', params: { sheetId: '$sheet', parentViewId: '$front', center: [50, 20], radius: 10 } },
  ],
  prototype_review: [
    { command: 'add_box', params: { size: [20, 20, 20] }, as: 'base' },
    { command: 'add_cylinder', params: { radius: 5, height: 30 }, as: 'pin' },
    { command: 'set_part_grounded', params: { ids: ['$base'], grounded: true } },
    { command: 'allow_interference', params: { a: '$pin', b: '$base', kind: 'press_fit', reason: 'pin pressed into the frame boss' } },
  ],
  // 02 SRF: NURBS curves, edits and analysis
  surface_nurbs_curves: [
    { command: 'create_nurbs_curve', params: { degree: 3, poles: xyz(0, 0, 0, 1, 2, 0, 3, 2, 1, 4, 0, 1, 6, -1, 2) }, as: 'c' },
    { command: 'edit_nurbs', params: { id: '$c', operation: 'insert_knot', u: 0.25, times: 2 } },
    {
      command: 'interpolate_curve',
      params: { points: xyz(0, 0, 0, 1, 1, 0, 2, 0.5, 1, 3, -1, 0, 4, 0, 2), parameterization: 'centripetal' },
    },
    { command: 'create_conic', params: { start: [5, 0, 0], apex: [5, 5, 0], end: [0, 5, 0], rho: 0.41421356237309515 }, as: 'arc' },
    { command: 'analyze_curve_curvature', params: { id: '$arc', samples: 5 } },
    { command: 'inspect_nurbs', params: { id: '$c' } },
  ],
  // 02 SRF M4-M5: surface sheets - interpolate a grid, loft, fill, trim and analyse
  surface_sheets: [
    {
      command: 'surface_from_points',
      params: {
        grid: [xyz(0, 0, 0, 2, 0, 0.5, 4, 0, 0), xyz(0, 2, 0.3, 2, 2, 1, 4, 2, 0.3), xyz(0, 4, 0, 2, 4, 0.5, 4, 4, 0)],
        degreeU: 2,
        degreeV: 2,
      },
      as: 'patch',
    },
    { command: 'analyze_surface_curvature', params: { id: '$patch', grid: [3, 3] } },
    { command: 'trim_surface', params: { id: '$patch', u: [0.2, 0.8], v: [0, 0.5] } },
    { command: 'inspect_nurbs', params: { id: '$patch' } },
    { command: 'interpolate_curve', params: { points: xyz(0, 0, 0, 1, 1, 0, 2, 0, 0), degree: 2 }, as: 'bottom' },
    { command: 'interpolate_curve', params: { points: xyz(0, 0, 3, 1, 1, 3, 2, 0, 3), degree: 2 }, as: 'top' },
    { command: 'loft_surface', params: { sectionIds: ['$bottom', '$top'], degreeV: 1 }, as: 'skin' },
    { command: 'measure_deviation', params: { id: '$skin', points: [[1, 0.5, 1.5]] } },
  ],
  // 02 SRF M5 / M7 (SRF-3): trim by a circle (VC-SRF-23), approximate a point cloud, blend two strips G2, sew a box shell, report quality
  surface_trim_blend_sew: [
    {
      command: 'create_nurbs_surface',
      params: {
        degreeU: 1,
        degreeV: 1,
        poles: [
          [xyz(0, 0, 0)[0], xyz(0, 10, 0)[0]],
          [xyz(10, 0, 0)[0], xyz(10, 10, 0)[0]],
        ],
        knotsU: [0, 1],
        multiplicitiesU: [2, 2],
        knotsV: [0, 1],
        multiplicitiesV: [2, 2],
      },
      as: 'plate',
    },
    {
      command: 'create_nurbs_curve',
      params: {
        degree: 2,
        poles: [
          [8, 5, 0],
          [8, 8, 0],
          [5, 8, 0],
          [2, 8, 0],
          [2, 5, 0],
          [2, 2, 0],
          [5, 2, 0],
          [8, 2, 0],
          [8, 5, 0],
        ],
        weights: [1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1, Math.SQRT1_2, 1],
        knots: [0, 0.25, 0.5, 0.75, 1],
        multiplicities: [3, 2, 2, 2, 3],
      },
      as: 'circle',
    },
    { command: 'trim_surface', params: { id: '$plate', curveIds: ['$circle'], keep: 'inside' } },
    { command: 'measure_area', params: { entityId: '$plate' } },
    {
      command: 'approximate_curve',
      params: { points: xyz(0, 0, 0, 1, 0.8, 0, 2, 1.1, 0, 3, 0.9, 0, 4, 0.2, 0, 5, -0.6, 0, 6, -1, 0), tolerance: 0.05 },
      as: 'fit',
    },
    {
      command: 'check_surface_quality',
      params: { ids: ['$plate'], require: 'G0', g0: 1e-6, g1AngleRad: 0.01, g2Rel: 0.1, g3Rel: 0.1, sewing: 1e-6 },
    },
  ],
  // 02 SRF VC-SRF-11: NACA 0012 trapezoid wing, 2 m -> 1 m chord, 5 m semi-span, volume 0.959117 m3 per half
  aero_naca_trap_wing: [
    { command: 'set_units', params: { units: 'm' } },
    { command: 'airfoil_from_naca', params: { designation: '0012', points: 41, trailingEdge: 'open' }, as: 'af' },
    {
      command: 'create_wing',
      params: {
        sections: [
          { airfoilId: '$af', span: 0, chord: 2 },
          { airfoilId: '$af', span: 5, chord: 1 },
        ],
        loft: 'linear',
      },
      as: 'wing',
    },
    { command: 'wing_properties', params: { id: '$wing' } },
    { command: 'airfoil_properties', params: { airfoilId: '$af' } },
  ],
  // 02 SRF VC-SRF-10: NACA TR-1208 45 degree swept wing from a planform (2024.35 in2, MAC 16.67 in, AR 8.0)
  aero_tr1208: [
    { command: 'set_units', params: { units: 'in' } },
    { command: 'airfoil_from_naca', params: { designation: '0012', points: 41 }, as: 'af' },
    {
      command: 'create_wing',
      params: {
        planform: { semiSpan: 63.63, rootChord: 21.941, taper: 0.45, sweepDeg: 45, sweepLocation: 0.25, dihedralDeg: 0 },
        sections: [
          { airfoilId: '$af', span: 0 },
          { airfoilId: '$af', span: 63.63 },
        ],
        mirror: true,
      },
      as: 'wing',
    },
    { command: 'wing_properties', params: { id: '$wing' } },
  ],
  fea_modal_cantilever: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [200, 10, 10], position: [0, 0, 0], anchor: 'min' }, as: 'bar' },
    { command: 'create_material', params: { name: 'steel', density: 0.0078 } },
    {
      command: 'add_material_model',
      params: {
        material: 'steel',
        id: 'elastic',
        model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
        basis: 'company',
        source: { citation: 'golden test input' },
      },
    },
    { command: 'define_constitutive_set', params: { material: 'steel', set: { id: 'set', elastic: 'elastic' }, makeDefault: true } },
    { command: 'assign_material', params: { materialName: 'steel', entityIds: ['$bar'] } },
    {
      command: 'create_analysis',
      params: { name: 'modes', analysisType: 'modal', modes: 4, frequencyRangeHz: { min: 50, max: 5000 } },
      as: 'an',
    },
    { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$bar' } },
    {
      command: 'add_fea_constraint',
      params: { analysisId: '$an', name: 'root', kind: 'fixed', target: { entityId: '$bar', facesNear: [[0, 5, 5]] } },
    },
    { command: 'set_mesh_controls', params: { analysisId: '$an', elementFamily: 'tet', order: 2, globalSize: 4 } },
  ],
  fea_buckling_column_moment: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [300, 10, 10], position: [0, 0, 0], anchor: 'min' }, as: 'bar' },
    { command: 'create_material', params: { name: 'steel', density: 0.0078 } },
    {
      command: 'add_material_model',
      params: {
        material: 'steel',
        id: 'elastic',
        model: { kind: 'elastic_isotropic', E: { value: 210, unit: 'GPa' }, nu: { value: 0.3, unit: '1' } },
        basis: 'company',
        source: { citation: 'golden test input' },
      },
    },
    { command: 'define_constitutive_set', params: { material: 'steel', set: { id: 'set', elastic: 'elastic' }, makeDefault: true } },
    { command: 'assign_material', params: { materialName: 'steel', entityIds: ['$bar'] } },
    { command: 'create_analysis', params: { name: 'column', analysisType: 'buckling', modes: 2 }, as: 'an' },
    { command: 'set_part_idealization', params: { analysisId: '$an', entityId: '$bar' } },
    {
      command: 'add_fea_constraint',
      params: { analysisId: '$an', name: 'root', kind: 'fixed', target: { entityId: '$bar', facesNear: [[0, 5, 5]] } },
    },
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$an',
        name: 'axial',
        kind: 'force',
        vector: [-1000, 0, 0],
        target: { entityId: '$bar', facesNear: [[300, 5, 5]] },
      },
    },
    {
      command: 'add_fea_load',
      params: {
        analysisId: '$an',
        name: 'tip torque',
        kind: 'moment',
        loadCase: 'LC2',
        vector: [0, 0, 500],
        target: { entityId: '$bar', facesNear: [[300, 5, 5]] },
      },
    },
    { command: 'set_mesh_controls', params: { analysisId: '$an', elementFamily: 'tet', order: 2, globalSize: 4 } },
  ],
  composites_flat_panel: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_box', params: { size: [600, 400, 10], anchor: 'min', position: [0, 0, -10] }, as: 'tool' },
    {
      command: 'create_lamina_material',
      params: {
        name: 'T300_5208',
        form: 'ud_tape',
        E1: 181000,
        E2: 10300,
        G12: 7170,
        nu12: 0.28,
        Xt: 1500,
        Xc: 1500,
        Yt: 40,
        Yc: 246,
        S: 68,
        plyThickness: 0.125,
        density: 0.0016,
        basis: 'b_basis',
        source: 'Tsai & Hahn 1980 via Kaw Table 2.1 (density illustrative)',
      },
    },
    { command: 'define_rosette', params: { name: 'R0', origin: [0, 0, 0], axis0: [1, 0, 0], normal: [0, 0, 1], method: 'translational' } },
    {
      command: 'create_composite_part',
      params: { name: 'Skin panel', toolSurface: { entityId: '$tool', faceNear: [300, 200, 0] }, rosette: 'R0' },
      as: 'part',
    },
    {
      command: 'define_zone',
      params: {
        part: '$part',
        name: 'Z-base',
        boundary: [
          [0, 0],
          [600, 0],
          [600, 400],
          [0, 400],
        ],
        laminate: '[45/-45/0/90]s',
        priority: 0,
      },
    },
    {
      command: 'define_zone',
      params: {
        part: '$part',
        name: 'Z-pad',
        boundary: [
          [200, 100],
          [400, 100],
          [400, 300],
          [200, 300],
        ],
        laminate: '[45/-45/0/90/0/-45/45/0]s',
        priority: 1,
      },
    },
    {
      command: 'define_zone',
      params: {
        part: '$part',
        name: 'Z-hole',
        boundary: [
          [260, 160],
          [340, 160],
          [340, 240],
          [260, 240],
        ],
        laminate: '[45/-45/0/90/0/-45/45/0/45/-45/0/90]s',
        priority: 2,
      },
    },
    {
      command: 'set_ply_drop_rules',
      params: { part: '$part', rampRatio: 20, minStagger: 3, staggerUnit: 'dropped_thickness', dropOrder: 'inner_first', coverPlies: 2 },
    },
    { command: 'generate_plies_from_zones', params: { part: '$part', material: 'T300_5208', sequencePrefix: 'S' } },
    { command: 'core_sample', params: { part: '$part', point: [300, 200, 0] } },
    { command: 'check_laminate_rules', params: { part: '$part' } },
    {
      command: 'analyze_laminate',
      params: { part: '$part', point: [50, 50, 0], loads: { Nx: 1 }, criteria: ['max_stress', 'tsai_hill', 'tsai_wu'] },
    },
    { command: 'check_layup', params: { part: '$part', purpose: 'design' } },
    { command: 'export_ply_flat_patterns_dxf', params: { part: '$part', labels: ['name', 'orientation', 'sequence'] } },
  ],
  composites_cone_flat_pattern: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_cone', params: { radius: 100, height: 100, position: [0, 0, 0] }, as: 'tool' },
    {
      command: 'create_lamina_material',
      params: {
        name: 'AS4_3501_6',
        form: 'ud_tape',
        E1: 126000,
        E2: 11000,
        G12: 6600,
        nu12: 0.28,
        Xt: 1950,
        Xc: 1480,
        Yt: 48,
        Yc: 200,
        S: 79,
        plyThickness: 0.125,
        density: 0.0016,
        basis: 'mean',
        source: 'Soden, Hinton & Kaddour 1998 (WWFE lamina data)',
      },
    },
    {
      command: 'define_rosette',
      params: { name: 'Rax', origin: [0, 0, 0], axis0: [0, 0, 1], normal: [1, 0, 0], method: 'cylindrical', axis: [0, 0, 1] },
    },
    {
      command: 'create_composite_part',
      params: { name: 'Cone skin', toolSurface: { entityId: '$tool', faceNear: [50, 0, 50] }, rosette: 'Rax' },
      as: 'part',
    },
    {
      command: 'add_ply',
      params: {
        part: '$part',
        name: 'C1',
        material: 'AS4_3501_6',
        orientation: 0,
        sequence: 'S1',
        boundary: { kind: 'whole_face' },
        drape: { method: 'developable' },
      },
      as: 'c1',
    },
    { command: 'laminate_mass', params: { part: '$part' } },
    { command: 'export_ply_flat_patterns_dxf', params: { part: '$part', plies: ['$c1'] } },
  ],
  // SWG M1/M3 target plans of the validation pack (docs/design/02-sweep-loft-guides/validation/plans)
  swg_twist_scale_orientation: swgPlan('target_twist_scale_orientation'),
  swg_helix_spring_thread: swgPlan('target_helix_spring_thread'),
};

/** Plans needing the Manifold geometry kernel (booleans). */
export const kernelPlans: Record<string, GoldenAction[]> = {
  // 07 FTR: a countersunk through hole, a counterbored hole, a blind drilled hole and a rounded pocket on one plate (feature recipe nodes)
  kernel_machined_plate_features: [
    { command: 'add_box', params: { size: [60, 40, 10], position: [0, 0, 0], anchor: 'min' }, as: 'plate' },
    {
      command: 'add_hole',
      params: {
        target: '$plate',
        face: { near: [30, 20, 10] },
        points: [[8, 8]],
        pointsFrame: 'world_xy',
        hole: { kind: 'countersink', diameter: 4.8, cskDiameter: 9, cskAngle: 100, thread: { designation: 'M5x0.8-6H' } },
        extent: { kind: 'through_all' },
      },
      as: 'csk',
    },
    {
      command: 'add_hole',
      params: {
        target: '$csk',
        face: { near: [30, 20, 10] },
        points: [[8, 32]],
        pointsFrame: 'world_xy',
        hole: { kind: 'simple', diameter: 6 },
        extent: { kind: 'blind', depth: 6, drillPointAngle: 118 },
      },
      as: 'blind',
    },
    {
      command: 'add_pocket',
      params: {
        target: '$blind',
        face: { near: [30, 20, 10] },
        outline: { kind: 'rectangle', center: [38, 20], size: [24, 16] },
        depth: 4,
        cornerRadius: 3,
        floorFillet: 0,
      },
      as: 'part',
    },
    { command: 'set_thread', params: { id: '$part', featureIndex: 1, thread: { designation: 'M6x1-6H' } } },
  ],
  kernel_sweep_welded_to_revolution: [
    { command: 'revolve_profile', params: { profile: xy(0, 0, 3, 0, 3, 4, 0, 4), segments: 24 }, as: 'drum' },
    { command: 'sweep_profile', params: { path: xyz(2, 0, 2, 7, 0, 2, 7, 0, 8), radius: 0.5, bendRadius: 2 }, as: 'pipe' },
    { command: 'boolean', params: { op: 'union', a: '$drum', b: '$pipe' } },
  ],
  // PHY-21: slider-crank with a spherical wrist (loop closure), gas pressure and solver settings; ids are step-scoped (cyl-<step>.<k>)
  dynamics_slider_crank_engine: [
    { command: 'add_cylinder', params: { radius: 80, height: 20, axis: [0, 0, 1], position: [0, 0, 0] }, as: 'crankSolid' },
    { command: 'add_box', params: { size: [130, 10, 10], position: [48.4, 0, 0] }, as: 'rodSolid' },
    { command: 'add_box', params: { size: [30, 30, 30], position: [145.5, 0, 0] }, as: 'pistonSolid' },
    { command: 'add_rigid_body', params: { entityIds: ['$crankSolid'], massKg: 4, id: 'crank' } },
    { command: 'add_rigid_body', params: { entityIds: ['$rodSolid'], massKg: 0.4, id: 'rod' } },
    { command: 'add_rigid_body', params: { entityIds: ['$pistonSolid'], massKg: 0.4, id: 'piston' } },
    { command: 'add_body_joint', params: { id: 'crank_j', kind: 'revolute', child: 'crank', anchor: [0, 0, 0], axis: [0, 0, 1] } },
    {
      command: 'add_body_joint',
      params: { id: 'rod_j', kind: 'revolute', child: 'rod', parent: 'crank', anchor: [30.5, 0, 0], axis: [0, 0, 1] },
    },
    { command: 'add_body_joint', params: { id: 'wrist_j', kind: 'spherical', child: 'piston', parent: 'rod', anchor: [160.5, 0, 0] } },
    { command: 'add_body_joint', params: { id: 'slide_j', kind: 'prismatic', child: 'piston', anchor: [160.5, 0, 0], axis: [1, 0, 0] } },
    { command: 'set_dynamics_solver', params: { loopTimeConstantSteps: 2, loopImpedance: 0.9999 } },
    {
      command: 'add_cylinder_pressure',
      params: {
        piston: 'slide_j',
        crank: 'crank_j',
        boreMm: 84,
        compressionRatio: 10.8,
        model: {
          kind: 'wiebe',
          startDeg: -15,
          durationDeg: 50,
          a: 5,
          m: 2,
          compressionIndex: 1.32,
          expansionIndex: 1.28,
          intakePressurePa: 95000,
          heat: { kind: 'target_imep_Pa', value: 1000000 },
        },
      },
    },
  ],
  // PHY-21 M3b realism: sourced materials, friction, brake-calibrated single-zone cylinder, 21/51 reduction with efficiency, propeller table, reference set
  dynamics_engine_realism: [
    { command: 'add_cylinder', params: { radius: 80, height: 20, axis: [0, 0, 1], position: [0, 0, 0] }, as: 'crankSolid' },
    { command: 'add_box', params: { size: [130, 10, 10], position: [48.4, 0, 0] }, as: 'rodSolid' },
    { command: 'add_box', params: { size: [30, 30, 30], position: [145.5, 0, 0] }, as: 'pistonSolid' },
    { command: 'add_cylinder', params: { radius: 100, height: 10, axis: [0, 0, 1], position: [0, 300, 0] }, as: 'propSolid' },
    { command: 'assign_material', params: { materialName: 'steel_4340', entityIds: ['$crankSolid', '$rodSolid'] } },
    { command: 'assign_material', params: { materialName: 'al_4032', entityIds: ['$pistonSolid'] } },
    { command: 'add_rigid_body', params: { entityIds: ['$crankSolid'], id: 'crank' } },
    { command: 'add_rigid_body', params: { entityIds: ['$rodSolid'], id: 'rod' } },
    { command: 'add_rigid_body', params: { entityIds: ['$pistonSolid'], id: 'piston' } },
    { command: 'add_rigid_body', params: { entityIds: ['$propSolid'], massKg: 0.5, id: 'prop' } },
    { command: 'add_body_joint', params: { id: 'crank_j', kind: 'revolute', child: 'crank', anchor: [0, 0, 0], axis: [0, 0, 1] } },
    {
      command: 'add_body_joint',
      params: { id: 'rod_j', kind: 'revolute', child: 'rod', parent: 'crank', anchor: [30.5, 0, 0], axis: [0, 0, 1] },
    },
    { command: 'add_body_joint', params: { id: 'wrist_j', kind: 'spherical', child: 'piston', parent: 'rod', anchor: [160.5, 0, 0] } },
    { command: 'add_body_joint', params: { id: 'slide_j', kind: 'prismatic', child: 'piston', anchor: [160.5, 0, 0], axis: [1, 0, 0] } },
    { command: 'add_body_joint', params: { id: 'prop_j', kind: 'revolute', child: 'prop', anchor: [0, 300, 0], axis: [0, 0, 1] } },
    { command: 'add_gear_coupling', params: { id: 'reduction', driver: 'crank_j', driven: 'prop_j', teeth: [21, 51], efficiency: 0.99 } },
    {
      command: 'set_engine_losses',
      params: {
        crank: 'crank_j',
        model: {
          kind: 'chen_flynn',
          aPa: 40000,
          bRatio: 0.005,
          cPaPerRpm: 5,
          dPaPerRpm2: 0.0000015,
          source: 'test input (not measured data)',
        },
      },
    },
    {
      command: 'add_cylinder_pressure',
      params: {
        piston: 'slide_j',
        crank: 'crank_j',
        boreMm: 84,
        compressionRatio: 10.8,
        model: {
          kind: 'single_zone',
          burn: { ca50Deg: 9, durationDeg: 50, a: 5, m: 2 },
          intakePressurePa: 95000,
          intakeTempK: 330,
          heat: { kind: 'calibrate_brake', brake: [{ rpm: 5800, brakeTorqueNm: 121.012637765 }], cylinderCount: 4 },
          source: 'test input',
        },
      },
    },
    {
      command: 'add_propeller',
      params: {
        joint: 'prop_j',
        diameter: 1.75,
        thrustCoefficient: 0.1,
        powerCoefficient: 0.05,
        airspeedMps: 20,
        inertiaKgM2: 0.25,
        table: {
          points: [
            [0, 0.1, 0.05],
            [0.4, 0.08, 0.055],
            [0.8, 0.02, 0.04],
          ],
          source: 'synthetic test table',
          grade: 'C',
        },
      },
    },
    { command: 'add_reference_data', params: { preset: 'rotax_912uls_full_throttle' } },
  ],
  // PHY-21 reference single-cylinder engine (VC-FPR-24; validation/README §4)
  dynamics_reference_engine: referenceEnginePlan,
  kernel_boolean_union: [
    { command: 'add_box', params: { size: [2, 2, 2] }, as: 'a' },
    { command: 'add_box', params: { size: [2, 2, 2], position: [1, 1, 1] }, as: 'b' },
    { command: 'boolean', params: { op: 'union', a: '$a', b: '$b' } },
  ],
  kernel_boolean_subtract: [
    { command: 'add_box', params: { size: [4, 4, 4] }, as: 'a' },
    { command: 'add_cylinder', params: { radius: 1, height: 6 }, as: 'b' },
    { command: 'boolean', params: { op: 'subtract', a: '$a', b: '$b' } },
  ],
};
