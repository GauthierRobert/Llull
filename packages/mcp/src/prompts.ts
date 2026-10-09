/**
 * @layer mcp
 * MCP prompt templates — guided plan skeletons that cut trial-and-error when an agent drives llull
 * via `build_project`. Every template references REAL registered tools only. The shapes below mirror
 * the MCP `PromptMessage` / `PromptArgument` / `Prompt` / `GetPromptResult` schemas (no SDK import:
 * transport wiring lives in `server/`).
 *
 * @pure only the provided args determine the output.
 */

interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

interface McpPromptDescriptor {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
}

interface McpPromptResult {
  description: string;
  messages: McpPromptMessage[];
}

interface PromptTemplate {
  descriptor: McpPromptDescriptor;
  buildMessages: (args: Record<string, string>) => McpPromptMessage[];
}

/** Every template is one user request answered by one assistant plan. */
function conversation(userText: string, assistantText: string): McpPromptMessage[] {
  return [
    { role: 'user', content: { type: 'text', text: userText } },
    { role: 'assistant', content: { type: 'text', text: assistantText } },
  ];
}

/**
 * @prompt model_bracket
 * draw_rectangle → extrude_sketch body, then N × (draw_circle → extrude_sketch → boolean_subtract)
 * for the mounting holes, as one build_project action-list.
 */
const modelBracket: PromptTemplate = {
  descriptor: {
    name: 'model_bracket',
    description:
      'Generate a build_project plan that models a rectangular bracket with mounting holes. ' +
      'Provide width, height (depth), thickness, and hole_count; the prompt returns a complete ' +
      'action-list you can pass directly to build_project.',
    arguments: [
      { name: 'width', description: 'Bracket width in model units (e.g. 80)', required: true },
      {
        name: 'height',
        description: 'Bracket height (depth) in model units (e.g. 40)',
        required: true,
      },
      {
        name: 'thickness',
        description: 'Bracket wall thickness in model units (e.g. 6)',
        required: true,
      },
      {
        name: 'hole_count',
        description:
          'Number of mounting holes (1–4). Holes are evenly spaced along the bracket width.',
        required: false,
      },
    ],
  },
  buildMessages({ width = '80', height = '40', thickness = '6', hole_count = '2' }) {
    const w = Number(width);
    const h = Number(height);
    const t = Number(thickness);
    const n = Math.min(Math.max(Math.round(Number(hole_count)), 1), 4);
    const holeRadius = Math.max(t * 0.4, 2);
    const holeDepth = t + 2; // punch fully through

    // Hole centers are evenly spaced along the width. boolean_subtract consumes BOTH operands and
    // returns a NEW mesh, so the subtracts chain: body → body_0 → body_1 → … → body_${n - 1}.
    const holeActions: string[] = [];
    for (let i = 0; i < n; i++) {
      const cx = n === 1 ? w / 2 : (w / (n + 1)) * (i + 1);
      const holeSketchAlias = `hole_sketch_${i}`;
      const holeSolidAlias = `hole_solid_${i}`;
      const bodyIn = i === 0 ? 'body' : `body_${i - 1}`;
      holeActions.push(
        `    { "command": "draw_circle",    "params": { "center": [${cx}, ${h / 2}], "radius": ${holeRadius} }, "as": "${holeSketchAlias}" },`,
        `    { "command": "extrude_sketch",  "params": { "id": "$${holeSketchAlias}", "depth": ${holeDepth} }, "as": "${holeSolidAlias}" },`,
        `    { "command": "boolean_subtract","params": { "a": "$${bodyIn}", "b": "$${holeSolidAlias}" }, "as": "body_${i}" },`,
      );
    }
    const finalBodyAlias = `body_${n - 1}`;
    const holeSection = holeActions.join('\n');

    return conversation(
      `I need a build_project plan for a rectangular bracket.\n` +
        `Parameters: width=${w}, height=${h}, thickness=${t}, hole_count=${n}.\n\n` +
        `Please produce the complete action-list JSON.`,
      `Here is a complete \`build_project\` action-list for the bracket.\n\n` +
        `Call the \`build_project\` tool with:\n\n` +
        `\`\`\`json\n` +
        `{\n` +
        `  "actions": [\n` +
        `    { "command": "draw_rectangle", "params": { "width": ${w}, "height": ${h} }, "as": "base_rect" },\n` +
        `    { "command": "extrude_sketch",  "params": { "id": "$base_rect", "depth": ${t} }, "as": "body" },\n` +
        holeSection +
        `\n` +
        `    { "command": "set_entity_name", "params": { "id": "$${finalBodyAlias}", "name": "bracket_body" } },\n` +
        `    { "command": "describe_scene", "params": {} }\n` +
        `  ],\n` +
        `  "onError": "abort"\n` +
        `}\n` +
        `\`\`\`\n\n` +
        `**Key points**\n` +
        `- \`draw_rectangle\` requires only \`width\` and \`height\`; \`position\` (optional [x,y,z]) places the work-plane origin.\n` +
        `- \`extrude_sketch\` accepts only \`id\` and \`depth\`; it inherits the sketch's position automatically.\n` +
        `- \`boolean_subtract\` uses params \`a\` (base solid) and \`b\` (tool solid); BOTH operands are consumed and replaced by a new mesh entity — bind the result with \`as\` so later steps can reference it.\n` +
        `- Each subtract chains to the previous result: body → body_0 → body_1 → … The final mesh alias is \`$${finalBodyAlias}\`.\n` +
        `- \`$alias\` references let later steps use entity ids created in earlier steps without knowing them in advance.\n` +
        `- \`describe_scene\` at the end lets you verify the final entity count and bounding box.\n` +
        `- Run with \`validate: true\` first to check the plan without mutating the document.`,
    );
  },
};

const ORTHOGRAPHIC_VIEWS = {
  top: {
    axis: '+Z',
    cameraHint: 'Looking down the −Z axis (positive Z toward you).',
    positionNote: 'Entity X/Y positions are the plan coordinates; Z is depth.',
  },
  front: {
    axis: '+Y',
    cameraHint: 'Looking along the −Y axis (positive Y away from you).',
    positionNote: 'Entity X positions are lateral, Z positions are vertical elevation.',
  },
  right: {
    axis: '+X',
    cameraHint: 'Looking along the −X axis (positive X away from you).',
    positionNote: 'Entity Y positions are lateral (depth), Z positions are vertical elevation.',
  },
};

/**
 * @prompt orthographic_setup
 * Orients an agent from front / top / right with describe_scene + find_entities: the viewport
 * camera is a UI concern an agent cannot drive.
 */
const orthographicSetup: PromptTemplate = {
  descriptor: {
    name: 'orthographic_setup',
    description:
      'Guidance for setting up and inspecting the scene from standard orthographic directions ' +
      '(front / top / right). Uses describe_scene and find_entities to orient an agent that ' +
      'cannot directly control the viewport camera.',
    arguments: [
      {
        name: 'view',
        description: 'Target view direction: "front", "top", or "right". Default: "top".',
        required: false,
      },
    ],
  },
  buildMessages({ view = 'top' }) {
    const info =
      ORTHOGRAPHIC_VIEWS[view as keyof typeof ORTHOGRAPHIC_VIEWS] ?? ORTHOGRAPHIC_VIEWS.top;

    return conversation(
      `Set up a ${view} orthographic view of the current scene.`,
      `**${view.toUpperCase()} orthographic orientation**\n\n` +
        `Camera axis: ${info.axis} — ${info.cameraHint}\n` +
        `${info.positionNote}\n\n` +
        `**To orient yourself programmatically, run these steps:**\n\n` +
        `1. Call \`describe_scene\` (no params) to get the full \`SceneSnapshot\`:\n` +
        `   - \`bounds\` tells you the world bounding box of all entities.\n` +
        `   - \`entities[]\` lists every entity id, kind, and world bounds.\n` +
        `   - \`entityCount\` lets you confirm the scene has content.\n\n` +
        `2. Call \`find_entities\` with filters such as \`kind\`, \`layerId\` or \`name\` to narrow the result:\n` +
        `   \`\`\`json\n` +
        `   { "kind": "box" }\n` +
        `   \`\`\`\n` +
        `   The result lists matching ids so you can reference them in subsequent commands.\n\n` +
        `3. For a structured read, read the \`cad://scene\` MCP resource — it carries the same\n` +
        `   \`SceneSnapshot\` without consuming a tool call.\n\n` +
        `**Viewport note**\n` +
        `The llull viewport camera is controlled interactively in the browser UI (orbit, pan, zoom).\n` +
        `An MCP agent cannot reposition the camera directly, but the tools above give you\n` +
        `complete spatial awareness of every entity in model space.`,
    );
  },
};

/**
 * @prompt parametric_part
 * An alias-linked build_project plan that reads like a parametric feature tree: each step's result
 * is referenced by later steps via $alias.
 */
const parametricPart: PromptTemplate = {
  descriptor: {
    name: 'parametric_part',
    description:
      'Template for modeling a parametric part using build_project alias references. ' +
      'Shows how to chain steps so each feature references the result of earlier features ' +
      'without hard-coding generated entity ids.',
    arguments: [
      {
        name: 'part_name',
        description: 'Human-readable name for the root solid (e.g. "mounting_plate").',
        required: false,
      },
    ],
  },
  buildMessages({ part_name = 'my_part' }) {
    return conversation(
      `Show me how to model a parametric part called "${part_name}" using build_project ` +
        `with alias references between steps.`,
      `**Parametric part recipe — \`build_project\` with \`$alias\` references**\n\n` +
        `The key insight: each step can declare \`"as": "<alias>"\`, and any later step can\n` +
        `reference that step's created entity id as \`"$<alias>"\` (first affected id) or\n` +
        `\`"$<alias>[N]"\` (Nth id). This makes the plan readable as a feature tree.\n\n` +
        `**Skeleton for "${part_name}"**\n\n` +
        `\`\`\`json\n` +
        `{\n` +
        `  "validate": true,\n` +
        `  "actions": [\n` +
        `\n` +
        `    // Step 0 — base profile (2-D sketch)\n` +
        `    // draw_rectangle requires only width and height; position (optional) places the work-plane origin.\n` +
        `    { "command": "draw_rectangle",\n` +
        `      "params": { "width": 100, "height": 60 },\n` +
        `      "as": "base_profile" },\n` +
        `\n` +
        `    // Step 1 — extrude into body solid\n` +
        `    // extrude_sketch accepts only id and depth; it inherits the sketch's position.\n` +
        `    { "command": "extrude_sketch",\n` +
        `      "params": { "id": "$base_profile", "depth": 10 },\n` +
        `      "as": "body" },\n` +
        `\n` +
        `    // Step 2 — add a cutout profile\n` +
        `    { "command": "draw_circle",\n` +
        `      "params": { "center": [50, 30], "radius": 8 },\n` +
        `      "as": "cutout_profile" },\n` +
        `\n` +
        `    // Step 3 — extrude cutout (depth > body depth to guarantee clean cut)\n` +
        `    { "command": "extrude_sketch",\n` +
        `      "params": { "id": "$cutout_profile", "depth": 12 },\n` +
        `      "as": "cutter" },\n` +
        `\n` +
        `    // Step 4 — subtract cutter from body\n` +
        `    // boolean_subtract params are a (base solid) and b (tool solid).\n` +
        `    // BOTH operands are consumed; bind the new mesh with as so later steps can use it.\n` +
        `    { "command": "boolean_subtract",\n` +
        `      "params": { "a": "$body", "b": "$cutter" },\n` +
        `      "as": "result" },\n` +
        `\n` +
        `    // Step 5 — name the final solid\n` +
        `    { "command": "set_entity_name",\n` +
        `      "params": { "id": "$result", "name": "${part_name}" } },\n` +
        `\n` +
        `    // Step 6 — inspect result\n` +
        `    { "command": "describe_scene", "params": {} }\n` +
        `\n` +
        `  ],\n` +
        `  "onError": "abort"\n` +
        `}\n` +
        `\`\`\`\n\n` +
        `**Tips for authoring parametric plans**\n\n` +
        `- Always pass \`"validate": true\` first — it checks every command name, required params,\n` +
        `  and \`$alias\` references without touching the document.\n` +
        `- Keep \`"onError": "abort"\` (default) so a mid-plan failure rolls everything back.\n` +
        `- Use descriptive alias names (\`"base_profile"\`, \`"body"\`, \`"cutter"\`) — they appear\n` +
        `  in the per-step report returned in \`result.data.steps\`.\n` +
        `- To edit a parameter, change its value in the action and re-run the plan — the\n` +
        `  command layer is pure, so the old entities are discarded and new ones are created.\n` +
        `- Use \`find_entities\` after the run to retrieve the final ids by name or kind for\n` +
        `  downstream operations.\n` +
        `- \`describe_scene\` at the end gives you the \`SceneSnapshot\` (bounds, entity list)\n` +
        `  in \`result.data.scene\` so you can confirm geometry without a second round-trip.`,
    );
  },
};

/**
 * @prompt design_building
 * Construction (AEC/BIM) workflow: levels → grid → walls → openings → slabs/structure → rooms →
 * quantities/cost → DXF / plan sheet / IFC deliverables.
 */
const designBuilding: PromptTemplate = {
  descriptor: {
    name: 'design_building',
    description:
      'Workflow for designing a building with the construction commands: levels, structural grid, ' +
      'walls with doors/windows, slabs, columns, beams, stairs, rooms, then quantity takeoff, cost ' +
      'estimate and DXF / plan-sheet / IFC deliverables.',
    arguments: [
      {
        name: 'brief',
        description: 'What to build, e.g. "2-storey house 10 x 8 m".',
        required: false,
      },
    ],
  },
  buildMessages({ brief = 'a two-storey house, 10 m x 8 m' }) {
    return conversation(
      `Design ${brief} in llull and produce the construction deliverables.`,
      `**Construction workflow (all lengths in document units — default mm)**\n\n` +
        `1. \`set_project_info\` (name, client, address, author, drawingNumber) — fills title blocks and IFC.\n` +
        `2. \`add_level\` per storey (elevation stacks automatically; height = floor-to-floor).\n` +
        `3. \`add_grid_system\` { xSpacings, ySpacings } — numbered / lettered axes.\n` +
        `4. \`draw_walls\` { points, closed: true, thickness, material } for the envelope; \`add_wall\` for partitions ` +
        `(endpoints on another wall join automatically); \`add_curved_wall\` { start, through, end } for arcs; \`set_wall_layers\` for build-ups (render + insulation + structure + lining).\n` +
        `5. \`add_door\` / \`add_window\` { wallId, offset | at, width, height, sillHeight } — hosted; refused if they do not fit.\n` +
        `6. \`add_slab\` { wallIds } (or boundary), \`add_column\` { atGridIntersections: true }, \`add_beam\`, \`add_stair\` ` +
        `(the summary checks the 2R+G comfort rule); \`add_slab_opening\` { stairId } cuts the stair well above.\n` +
        `7. \`add_room\` { name, wallIds | boundary } for each space.\n` +
        `8. Repeat a typical floor with \`copy_level_elements\`; roof = \`add_slab\` { role: "roof" } on the top level.\n` +
        `9. Inspect with \`describe_building\`, \`quantity_takeoff\`, \`building_schedule\` { kind }.\n` +
        `10. Price with \`set_cost_rates\` { rates: { "wall.masonry.m3": 210, "slab-floor.concrete.m3": 190, ... } } then \`estimate_cost\`.\n` +
        `11. Deliver: \`export_plan_sheet\` { paper: "A3", scale: 100 }, \`export_dxf\` { levelId }, \`export_ifc\`.\n\n` +
        `Edit parametrically with \`update_wall\`, \`update_opening\`, \`update_level\`, \`move_building_element\`, ` +
        `\`delete_building_element\` — never edit the generated entities (ids "<elementId>:<part>"); they are regenerated. ` +
        `For a quick start, \`add_building_template\` { template: "house" | "office" } creates a complete building. ` +
        `In \`build_project\`, a building step's \`$alias\` is the ELEMENT id (e.g. wall-3, usable as wallId); \`$alias[1]\` is its first generated entity.`,
    );
  },
};

/**
 * @prompt design_factory
 * Industrial workflow: steel portal hall → crane → process equipment & piping → clash check →
 * steel takeoff → elevations / plan / IFC deliverables.
 */
const designFactory: PromptTemplate = {
  descriptor: {
    name: 'design_factory',
    description:
      'Workflow for designing a factory / industrial hall: steel portal frames, crane runway, ' +
      'footings, cladding, machines with clearances, pipe runs, clash detection, steel tonnage and ' +
      'fabrication lists, then elevations, plan sheet and IFC deliverables.',
    arguments: [
      {
        name: 'brief',
        description: 'What to build, e.g. "30 x 60 m machining hall with a 16 t crane".',
        required: false,
      },
    ],
  },
  buildMessages({ brief = 'a 24 m x 48 m production hall with a 10 t overhead crane' }) {
    return conversation(
      `Design ${brief} in llull and produce the fabrication and construction deliverables.`,
      `**Industrial workflow (all lengths in document units — default mm)**\n\n` +
        `1. \`set_project_info\` (name, client, drawingNumber) — fills title blocks and IFC.\n` +
        `2. \`list_steel_profiles\` { family } — IPE, HEA, HEB, UPN, C, SHS, RHS, CHS, L with kg/m.\n` +
        `3. \`add_portal_frame_building\` { span, length, baySpacing, eaveHeight, roofPitch, columnProfile, ` +
        `rafterProfile, crane: { railHeight, capacity } } — grids, frames, gable posts, purlins, rails, bracing, ` +
        `footings, slab and cladding in one undoable step.\n` +
        `4. Adjust: \`update_steel_member\` { memberId, profile } to upsize, \`add_steel_member\` for mezzanines / ` +
        `platforms, \`add_crane_runway\`, \`add_footing\` { underColumns: true }, \`add_base_plates\`, \`add_moment_connections\`, \`add_panel\` for extra cladding.\n` +
        `5. Process: \`add_equipment\` { name, location, size, clearance, weight } for each machine, ` +
        `\`add_pipe_run\` { points, diameter, service } for utilities, \`add_cable_tray\` { points, width, system } for cabling.\n` +
        `5b. Structure, in this order (each design step feeds the next): \`design_portal_frames\` { deadLoad, snowLoad, windPressure (qp, kN/m²) } (frame sections, bolt groups and fixed base plates for gravity, wind and crane combinations; cranes read from the runways), then \`design_purlins\`, then \`design_footings\` (pad size + reinforcement), then verify with \`check_portal_frames\`, \`check_bracing\`, \`check_purlins\`, \`check_foundations\` and \`check_crane_runways\` using the same loads; deliver \`export_anchor_plan\` and \`export_nc_files\`. Prefer columnBase 'fixed' for crane halls (sway at rail level). For steel that is not a portal frame (process platforms, multi-storey structures, pipe racks, equipment supports) run \`check_steel_members\` { floorDeadLoad, imposedLoad } and resize any member with utilisation > 1; give every storey a lateral system in both directions — X-bracing, or moment frames (\`add_steel_member\` startJoint / endJoint 'rigid', column roll / baseFixity), e.g. pipe-rack bents. Carry every pipe on \`add_pipe_support\` shoes / hangers on steel and verify spans with \`check_pipe_supports\`.\n` +
        `6. Coordinate: \`check_clashes\` — fix every hard clash and clearance violation with ` +
        `\`move_building_element\` or \`update_steel_member\`, then re-check.\n` +
        `7. Quantities: \`quantity_takeoff\` (steel kg per profile, paint m², concrete m³, cladding m², pipe m), ` +
        `\`building_schedule\` { kind: "member" } for the cut list, then \`set_cost_rates\` and \`estimate_cost\`.\n` +
        `8. Drawings: \`export_elevation_sheet\` { direction, exclude: ["panel"] } for frame elevations, ` +
        `{ cutAt } for sections, \`export_plan_sheet\`, \`export_dxf\`, and \`export_ifc\` for the steel detailer.\n\n` +
        `Never edit generated entities (ids "<elementId>:<part>"); change the element and it is regenerated. ` +
        `\`describe_building\` summarises the model before delivery.`,
    );
  },
};

/**
 * @prompt design_site
 * Civil / site workflow: survey → terrain → platforms + balance → road alignment, profile and
 * template → storm drainage sizing and check → LandXML / DXF deliverables.
 */
const designSite: PromptTemplate = {
  descriptor: {
    name: 'design_site',
    description:
      'Workflow for a civil / site-engineering project: import the topographic survey, build the ' +
      'terrain (TIN + contours), grade and balance building platforms, lay out a road (alignment, ' +
      'profile, cross-section template, report), design the storm drainage network (manholes, ' +
      'pipes, sizing, hydraulic check) and export LandXML / DXF.',
    arguments: [
      {
        name: 'brief',
        description: 'The site to design, e.g. "logistics platform 120 x 80 m with access road".',
        required: false,
      },
    ],
  },
  buildMessages({ brief = 'a 60 m x 40 m building platform with a 300 m access road' }) {
    return conversation(
      `Design ${brief} in llull and produce the civil deliverables.`,
      `**Site workflow (lengths and elevations in document units — set \`set_units\` { units: "m" } first)**\n\n` +
        `1. Survey: \`import_survey_points\` { text, format: "PENZD" | "PNEZD" | …, sourceUnit } with the ` +
        `survey file content (or \`import_survey_dxf\` { text } for a DXF survey).\n` +
        `2. Terrain: \`create_surface\` { contourInterval, majorEvery, maxEdgeLength? }; check it with ` +
        `\`surface_report\` { surfaceId } and \`surface_elevation\` { surfaceId, points }.\n` +
        `3. Earthworks: \`add_platform\` { surfaceId, boundary, elevation, cutSlope, fillSlope } per pad, ` +
        `read cut / fill with \`platform_earthworks\` { platformId }, then \`balance_platform\` ` +
        `{ platformId, swellFactor } to set the level where cut and fill balance; \`compare_surfaces\` for surface-to-surface volumes.\n` +
        `4. Road: \`add_alignment\` { points, radii, surfaceId, stationInterval } for the centreline, ` +
        `\`set_alignment_profile\` { alignmentId, pvis: [{ station, elevation, curveLength }] } for the design ` +
        `profile, \`set_road_section\` { alignmentId, laneWidth, shoulderWidth, crossfall, cutSlope, fillSlope } ` +
        `for the template, then \`alignment_report\` { alignmentId, designSpeedKmh } (curve radii, grades, ` +
        `K-values) and \`export_long_section\` / \`export_cross_sections\` for the drawings.\n` +
        `5. Drainage: \`add_manhole\` { location, invertElevation, surfaceId, catchmentAreaHa, runoffCoefficient } ` +
        `at each structure, \`add_pipe\` { fromId, toId } downstream, then \`size_drainage_pipes\` ` +
        `{ rainfallIntensityMmH } and \`check_drainage_network\` (velocity, cover, capacity); fix every failure ` +
        `with \`update_manhole\` / \`update_pipe\` and re-check; \`drainage_schedule\` for the structure / pipe tables.\n` +
        `6. Deliver: \`export_landxml\` (points, surfaces, alignments, pipe network for Civil 3D / 12d) and ` +
        `\`export_civil_dxf\` (TIN as 3D faces, contours at their elevation).\n\n` +
        `Edit parametrically (\`update_surface\`, \`update_platform\`, \`update_alignment\`, …) — never edit the ` +
        `generated entities (ids "<objectId>:<part>"); \`describe_civil\` lists the model and ` +
        `\`delete_civil_object\` removes an object.`,
    );
  },
};

const TEMPLATES: ReadonlyArray<PromptTemplate> = [
  modelBracket,
  orthographicSetup,
  parametricPart,
  designBuilding,
  designFactory,
  designSite,
];

/** @pure */
export function listMcpPrompts(): McpPromptDescriptor[] {
  return TEMPLATES.map((t) => t.descriptor);
}

/**
 * Resolve a prompt template by name, substituting the provided args.
 * @pure
 * @failure unknown name -> null (the transport replies with an MCP error)
 */
export function getMcpPrompt(
  name: string,
  args: Record<string, string> = {},
): McpPromptResult | null {
  const template = TEMPLATES.find((candidate) => candidate.descriptor.name === name);
  if (!template) return null;
  return {
    description: template.descriptor.description,
    messages: template.buildMessages(args),
  };
}
