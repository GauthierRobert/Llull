/**
 * @layer mcp
 * The `instructions` string every MCP session returns from `initialize`: the first thing an agent
 * reads about llull. Names only real tools, params and resources (guarded by
 * `tests/unit/mcpTextReferences.test.ts`).
 * @pure
 */

export const SERVER_INSTRUCTIONS: string = [
  "llull is a 2D + 3D CAD document shared live with the user's browser; every change is a tool call.",
  '',
  '- Read the `cad://conventions` resource first: units, +Z up, per-primitive anchors, radians.',
  '- Only core tools are listed at first. Find others with `search_tools` (keywords) and load their ' +
    'schemas with `enable_toolset` (a toolset name, or "all").',
  '- Batch work with `build_project` (`as` aliases referenced as `$alias`; `validate: true` is a dry run).',
  '- Orient with `describe_scene` or the `cad://scene` resource; verify with `render_view` and `check_model`.',
  '- Large results are cut in the text (the full data is in structuredContent): narrow requests with ' +
    '`find_entities` filters instead of listing everything.',
].join('\n');
