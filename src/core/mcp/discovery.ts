/**
 * @layer core/mcp
 *
 * Tool-discovery meta-tools — `search_tools` and `enable_toolset`. They are MCP-layer tools, NOT
 * registry commands (the command contract / toolSchemas snapshot stay unchanged); both belong to
 * the always-enabled `core` toolset. A host exposes only `core` by default; an agent finds a tool
 * with `search_tools` and loads its schema by enabling the toolset (the host then sends
 * `notifications/tools/list_changed`).
 *
 * @pure the only mutation is the injected per-session `enabledToolsets` set, by `enable_toolset`.
 */

import { isRecord } from '@lib/isRecord';
import { buildMcpTools, type McpToolDefinition } from './tools';
import { buildExchangeToolDefinitions } from './exchangeTools';
import { shapeToolCallContent, type McpShapedResult } from './dispatch';
import { TOOLSET_NAMES, isToolEnabled, toolsetOf, type ToolsetName } from './toolsets';

export interface ToolSearchResult {
  readonly name: string;
  readonly toolset: ToolsetName;
  readonly enabled: boolean;
  readonly description: string;
}

export interface DiscoveryOutcome {
  readonly result: McpShapedResult;
  /** true when the session's tool list changed (host must send tools/list_changed). */
  readonly toolsListChanged: boolean;
}

export const SEARCH_TOOLS_DEFAULT_LIMIT = 10;
export const SEARCH_TOOLS_MAX_LIMIT = 50;

const DISCOVERY_TOOLS = new Set(['search_tools', 'enable_toolset']);

export function buildDiscoveryToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: 'search_tools',
      description:
        'Find llull tools by keyword over tool names and descriptions, including tools whose toolset is ' +
        'not enabled yet. Each result carries its toolset and whether it is enabled; call enable_toolset ' +
        'for a disabled one to load its schema. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords, e.g. "wall", "fillet edge", "export step", "measure volume".',
          },
          limit: {
            type: 'number',
            description: `Max results (default ${SEARCH_TOOLS_DEFAULT_LIMIT}, max ${SEARCH_TOOLS_MAX_LIMIT}).`,
          },
        },
        required: ['query'],
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'enable_toolset',
      description:
        `Enable a toolset for this MCP session so its tools appear in tools/list. Toolsets: ` +
        `${TOOLSET_NAMES.join(', ')}. The server sends notifications/tools/list_changed; re-list tools afterwards.`,
      inputSchema: {
        type: 'object',
        properties: {
          toolset: {
            type: 'string',
            description: `Toolset name: ${TOOLSET_NAMES.join(', ')} (see search_tools results).`,
          },
        },
        required: ['toolset'],
      },
      annotations: { idempotentHint: true },
    },
  ];
}

interface CatalogEntry {
  readonly name: string;
  readonly description: string;
}

function toolCatalog(): CatalogEntry[] {
  return [
    ...buildMcpTools(),
    ...buildExchangeToolDefinitions(),
    ...buildDiscoveryToolDefinitions(),
  ].map(({ name, description }) => ({ name, description }));
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/** Keyword score: name-token match 10, name substring 5, toolset name 2, description substring 1. */
function scoreEntry(entry: CatalogEntry, toolset: ToolsetName, tokens: readonly string[]): number {
  const nameTokens = tokenize(entry.name);
  const description = entry.description.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (nameTokens.includes(token)) score += 10;
    else if (entry.name.includes(token)) score += 5;
    if (toolset === token) score += 2;
    if (description.includes(token)) score += 1;
  }
  return score;
}

/**
 * Rank every tool (registry commands + exchange + discovery tools, enabled or not) against `query`.
 * @invariant results sorted by score desc then name; zero-score tools are dropped
 */
export function searchTools(
  query: string,
  limit: number,
  enabledToolsets: ReadonlySet<ToolsetName>,
): ToolSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  return toolCatalog()
    .map((entry) => {
      const toolset = toolsetOf(entry.name) ?? 'core';
      return { entry, toolset, score: scoreEntry(entry, toolset, tokens) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, limit)
    .map(({ entry, toolset }) => ({
      name: entry.name,
      toolset,
      enabled: isToolEnabled(entry.name, enabledToolsets),
      description: entry.description,
    }));
}

function outcome(
  summary: string,
  isError: boolean,
  data?: unknown,
  toolsListChanged = false,
): DiscoveryOutcome {
  return {
    result: shapeToolCallContent({ summary, affected: [], isError, data }),
    toolsListChanged,
  };
}

function runSearchTools(
  args: Record<string, unknown>,
  enabledToolsets: ReadonlySet<ToolsetName>,
): DiscoveryOutcome {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query === '') return outcome('search_tools: query must be a non-empty string.', true);
  const rawLimit =
    typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : null;
  const limit = Math.min(
    SEARCH_TOOLS_MAX_LIMIT,
    Math.max(1, Math.floor(rawLimit ?? SEARCH_TOOLS_DEFAULT_LIMIT)),
  );
  const results = searchTools(query, limit, enabledToolsets);
  if (results.length === 0) {
    return outcome(`search_tools: no tools match "${query}".`, false, { results });
  }
  const names = results.map((r) => `${r.name} [${r.toolset}${r.enabled ? '' : ', disabled'}]`);
  const disabled = [...new Set(results.filter((r) => !r.enabled).map((r) => r.toolset))];
  const hint =
    disabled.length > 0
      ? ` Call enable_toolset for: ${disabled.join(', ')} to use disabled tools.`
      : '';
  return outcome(
    `search_tools: ${results.length} match(es) for "${query}": ${names.join(', ')}.${hint}`,
    false,
    { results },
  );
}

function runEnableToolset(
  args: Record<string, unknown>,
  enabledToolsets: Set<ToolsetName>,
): DiscoveryOutcome {
  const requested = typeof args.toolset === 'string' ? args.toolset.trim().toLowerCase() : '';
  const toolset = TOOLSET_NAMES.find((name) => name === requested);
  if (toolset === undefined) {
    return outcome(
      `enable_toolset: unknown toolset "${requested}". Valid toolsets: ${TOOLSET_NAMES.join(', ')}.`,
      true,
    );
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
 * @failure empty query / unknown toolset → isError result (valid toolsets listed)
 */
export function applyDiscoveryToolCall(
  toolName: string,
  rawArgs: unknown,
  enabledToolsets: Set<ToolsetName>,
): DiscoveryOutcome | null {
  if (!DISCOVERY_TOOLS.has(toolName)) return null;
  const args = isRecord(rawArgs) ? rawArgs : {};
  return toolName === 'search_tools'
    ? runSearchTools(args, enabledToolsets)
    : runEnableToolset(args, enabledToolsets);
}
