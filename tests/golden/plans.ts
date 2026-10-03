/**
 * Golden replay corpus — representative `build_project` plans.
 * Plans reference earlier results via `as` aliases, never literal ids.
 */

export interface GoldenAction {
  command?: string;
  params?: Record<string, unknown>;
  as?: string;
  repeat?: { count: number | string; as?: string };
  for_each?: { values: unknown[] | string; as: string };
  step?: { command: string; params?: Record<string, unknown> };
}

export const plans: Record<string, GoldenAction[]> = {
  '2d_lines_polylines': [
    { command: 'draw_line', params: { start: [0, 0], end: [10, 5] } },
    {
      command: 'draw_polyline',
      params: {
        points: [
          [0, 0],
          [4, 0],
          [4, 3],
        ],
        closed: false,
      },
    },
    {
      command: 'draw_polyline',
      params: {
        points: [
          [0, 0],
          [5, 0],
          [5, 5],
          [0, 5],
        ],
        closed: true,
      },
    },
    { command: 'draw_point', params: { position: [1, 1, 0] } },
  ],
  '2d_arcs_circles': [
    {
      command: 'draw_arc',
      params: { center: [0, 0], radius: 5, startAngle: 0, endAngle: Math.PI },
    },
    { command: 'draw_circle', params: { center: [3, 3], radius: 2 } },
    { command: 'draw_circle', params: { center: [-3, 3], radius: 1.5, color: '#ff0000' } },
  ],
  '2d_rectangles': [
    { command: 'draw_rectangle', params: { width: 10, height: 4 } },
    { command: 'draw_rectangle', params: { width: 2, height: 2, position: [5, 5, 0] } },
  ],
  '2d_spline_ellipse': [
    {
      command: 'draw_spline',
      params: {
        points: [
          [0, 0],
          [2, 3],
          [5, 1],
          [8, 4],
        ],
      },
    },
    {
      command: 'draw_spline',
      params: {
        points: [
          [0, 0],
          [3, 0],
          [3, 3],
          [0, 3],
        ],
        closed: true,
      },
    },
    { command: 'draw_ellipse', params: { center: [0, 0], radiusX: 6, radiusY: 3 } },
  ],
  '2d_text_dimensions': [
    { command: 'draw_point', params: { position: [0, 0, 0] }, as: 'p1' },
    { command: 'draw_point', params: { position: [10, 0, 0] }, as: 'p2' },
    { command: 'add_text', params: { content: 'Hello', position: [0, 5, 0], height: 2 } },
    {
      command: 'add_dimension',
      params: { dimensionKind: 'linear', entityIds: ['$p1', '$p2'], offset: 3 },
    },
    {
      command: 'add_dimension',
      params: { dimensionKind: 'aligned', entityIds: ['$p1', '$p2'] },
    },
  ],
  modify2d_offset_trim_extend: [
    { command: 'draw_line', params: { start: [0, 0], end: [10, 0] }, as: 'a' },
    { command: 'draw_line', params: { start: [5, -5], end: [5, 5] }, as: 'b' },
    { command: 'draw_line', params: { start: [0, 3], end: [3, 3] }, as: 'c' },
    { command: 'draw_line', params: { start: [8, -4], end: [8, 8] }, as: 'd' },
    { command: 'trim', params: { id: '$a', boundaryId: '$b' } },
    { command: 'extend', params: { id: '$c', boundaryId: '$d' } },
    {
      command: 'draw_polyline',
      params: {
        points: [
          [0, 10],
          [5, 10],
          [5, 15],
        ],
      },
      as: 'pl',
    },
    { command: 'offset_2d', params: { id: '$pl', distance: 1 } },
  ],
  modify2d_fillet_chamfer_explode: [
    {
      command: 'draw_polyline',
      params: {
        points: [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
      },
      as: 'f',
    },
    { command: 'fillet_2d', params: { id: '$f', radius: 2, vertexIndex: 1 } },
    {
      command: 'draw_polyline',
      params: {
        points: [
          [20, 0],
          [30, 0],
          [30, 10],
        ],
      },
      as: 'c',
    },
    { command: 'chamfer_2d', params: { id: '$c', distance: 2, vertexIndex: 1 } },
    {
      command: 'draw_polyline',
      params: {
        points: [
          [0, 20],
          [5, 20],
          [5, 25],
          [0, 25],
        ],
        closed: true,
      },
      as: 'e',
    },
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
    {
      command: 'add_pyramid',
      params: { baseWidth: 3, baseDepth: 3, height: 4, position: [8, 8, 0] },
    },
  ],
  extrude_sketch_and_profile: [
    { command: 'draw_rectangle', params: { width: 4, height: 2 }, as: 'r' },
    { command: 'extrude_sketch', params: { id: '$r', depth: 3 } },
    {
      command: 'extrude_profile',
      params: {
        profile: [
          [0, 0],
          [4, 0],
          [2, 3],
        ],
        depth: 2,
        position: [10, 0, 0],
      },
    },
  ],
  revolve_profile: [
    {
      command: 'revolve_profile',
      params: {
        profile: [
          [1, 0],
          [2, 0],
          [2, 1],
          [1, 1],
        ],
        axis: 'z',
        angle: Math.PI * 2,
        segments: 8,
      },
    },
    {
      command: 'revolve_profile',
      params: {
        profile: [
          [1, 0],
          [3, 0],
          [3, 2],
        ],
        axis: 'y',
        angle: Math.PI,
        segments: 6,
        position: [10, 0, 0],
      },
    },
  ],
  transforms_move_rotate_scale_mirror: [
    { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
    { command: 'move_entity', params: { id: '$b', delta: [3, 2, 1] } },
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
    { command: 'duplicate_entity', params: { id: '$b', offset: [5, 0, 0] }, as: 'dup' },
    { command: 'group_entities', params: { ids: ['$b', '$dup'], name: 'pair' }, as: 'g' },
    { command: 'set_entity_name', params: { id: '$b', name: 'original', tags: ['a', 'b'] } },
  ],
  layers: [
    { command: 'add_layer', params: { name: 'Walls', color: '#ff0000' }, as: 'l1' },
    { command: 'add_layer', params: { name: 'Doors' }, as: 'l2' },
    { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
    { command: 'set_entity_layer', params: { entityId: '$b', layerId: '$l1' } },
    { command: 'rename_layer', params: { id: '$l2', name: 'Windows' } },
    { command: 'set_layer_visibility', params: { id: '$l2', visible: false } },
    { command: 'set_layer_lock', params: { id: '$l1', locked: true } },
  ],
  materials_assign: [
    { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
    {
      command: 'create_material',
      params: { name: 'steel', density: 0.00785, color: '#808080', metalness: 0.9, roughness: 0.3 },
    },
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
    {
      repeat: { count: '=n' },
      step: { command: 'add_box', params: { size: [1, 1, 1], position: ['=$i * 3', 0, 0] } },
    },
    {
      for_each: { values: [1, 2, 3], as: 'r' },
      step: { command: 'add_sphere', params: { radius: '=$r', position: ['=$r * 10', 5, 0] } },
    },
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
    { command: 'draw_line', params: { start: [0, 0], end: [10, 0] }, as: 'a' },
    { command: 'draw_line', params: { start: [0, 1], end: [10, 4] }, as: 'b' },
    {
      command: 'add_constraint',
      params: { constraint: { kind: 'parallel', a: { entityId: '$a' }, b: { entityId: '$b' } } },
    },
    {
      command: 'add_constraint',
      params: {
        constraint: { kind: 'distance', a: { entityId: '$a' }, b: { entityId: '$b' }, value: 4 },
      },
    },
    { command: 'solve_constraints', params: {} },
  ],
  assembly_components_instances: [
    { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
    {
      command: 'create_component',
      params: { name: 'Cube', entityIds: ['$b'], componentId: 'comp-cube' },
    },
    { command: 'insert_instance', params: { componentId: 'comp-cube', position: [5, 0, 0] } },
    {
      command: 'insert_instance',
      params: { componentId: 'comp-cube', position: [10, 0, 0], rotation: [0, 0, 1] },
    },
  ],
  assembly_mates: [
    { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
    {
      command: 'create_component',
      params: { name: 'Cube', entityIds: ['$b'], componentId: 'comp-cube' },
    },
    {
      command: 'insert_instance',
      params: { componentId: 'comp-cube', position: [5, 0, 0] },
      as: 'ia',
    },
    {
      command: 'insert_instance',
      params: { componentId: 'comp-cube', position: [20, 0, 0] },
      as: 'ib',
    },
    {
      command: 'add_mate',
      params: { kind: 'distance', a: { instanceId: '$ia' }, b: { instanceId: '$ib' }, value: 5 },
    },
  ],
  assembly_joints: [
    { command: 'add_box', params: { size: [1, 1, 1] }, as: 'b' },
    {
      command: 'create_component',
      params: { name: 'Cube', entityIds: ['$b'], componentId: 'comp-cube' },
    },
    {
      command: 'insert_instance',
      params: { componentId: 'comp-cube', position: [0, 0, 0] },
      as: 'ia',
    },
    {
      command: 'insert_instance',
      params: { componentId: 'comp-cube', position: [3, 0, 0] },
      as: 'ib',
    },
    {
      command: 'add_joint',
      params: { kind: 'revolute', a: { instanceId: '$ia' }, b: { instanceId: '$ib' }, axis: 'z' },
      as: 'j',
    },
    { command: 'set_joint_value', params: { id: '$j', value: 0.5 } },
  ],
  gears_spur_and_belt: [
    { command: 'add_spur_gear', params: { module: 2, teeth: 20, faceWidth: 5 } },
    {
      command: 'add_spur_gear',
      params: { module: 2, teeth: 30, faceWidth: 5, position: [50, 0, 0], name: 'big' },
    },
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
  templates: [
    {
      command: 'instantiate_template',
      params: {
        template: 'bolt_hole_pattern',
        params: { count: 6, boltCircleRadius: 10, holeRadius: 1 },
      },
    },
    {
      command: 'instantiate_template',
      params: {
        template: 'rectangular_plate_with_holes',
        params: {
          width: 40,
          height: 20,
          holeRows: 2,
          holeCols: 3,
          holeRadius: 2,
          marginX: 5,
          marginY: 5,
        },
        position: [0, 30, 0],
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
    { command: 'animate_spin', params: { targetId: '$b', speed: 1 } },
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
  building_walls_openings_slab: [
    { command: 'set_units', params: { units: 'mm' } },
    { command: 'add_grid_system', params: { xSpacings: [5000, 5000], ySpacings: [4000] } },
    { command: 'add_wall', params: { start: [0, 0], end: [10000, 0] } },
    { command: 'add_wall', params: { start: [10000, 0], end: [10000, 8000] } },
    { command: 'add_wall', params: { start: [10000, 8000], end: [0, 8000] } },
    { command: 'add_wall', params: { start: [0, 8000], end: [0, 0] } },
    { command: 'add_door', params: { wallId: 'wall-1', offset: 1500 } },
    { command: 'add_window', params: { wallId: 'wall-2', offset: 3000 } },
    { command: 'add_slab', params: { wallIds: ['wall-1', 'wall-2', 'wall-3', 'wall-4'] } },
    { command: 'add_column', params: { location: [5000, 4000] } },
    { command: 'add_beam', params: { start: [0, 4000], end: [10000, 4000] } },
    { command: 'add_level', params: { name: 'First' } },
    { command: 'update_wall', params: { wallId: 'wall-1', height: 2800 } },
  ],
  industrial_portal_frame: [
    {
      command: 'add_portal_frame_building',
      params: { span: 18000, length: 30000, baySpacing: 6000, eaveHeight: 6000, roofPitch: 6 },
    },
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
};

/** Plans needing the Manifold geometry kernel (booleans). */
export const kernelPlans: Record<string, GoldenAction[]> = {
  kernel_boolean_union: [
    { command: 'add_box', params: { size: [2, 2, 2] }, as: 'a' },
    { command: 'add_box', params: { size: [2, 2, 2], position: [1, 1, 1] }, as: 'b' },
    { command: 'boolean_union', params: { a: '$a', b: '$b' } },
  ],
  kernel_boolean_subtract: [
    { command: 'add_box', params: { size: [4, 4, 4] }, as: 'a' },
    { command: 'add_cylinder', params: { radius: 1, height: 6 }, as: 'b' },
    { command: 'boolean_subtract', params: { a: '$a', b: '$b' } },
  ],
};
