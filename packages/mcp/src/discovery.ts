/**
 * @layer mcp
 *
 * Tool-discovery meta-tools — `search_tools` and `enable_toolset`. They are MCP-layer tools, NOT
 * registry commands (the command contract / toolSchemas snapshot stay unchanged); both belong to
 * the always-enabled `core` toolset. A host exposes only `core` by default; an agent finds a tool
 * with `search_tools` and loads its schema by enabling the toolset (the host then sends
 * `notifications/tools/list_changed`).
 *
 * @pure the only mutation is the injected per-session `enabledToolsets` set, by `enable_toolset`.
 */

import { isFiniteNumber } from '@lib/isFiniteNumber';
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

interface DiscoveryOutcome {
  readonly result: McpShapedResult;
  /** true when the session's tool list changed (host must send tools/list_changed). */
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
            description: `Toolset name: ${TOOLSET_NAMES.join(', ')}, or "all" (see search_tools results).`,
          },
        },
        required: ['toolset'],
      },
      annotations: { idempotentHint: true },
    },
  ];
}

/** Every tool a session can be served: registry commands + exchange + discovery meta-tools. */
export function buildAllMcpTools(): McpToolDefinition[] {
  return [
    ...buildMcpTools(),
    ...buildExchangeToolDefinitions(),
    ...buildDiscoveryToolDefinitions(),
  ];
}

/** Plural-insensitive stem: "edges" -> "edge", "holes" -> "hole", "entities" -> "entity". */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0)
    .map(stem);
}

/** Words that carry no tool meaning in an agent's phrasing. */
const STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'in',
  'on',
  'of',
  'to',
  'for',
  'and',
  'or',
  'with',
  'by',
  'at',
  'from',
  'out',
  'it',
  'is',
  'are',
  'be',
  'how',
  'do',
  'does',
  'can',
  'i',
  'me',
  'my',
  'we',
  'you',
  'this',
  'that',
  'what',
  'which',
  'want',
  'need',
  'make',
  'some',
  'all',
  'into',
  'many',
  'between',
  'two',
]);

/** Everyday phrasing -> the vocabulary tool names use. */
const SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  hole: ['subtract', 'cut'],
  drill: ['subtract', 'cut'],
  cut: ['subtract'],
  round: ['fillet'],
  bevel: ['chamfer'],
  hollow: ['shell'],
  heavy: ['mass'],
  weight: ['mass'],
  copy: ['duplicate', 'array'],
  clone: ['duplicate'],
  repeat: ['array'],
  remove: ['delete'],
  resize: ['scale'],
  spin: ['rotate'],
  turn: ['rotate'],
  merge: ['union'],
  join: ['union'],
  combine: ['union'],
  size: ['bounding', 'measure'],
  length: ['measure', 'distance'],
  area: ['measure'],
  save: ['export'],
  load: ['import'],
  picture: ['render'],
  image: ['render'],
  screenshot: ['render'],
};

/** Query tokens: stopwords and one-letter words dropped, synonyms appended (deduplicated). */
function queryTokens(query: string): string[] {
  const own = tokenize(query).filter((token) => token.length > 1 && !STOPWORDS.has(token));
  const expanded = own.flatMap((token) => [token, ...(SYNONYMS[token] ?? [])]);
  return [...new Set(expanded)];
}

/** True when `word` is `token` or extends it (prefix match needs ≥ 3 letters: "fill" -> "fillet"). */
function wordMatches(word: string, token: string): boolean {
  return word === token || (token.length >= 3 && word.startsWith(token));
}

/**
 * Keyword score: name word equals the token 10, name word starts with it 6, token inside the name
 * 3, toolset name 2, description word starts with it 1.
 */
function scoreTool(
  tool: McpToolDefinition,
  toolset: ToolsetName,
  tokens: readonly string[],
): number {
  const nameWords = tokenize(tool.name);
  const descriptionWords = tokenize(tool.description);
  let score = 0;
  for (const token of tokens) {
    if (nameWords.includes(token)) score += 10;
    else if (nameWords.some((word) => wordMatches(word, token))) score += 6;
    else if (token.length >= 3 && tool.name.includes(token)) score += 3;
    if (toolset === token) score += 2;
    if (descriptionWords.some((word) => wordMatches(word, token))) score += 1;
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
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];
  return buildAllMcpTools()
    .map((tool) => {
      const toolset = toolsetOf(tool.name) ?? 'core';
      return { tool, toolset, score: scoreTool(tool, toolset, tokens) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
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

/**
 * Tool names within a typo's edit distance of `name` (closest first, ties by name); empty when
 * nothing is close. For "Unknown command" hints; keyword search is the fallback.
 */
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
  const requestedLimit = isFiniteNumber(args.limit) ? args.limit : SEARCH_TOOLS_DEFAULT_LIMIT;
  const limit = Math.min(SEARCH_TOOLS_MAX_LIMIT, Math.max(1, Math.floor(requestedLimit)));
  const results = searchTools(query, limit, enabledToolsets);
  if (results.length === 0)
    return outcome(`search_tools: no tools match "${query}".`, false, { results });
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
  if (requested === 'all') {
    const added = TOOLSET_NAMES.filter((name) => !enabledToolsets.has(name));
    added.forEach((name) => enabledToolsets.add(name));
    const summary =
      added.length > 0
        ? `enable_toolset: enabled all toolsets (${added.join(', ')} added); re-list tools to load their schemas.`
        : 'enable_toolset: all toolsets were already enabled.';
    return outcome(
      summary,
      false,
      { toolset: 'all', changed: added.length > 0, enabled: [...enabledToolsets] },
      added.length > 0,
    );
  }
  const toolset = TOOLSET_NAMES.find((name) => name === requested);
  if (toolset === undefined) {
    const shown = requested === '' ? 'a "toolset" string argument' : `"${requested}"`;
    return outcome(
      `enable_toolset: unknown toolset ${shown}. Valid toolsets: ${TOOLSET_NAMES.join(', ')}, or "all".`,
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
  const args = isRecord(rawArgs) ? rawArgs : {};
  switch (toolName) {
    case 'search_tools':
      return runSearchTools(args, enabledToolsets);
    case 'enable_toolset':
      return runEnableToolset(args, enabledToolsets);
    default:
      return null;
  }
}
