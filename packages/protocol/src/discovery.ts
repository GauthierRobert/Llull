/**
 * Tool discovery for the `llull` CLI (`llull search`): the full tool catalog (registry commands + exchange, FE and
 * library tools) and a keyword search over it.
 */
import { buildCommandTools, type ToolDefinition } from './tools';
import { buildExchangeToolDefinitions } from './exchangeTools';
import { buildFeaToolDefinitions } from './feaTools';
import { buildLibraryToolDefinitions } from './libraryTools';
import { buildNativeToolDefinitions } from './nativeTools';
import { parseQuery, scoreTool, toolIndex } from './discoveryRank';
import { toolsetOf, type ToolsetName } from './toolsets';

interface ToolSearchResult {
  readonly name: string;
  readonly toolset: ToolsetName;
  readonly description: string;
}

/** Hits scoring below this fraction of the best hit are noise and dropped. */
const MIN_RELATIVE_SCORE = 0.12;

/** Every tool the CLI can run: registry commands + exchange + FE + material-library + native-transport tools. */
export function buildAllTools(): ToolDefinition[] {
  return [
    ...buildCommandTools(),
    ...buildExchangeToolDefinitions(),
    ...buildFeaToolDefinitions(),
    ...buildLibraryToolDefinitions(),
    ...buildNativeToolDefinitions(),
  ];
}

/**
 * Rank every tool against `query`.
 * @invariant results sorted by score desc then name; zero-score tools and noise (< MIN_RELATIVE_SCORE of the best) are dropped
 */
export function searchTools(query: string, limit: number): ToolSearchResult[] {
  const parsed = parseQuery(query);
  if (parsed.terms.length === 0) return [];
  const all = buildAllTools();
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
    .map(({ tool, toolset }) => ({ name: tool.name, toolset, description: tool.description }));
}
