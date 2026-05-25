/**
 * @layer core/mcp
 *
 * MCP prompt definitions — pure, framework-agnostic.
 *
 * Exposes guided prompt templates that hand an agent a ready-to-fill plan
 * skeleton for common modeling tasks, dramatically reducing trial-and-error
 * when driving llull via `build_project`.
 *
 * Every template references REAL registered tools only:
 *   build_project, add_box, draw_rectangle, extrude_sketch, boolean_subtract,
 *   set_entity_name, describe_scene, find_entities
 *
 * No SDK / transport / fetch imports — transport wiring lives in server/.
 *
 * @pure — no side effects; only the provided args determine the output.
 */

// ---------------------------------------------------------------------------
// Types (minimal, mirrors MCP PromptMessage / Prompt schema shapes)
// ---------------------------------------------------------------------------

/**
 * A single message in a prompt result.
 * Mirrors the MCP `PromptMessage` schema (role + text content).
 */
export interface McpPromptMessage {
  role: 'user' | 'assistant';
  content: {
    type: 'text';
    text: string;
  };
}

/**
 * An argument descriptor for a prompt template.
 * Mirrors the MCP `PromptArgument` schema.
 */
export interface McpPromptArgument {
  name: string;
  description: string;
  required: boolean;
}

/**
 * A prompt template descriptor (the listing entry).
 * Mirrors the MCP `Prompt` schema.
 */
export interface McpPromptDescriptor {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
}

/**
 * A fully resolved prompt — descriptor + messages ready to send.
 * Mirrors the MCP `GetPromptResult` schema.
 */
export interface McpPromptResult {
  description: string;
  messages: McpPromptMessage[];
}

// ---------------------------------------------------------------------------
// Internal template definition shape
// ---------------------------------------------------------------------------

interface PromptTemplate {
  descriptor: McpPromptDescriptor;
  buildMessages: (args: Record<string, string>) => McpPromptMessage[];
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function userMsg(text: string): McpPromptMessage {
  return { role: 'user', content: { type: 'text', text } };
}

function assistantMsg(text: string): McpPromptMessage {
  return { role: 'assistant', content: { type: 'text', text } };
}

// ---------------------------------------------------------------------------
// Template: model_bracket
// ---------------------------------------------------------------------------

/**
 * @prompt model_bracket
 * Guides an agent through building a parametric bracket:
 * 1. draw_rectangle → extrude_sketch → body solid
 * 2. N × draw_circle → extrude_sketch → boolean_subtract for mounting holes
 * 3. set_entity_name for every created part
 * All assembled into a single build_project action-list.
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
      { name: 'height', description: 'Bracket height (depth) in model units (e.g. 40)', required: true },
      { name: 'thickness', description: 'Bracket wall thickness in model units (e.g. 6)', required: true },
      {
        name: 'hole_count',
        description: 'Number of mounting holes (1–4). Holes are evenly spaced along the bracket width.',
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

    // Evenly space hole centers along the width.
    // boolean_subtract consumes BOTH operands and returns a NEW mesh entity.
    // Each subtract must chain: body_0 → body_1 → … → body_N.
    // The final body alias is `body_${n - 1}` (or just "body" when n === 0, unreachable).
    const holeActions: string[] = [];
    for (let i = 0; i < n; i++) {
      const cx = n === 1 ? w / 2 : (w / (n + 1)) * (i + 1);
      const cy = h / 2;
      const holeSketchAlias = `hole_sketch_${i}`;
      const holeSolidAlias = `hole_solid_${i}`;
      // The current body operand: first iteration uses "body", subsequent use the prior result.
      const bodyIn = i === 0 ? 'body' : `body_${i - 1}`;
      const bodyOut = `body_${i}`;
      holeActions.push(`    { "command": "draw_circle",    "params": { "center": [${cx}, ${cy}], "radius": ${holeRadius} }, "as": "${holeSketchAlias}" },`);
      holeActions.push(`    { "command": "extrude_sketch",  "params": { "id": "$${holeSketchAlias}", "depth": ${holeDepth} }, "as": "${holeSolidAlias}" },`);
      holeActions.push(`    { "command": "boolean_subtract","params": { "a": "$${bodyIn}", "b": "$${holeSolidAlias}" }, "as": "${bodyOut}" },`);
    }

    // The final mesh is the last body alias produced by the subtract chain.
    const finalBodyAlias = `body_${n - 1}`;

    const holeSection = holeActions.join('\n');

    return [
      userMsg(
        `I need a build_project plan for a rectangular bracket.\n` +
          `Parameters: width=${w}, height=${h}, thickness=${t}, hole_count=${n}.\n\n` +
          `Please produce the complete action-list JSON.`,
      ),
      assistantMsg(
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
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Template: orthographic_setup
// ---------------------------------------------------------------------------

/**
 * @prompt orthographic_setup
 * Guides an agent through orienting/inspecting the scene from standard
 * orthographic view directions (front, top, right) using the tools that exist.
 * Honest about the current viewport: view direction is a UI concern but an
 * agent can use describe_scene + find_entities to orient itself programmatically.
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
    const viewMap: Record<string, { axis: string; cameraHint: string; positionNote: string }> = {
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

    const info = viewMap[view] ?? viewMap['top']!;

    return [
      userMsg(`Set up a ${view} orthographic view of the current scene.`),
      assistantMsg(
        `**${view.toUpperCase()} orthographic orientation**\n\n` +
          `Camera axis: ${info.axis} — ${info.cameraHint}\n` +
          `${info.positionNote}\n\n` +
          `**To orient yourself programmatically, run these steps:**\n\n` +
          `1. Call \`describe_scene\` (no params) to get the full \`SceneSnapshot\`:\n` +
          `   - \`bounds\` tells you the world bounding box of all entities.\n` +
          `   - \`entities[]\` lists every entity id, kind, and world bounds.\n` +
          `   - \`entityCount\` lets you confirm the scene has content.\n\n` +
          `2. Call \`find_entities\` with a \`filter\` to narrow by kind, layer, or name:\n` +
          `   \`\`\`json\n` +
          `   { "filter": { "kind": "box" } }\n` +
          `   \`\`\`\n` +
          `   The result lists matching ids so you can reference them in subsequent commands.\n\n` +
          `3. For a structured read, read the \`cad://scene\` MCP resource — it carries the same\n` +
          `   \`SceneSnapshot\` without consuming a tool call.\n\n` +
          `**Viewport note**\n` +
          `The llull viewport camera is controlled interactively in the browser UI (orbit, pan, zoom).\n` +
          `An MCP agent cannot reposition the camera directly, but the tools above give you\n` +
          `complete spatial awareness of every entity in model space.`,
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Template: parametric_part
// ---------------------------------------------------------------------------

/**
 * @prompt parametric_part
 * Guides an agent through authoring a multi-step, alias-linked build_project plan
 * that reads like a parametric feature tree — each step is a named feature whose
 * result can be referenced by later steps via $alias.
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
    return [
      userMsg(
        `Show me how to model a parametric part called "${part_name}" using build_project ` +
          `with alias references between steps.`,
      ),
      assistantMsg(
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
      ),
    ];
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const TEMPLATES: ReadonlyArray<PromptTemplate> = [modelBracket, orthographicSetup, parametricPart];

const TEMPLATE_MAP = new Map<string, PromptTemplate>(TEMPLATES.map((t) => [t.descriptor.name, t]));

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the list of all registered prompt template descriptors.
 *
 * @pure
 * @layer core/mcp
 */
export function listMcpPrompts(): McpPromptDescriptor[] {
  return TEMPLATES.map((t) => t.descriptor);
}

/**
 * Resolve a prompt template by name, substituting the provided args.
 *
 * Returns `null` when the name is not a registered template — the transport
 * should reply with an appropriate MCP error.
 *
 * @pure
 * @layer core/mcp
 * @failure unknown name -> null
 */
export function getMcpPrompt(
  name: string,
  args: Record<string, string> = {},
): McpPromptResult | null {
  const template = TEMPLATE_MAP.get(name);
  if (!template) return null;
  return {
    description: template.descriptor.description,
    messages: template.buildMessages(args),
  };
}
