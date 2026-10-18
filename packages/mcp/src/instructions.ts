/**
 * The `instructions` string every MCP session returns from `initialize`: the first thing an agent
 * reads about llull. Names only real tools, params and resources (guarded by
 * `tests/unit/mcpTextReferences.test.ts`).
 */

export const SERVER_INSTRUCTIONS: string = [
  "llull is a 2D + 3D CAD document shared live with the user's browser and other agents; every change is a tool call and is visible at once.",
  '',
  '- Read the `cad://conventions` resource first: units, +Z up, per-primitive anchors, radians. Every length you pass is in the ' +
    'document `units` (default mm; the `cad://scene` resource reports the current ones, `set_units` changes them).',
  '- Only core tools are listed at first. Find others with `search_tools` (keywords), then load just those with ' +
    '`enable_toolset` { tools: [names] } (cheap), or a whole toolset { toolset } (can be tens of thousands of characters).',
  '- Batch work with `build_project`: `actions` is an array of { command, params, as? }; `as` aliases are referenced as ' +
    '`$alias` in later steps; `validate: true` is a dry run.',
  '- Orient with `describe_scene` or the `cad://scene` resource (one entity: the `cad://entity/{id}` resource template); verify with `render_view` and `check_model`.',
  '- Large results are cut in the text (the full data is in structuredContent): narrow requests with ' +
    '`find_entities` filters instead of listing everything.',
].join('\n');
