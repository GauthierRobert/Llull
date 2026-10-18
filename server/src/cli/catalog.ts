/** CLI discovery (list, search, describe, toolsets): projections of the registry + exchange tools, never a hand list (L5). */
import { getCommand, listCommands } from '@core/commands/registry';
import type { CommandDefinition, ParamsSchema } from '@core/commands/types';
import { similarNames } from '@lib/similarNames';
import { suggestCommandNames } from '@core/commands/project/unknownCommandHint';
import { paramsLines } from './describeSchema';
import type { McpToolDefinition } from '@mcp/tools';
import { exchangeTool, exchangeToolDefinitions } from './exchange';
import { TOOLSET_NAMES, searchTools, toolsetOf, type ToolsetName } from '@mcp/index';

const SHORT_DESCRIPTION_CHARS = 110;

/** First sentence, capped for one-line listings. */
export function shortDescription(description: string): string {
  const sentence = /^(.+?[.!?])(\s|$)/.exec(description)?.[1] ?? description;
  return sentence.length <= SHORT_DESCRIPTION_CHARS ? sentence : `${sentence.slice(0, SHORT_DESCRIPTION_CHARS - 1)}…`;
}

export interface CatalogEntry {
  readonly name: string;
  readonly toolset: ToolsetName;
  readonly description: string;
  readonly readOnly: boolean;
}

interface CatalogTool {
  readonly name: string;
  readonly description: string;
  readonly flags: readonly string[];
  readonly schema: ParamsSchema;
  readonly annotations: unknown;
}

function commandTool(def: CommandDefinition<unknown>): CatalogTool {
  const annotations = def.annotations ?? {};
  return {
    name: def.name,
    description: def.description,
    flags: Object.entries(annotations)
      .filter(([, on]) => on === true)
      .map(([flag]) => flag),
    schema: def.paramsSchema,
    annotations,
  };
}

function exchangeCatalogTool(tool: McpToolDefinition): CatalogTool {
  return {
    name: tool.name,
    description: tool.description,
    flags: ['exchange', ...Object.keys(tool.annotations ?? {})],
    schema: tool.inputSchema,
    annotations: tool.annotations ?? {},
  };
}

function toolNamed(name: string): CatalogTool | undefined {
  const def = getCommand(name);
  if (def !== undefined) return commandTool(def);
  const tool = exchangeTool(name);
  return tool === undefined ? undefined : exchangeCatalogTool(tool);
}

const entryOf = (tool: CatalogTool): CatalogEntry => ({
  name: tool.name,
  toolset: toolsetOf(tool.name) ?? 'core',
  description: shortDescription(tool.description),
  readOnly: tool.flags.includes('readOnly'),
});

/** Every callable tool (optionally one toolset), sorted by toolset order then name. */
export function listCatalog(toolset?: ToolsetName): CatalogEntry[] {
  const order = (name: ToolsetName): number => TOOLSET_NAMES.indexOf(name);
  return [...listCommands().map(commandTool), ...exchangeToolDefinitions().map(exchangeCatalogTool)]
    .map(entryOf)
    .filter((entry) => toolset === undefined || entry.toolset === toolset)
    .sort((a, b) => order(a.toolset) - order(b.toolset) || a.name.localeCompare(b.name));
}

/** Tools matching `query` (the MCP `search_tools` ranking, minus the MCP discovery tools). */
export function searchCatalog(query: string, limit: number): CatalogEntry[] {
  return searchTools(query, limit * 2, new Set<ToolsetName>(TOOLSET_NAMES))
    .map((hit) => toolNamed(hit.name))
    .filter((tool): tool is CatalogTool => tool !== undefined)
    .slice(0, limit)
    .map(entryOf);
}

/** Command counts per toolset (toolsets with no registry command are listed with 0). */
export function toolsetCounts(): { toolset: ToolsetName; commands: number }[] {
  const entries = listCatalog();
  return TOOLSET_NAMES.map((toolset) => ({ toolset, commands: entries.filter((entry) => entry.toolset === toolset).length }));
}

/** "Did you mean" names (max 3) for an unknown command: registry commands (retired names point at their replacement) + exchange tools. */
export function suggestNames(name: string): string[] {
  const exchange = exchangeToolDefinitions().map((tool) => tool.name);
  return [...new Set([...suggestCommandNames(name), ...similarNames(name, exchange, 3)])].slice(0, 3);
}

/** The full contract of one tool, as text (agents) or a JSON-ready record. */
export function describeCommand(name: string): { text: string; json: unknown } | null {
  const tool = toolNamed(name);
  if (tool === undefined) return null;
  const params = paramsLines(tool.schema);
  const toolset = toolsetOf(tool.name) ?? 'core';
  return {
    text: [
      `${tool.name} [${toolset}]${tool.flags.length > 0 ? ` (${tool.flags.join(', ')})` : ''}`,
      tool.description,
      '',
      params.length > 0 ? 'Params:' : 'Params: none',
      ...params,
    ].join('\n'),
    json: { name: tool.name, toolset, description: tool.description, annotations: tool.annotations, params: tool.schema },
  };
}
