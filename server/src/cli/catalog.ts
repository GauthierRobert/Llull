/**
 * The `llull` CLI's discovery views over the registry (+ the exchange tools): list, search,
 * describe, toolsets. Read-only projections of `listCommands()`, `buildExchangeToolDefinitions()`
 * and `@mcp/toolsets` — never a hand-written command list (L5).
 */

import { getCommand, listCommands } from '@core/commands/registry';
import type { CommandDefinition, ParamItemSpec, ParamsSchema } from '@core/commands/types';
import type { McpToolDefinition } from '@mcp/tools';
import { exchangeTool, exchangeToolDefinitions } from './exchange';
import { TOOLSET_NAMES, closestToolNames, searchTools, toolsetOf, type ToolsetName } from '@mcp/index';

const SHORT_DESCRIPTION_CHARS = 110;

/** The first sentence of a description, capped for one-line listings. */
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

/** A callable tool: a registry command, or an exchange tool (Python / DWG I/O, `./exchange`). */
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

function entryOf(tool: CatalogTool): CatalogEntry {
  return {
    name: tool.name,
    toolset: toolsetOf(tool.name) ?? 'core',
    description: shortDescription(tool.description),
    readOnly: tool.flags.includes('readOnly'),
  };
}

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
  const everyToolset = new Set<ToolsetName>(TOOLSET_NAMES);
  return searchTools(query, limit * 2, everyToolset)
    .map((hit) => toolNamed(hit.name))
    .filter((tool): tool is CatalogTool => tool !== undefined)
    .slice(0, limit)
    .map(entryOf);
}

/** Command counts per toolset (toolsets with no registry command are listed with 0). */
export function toolsetCounts(): { toolset: ToolsetName; commands: number }[] {
  const entries = listCatalog();
  return TOOLSET_NAMES.map((toolset) => ({
    toolset,
    commands: entries.filter((entry) => entry.toolset === toolset).length,
  }));
}

/** Typo hints for an unknown command name: registry commands only. */
export function suggestNames(name: string): string[] {
  return closestToolNames(name, 6).filter((candidate) => toolNamed(candidate) !== undefined);
}

function typeLabel(spec: ParamItemSpec): string {
  if (spec.enum !== undefined) return spec.enum.map((value) => JSON.stringify(value)).join('|');
  if (spec.type === 'array' && spec.items !== undefined) return `${typeLabel(spec.items)}[]`;
  return spec.type;
}

/** One line per parameter: `- name (type, required): description`, nested object keys indented. */
function paramLines(properties: Record<string, ParamItemSpec>, required: readonly string[], indent: string): string[] {
  return Object.entries(properties).flatMap(([key, spec]) => {
    const flag = required.includes(key) ? ', required' : '';
    const line = `${indent}- ${key} (${typeLabel(spec)}${flag})${spec.description !== undefined ? `: ${spec.description}` : ''}`;
    const nested = spec.properties ?? spec.items?.properties;
    const nestedRequired = spec.required ?? spec.items?.required ?? [];
    return nested === undefined ? [line] : [line, ...paramLines(nested, nestedRequired, `${indent}  `)];
  });
}

/** The full contract of one tool, as text (agents) or a JSON-ready record. */
export function describeCommand(name: string): { text: string; json: unknown } | null {
  const tool = toolNamed(name);
  if (tool === undefined) return null;
  const params = paramLines(tool.schema.properties, tool.schema.required, '');
  const toolset = toolsetOf(tool.name) ?? 'core';
  const text = [
    `${tool.name} [${toolset}]${tool.flags.length > 0 ? ` (${tool.flags.join(', ')})` : ''}`,
    tool.description,
    '',
    params.length > 0 ? 'Params:' : 'Params: none',
    ...params,
  ].join('\n');
  return {
    text,
    json: {
      name: tool.name,
      toolset,
      description: tool.description,
      annotations: tool.annotations,
      params: tool.schema,
    },
  };
}
