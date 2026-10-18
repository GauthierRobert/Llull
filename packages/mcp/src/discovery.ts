/**
 * Discovery meta-tools `search_tools` / `enable_toolset`: MCP-layer (not registry commands), in the always-on `core`
 * toolset. A host exposes `core` by default; enabling a toolset makes the host send `notifications/tools/list_changed`.
 */
import { clamp } from '@lib/clamp';
import { isFiniteNumber } from '@lib/isFiniteNumber';
import { isRecord } from '@lib/isRecord';
import { buildMcpTools, type McpToolDefinition } from './tools';
import { buildExchangeToolDefinitions } from './exchangeTools';
import { buildFeaToolDefinitions } from './feaTools';
import { buildLibraryToolDefinitions } from './libraryTools';
import { shapeToolCallContent, type McpShapedResult } from './dispatch';
import { parseQuery, scoreTool, toolIndex } from './discoveryRank';
import { TOOLSET_NAMES, TOOLSETS, isToolEnabled, toolKey, toolsetOf, type ToolsetName } from './toolsets';

export interface ToolSearchResult {
  readonly name: string;
  readonly toolset: ToolsetName;
  readonly enabled: boolean;
  readonly description: string;
}

interface DiscoveryOutcome {
  readonly result: McpShapedResult;
  readonly toolsListChanged: boolean;
}

const SEARCH_TOOLS_DEFAULT_LIMIT = 10;
const SEARCH_TOOLS_MAX_LIMIT = 50;

export function buildDiscoveryToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: 'search_tools',
      description:
        'Find llull tools by keyword over tool names and descriptions, including tools whose toolset is ' +
        'not enabled yet. Each result is compact: name, toolset, enabled flag and a one-sentence summary. ' +
        'Enable just the tools you need with enable_toolset { tools: [names] } to load their schemas. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords, e.g. "wall", "fillet edge", "export step", "measure volume".' },
          limit: { type: 'number', description: `Max results (default ${SEARCH_TOOLS_DEFAULT_LIMIT}, max ${SEARCH_TOOLS_MAX_LIMIT}).` },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'enable_toolset',
      description:
        `Enable tools for this MCP session so they appear in tools/list: individual tools via "tools" ` +
        `(cheap: only those schemas load) or a whole toolset via "toolset" (can be large). Toolsets: ` +
        `${TOOLSET_NAMES.join(', ')}. The server sends notifications/tools/list_changed; re-list tools afterwards.`,
      inputSchema: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: { type: 'string' },
            description: 'Exact tool names to enable (from search_tools results), e.g. ["pipe_hydraulics", "add_pipe_run"].',
          },
          toolset: { type: 'string', description: `Whole toolset: ${TOOLSET_NAMES.join(', ')}, or "all". Prefer "tools".` },
        },
        required: [],
      },
      annotations: { idempotentHint: true },
    },
  ];
}

/** Every tool a session can be served: registry commands + exchange + FE + discovery meta-tools. */
export function buildAllMcpTools(): McpToolDefinition[] {
  return [
    ...buildMcpTools(),
    ...buildExchangeToolDefinitions(),
    ...buildFeaToolDefinitions(),
    ...buildLibraryToolDefinitions(),
    ...buildDiscoveryToolDefinitions(),
  ];
}

/**
 * Rank every tool (registry commands + exchange + FE + discovery tools, enabled or not) against `query`.
 * @invariant results sorted by score desc then name; zero-score tools are dropped
 */
export function searchTools(query: string, limit: number, enabledToolsets: ReadonlySet<string>): ToolSearchResult[] {
  const parsed = parseQuery(query);
  if (parsed.terms.length === 0) return [];
  const all = buildAllMcpTools();
  const index = toolIndex(all);
  return all
    .map((tool) => {
      const toolset = toolsetOf(tool.name) ?? 'core';
      return { tool, toolset, score: scoreTool(tool.name, toolset, parsed, index) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
    .filter(({ score }, _position, sorted) => score >= (sorted[0]?.score ?? 0) * MIN_RELATIVE_SCORE)
    .slice(0, limit)
    .map(({ tool, toolset }) => ({
      name: tool.name,
      toolset,
      enabled: isToolEnabled(tool.name, enabledToolsets),
      description: tool.description,
    }));
}

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current.push(Math.min(substitution, (previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1));
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** Tool names within a typo's edit distance of `name` (closest first, ties by name). */
export function closestToolNames(name: string, limit: number): string[] {
  const wanted = name.toLowerCase();
  const maxDistance = Math.max(2, Math.floor(wanted.length / 3));
  return buildAllMcpTools()
    .map((tool) => ({ name: tool.name, distance: editDistance(wanted, tool.name) }))
    .filter(({ distance }) => distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name: toolName }) => toolName);
}

/** "Did you mean" names: typo matches, else keyword search of `foo_bar` as "foo bar". */
export function suggestToolNames(name: string, limit: number, enabledToolsets: ReadonlySet<string>): string[] {
  const typoMatches = closestToolNames(name, limit);
  return typoMatches.length > 0 ? typoMatches : searchTools(name.replace(/_/g, ' '), limit, enabledToolsets).map((r) => r.name);
}

function outcome(summary: string, isError: boolean, data?: unknown, toolsListChanged = false): DiscoveryOutcome {
  return { result: shapeToolCallContent({ summary, affected: [], isError, data }), toolsListChanged };
}

/** First sentence of `text`, cut at `max` characters (ellipsis when cut). */
function firstSentence(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[.!?](\s|$)/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
}

const SUMMARY_MAX_CHARS = 200;
const ENABLE_HINT_TOOLS = 3;
/** Hits scoring below this fraction of the best hit are noise and dropped. */
const MIN_RELATIVE_SCORE = 0.12;

interface CompactToolHit {
  readonly name: string;
  readonly toolset: ToolsetName;
  readonly enabled: boolean;
  readonly summary: string;
}

function runSearchTools(args: Record<string, unknown>, enabledToolsets: ReadonlySet<string>): DiscoveryOutcome {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query === '') return outcome('search_tools: query must be a non-empty string.', true);
  const requestedLimit = isFiniteNumber(args.limit) ? args.limit : SEARCH_TOOLS_DEFAULT_LIMIT;
  const limit = clamp(Math.floor(requestedLimit), 1, SEARCH_TOOLS_MAX_LIMIT);
  const hits = searchTools(query, limit, enabledToolsets);
  const results: CompactToolHit[] = hits.map((hit) => ({
    name: hit.name,
    toolset: hit.toolset,
    enabled: hit.enabled,
    summary: firstSentence(hit.description, SUMMARY_MAX_CHARS),
  }));
  if (results.length === 0) return outcome(`search_tools: no tools match "${query}".`, false, { results });
  const names = results.map((r) => `${r.name} [${r.toolset}${r.enabled ? '' : ', disabled'}]`);
  const disabled = results.filter((r) => !r.enabled);
  const suggested = disabled.slice(0, ENABLE_HINT_TOOLS);
  const topSet = suggested[0]?.toolset;
  const hint =
    topSet === undefined
      ? ''
      : ` To use disabled tools call enable_toolset ${JSON.stringify({ tools: suggested.map((r) => r.name) })} (only those; schemas then appear in tools/list)` +
        ` or { "toolset": "${topSet}" } for all ${TOOLSETS[topSet].length} tools of ${topSet}.`;
  return outcome(`search_tools: ${results.length} match(es) for "${query}": ${names.join(', ')}.${hint}`, false, { results });
}

/** Deduplicated tool names in `args.tools` (none when absent); `invalid` when it is not an array of strings. */
function requestedTools(args: Record<string, unknown>): { names: string[]; invalid: boolean } {
  if (args.tools === undefined) return { names: [], invalid: false };
  if (!Array.isArray(args.tools) || !args.tools.every((name) => typeof name === 'string')) return { names: [], invalid: true };
  return { names: [...new Set(args.tools.map((name: string) => name.trim()).filter((name) => name !== ''))], invalid: false };
}

function enableAll(enabledToolsets: Set<string>): DiscoveryOutcome {
  const added = TOOLSET_NAMES.filter((name) => !enabledToolsets.has(name));
  added.forEach((name) => enabledToolsets.add(name));
  const summary =
    added.length > 0
      ? `enable_toolset: enabled all toolsets (${added.join(', ')} added); re-list tools to load their schemas.`
      : 'enable_toolset: all toolsets were already enabled.';
  return outcome(summary, false, { toolset: 'all', changed: added.length > 0, enabled: [...enabledToolsets] }, added.length > 0);
}

function enableTools(names: readonly string[], enabledToolsets: Set<string>): DiscoveryOutcome {
  const known = new Set(buildAllMcpTools().map((tool) => tool.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    const didYouMean = unknown.map(
      (name) => `${name}${closestToolNames(name, 2).length > 0 ? ` (did you mean ${closestToolNames(name, 2).join(', ')}?)` : ''}`,
    );
    return outcome(`enable_toolset: unknown tool(s): ${didYouMean.join('; ')}. Find names with search_tools.`, true);
  }
  const added = names.filter((name) => !isToolEnabled(name, enabledToolsets));
  added.forEach((name) => enabledToolsets.add(toolKey(name)));
  const summary =
    added.length > 0
      ? `enable_toolset: enabled ${added.length} tool(s) for this session: ${added.join(', ')}; re-list tools to load their schemas.` +
        (added.length < names.length ? ` Already enabled: ${names.filter((name) => !added.includes(name)).join(', ')}.` : '')
      : `enable_toolset: ${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} already enabled.`;
  return outcome(summary, false, { tools: names, added, changed: added.length > 0 }, added.length > 0);
}

function runEnableToolset(args: Record<string, unknown>, enabledToolsets: Set<string>): DiscoveryOutcome {
  const requested = typeof args.toolset === 'string' ? args.toolset.trim().toLowerCase() : '';
  const tools = requestedTools(args);
  if (tools.invalid) return outcome('enable_toolset: "tools" must be an array of tool names (strings).', true);
  if (tools.names.length > 0 && requested === '') return enableTools(tools.names, enabledToolsets);
  if (requested === 'all') return enableAll(enabledToolsets);
  const toolset = TOOLSET_NAMES.find((name) => name === requested);
  if (toolset === undefined) {
    const shown = requested === '' ? 'a "toolset" string argument (or a "tools" array of tool names)' : `"${requested}"`;
    return outcome(`enable_toolset: unknown toolset ${shown}. Valid toolsets: ${TOOLSET_NAMES.join(', ')}, or "all".`, true);
  }
  const changed = !enabledToolsets.has(toolset);
  enabledToolsets.add(toolset);
  const summary = changed
    ? `enable_toolset: enabled "${toolset}" for this session; re-list tools to load its schemas.`
    : `enable_toolset: "${toolset}" was already enabled.`;
  return outcome(summary, false, { toolset, changed, enabled: [...enabledToolsets] }, changed);
}

/**
 * Dispatch a discovery tool call; returns null for any other tool name.
 * @failure empty query / unknown toolset or tool → isError result (valid toolsets listed)
 */
export function applyDiscoveryToolCall(toolName: string, rawArgs: unknown, enabledToolsets: Set<string>): DiscoveryOutcome | null {
  const args = isRecord(rawArgs) ? rawArgs : {};
  if (toolName === 'search_tools') return runSearchTools(args, enabledToolsets);
  return toolName === 'enable_toolset' ? runEnableToolset(args, enabledToolsets) : null;
}
