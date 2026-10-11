/**
 * @layer server
 * The `llull` CLI's discovery views over the registry: list, search, describe, toolsets. Read-only
 * projections of `listCommands()` and `@mcp/toolsets` — never a hand-written command list (L5).
 */

import { getCommand, listCommands } from '@core/commands/registry';
import type { CommandDefinition, ParamItemSpec } from '@core/commands/types';
import {
  TOOLSET_NAMES,
  closestToolNames,
  searchTools,
  toolsetOf,
  type ToolsetName,
} from '@mcp/index';

const SHORT_DESCRIPTION_CHARS = 110;

/** The first sentence of a description, capped for one-line listings. */
export function shortDescription(description: string): string {
  const sentence = /^(.+?[.!?])(\s|$)/.exec(description)?.[1] ?? description;
  return sentence.length <= SHORT_DESCRIPTION_CHARS
    ? sentence
    : `${sentence.slice(0, SHORT_DESCRIPTION_CHARS - 1)}…`;
}

export interface CatalogEntry {
  readonly name: string;
  readonly toolset: ToolsetName;
  readonly description: string;
  readonly readOnly: boolean;
}

function entryOf(def: CommandDefinition<unknown>, full: boolean): CatalogEntry {
  return {
    name: def.name,
    toolset: toolsetOf(def.name) ?? 'core',
    description: full ? def.description : shortDescription(def.description),
    readOnly: def.annotations?.readOnly === true,
  };
}

export function isToolsetName(value: string): value is ToolsetName {
  return (TOOLSET_NAMES as readonly string[]).includes(value);
}

/** Every registry command (optionally one toolset), sorted by toolset order then name. */
export function listCatalog(toolset?: ToolsetName): CatalogEntry[] {
  const order = (name: ToolsetName): number => TOOLSET_NAMES.indexOf(name);
  return listCommands()
    .map((def) => entryOf(def, false))
    .filter((entry) => toolset === undefined || entry.toolset === toolset)
    .sort((a, b) => order(a.toolset) - order(b.toolset) || a.name.localeCompare(b.name));
}

/** Registry commands matching `query` (the MCP `search_tools` ranking, minus MCP-only tools). */
export function searchCatalog(query: string, limit: number): CatalogEntry[] {
  const everyToolset = new Set<ToolsetName>(TOOLSET_NAMES);
  return searchTools(query, limit * 2, everyToolset)
    .map((hit) => getCommand(hit.name))
    .filter((def): def is CommandDefinition<unknown> => def !== undefined)
    .slice(0, limit)
    .map((def) => entryOf(def, false));
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
  return closestToolNames(name, 6).filter((candidate) => getCommand(candidate) !== undefined);
}

function typeLabel(spec: ParamItemSpec): string {
  if (spec.enum !== undefined) return spec.enum.map((value) => JSON.stringify(value)).join('|');
  if (spec.type === 'array' && spec.items !== undefined) return `${typeLabel(spec.items)}[]`;
  return spec.type;
}

/** One line per parameter: `- name (type, required): description`, nested object keys indented. */
function paramLines(
  properties: Record<string, ParamItemSpec>,
  required: readonly string[],
  indent: string,
): string[] {
  return Object.entries(properties).flatMap(([key, spec]) => {
    const flag = required.includes(key) ? ', required' : '';
    const line = `${indent}- ${key} (${typeLabel(spec)}${flag})${spec.description !== undefined ? `: ${spec.description}` : ''}`;
    const nested = spec.properties ?? spec.items?.properties;
    const nestedRequired = spec.required ?? spec.items?.required ?? [];
    return nested === undefined
      ? [line]
      : [line, ...paramLines(nested, nestedRequired, `${indent}  `)];
  });
}

/** The full contract of one command, as text (agents) or a JSON-ready record. */
export function describeCommand(name: string): { text: string; json: unknown } | null {
  const def = getCommand(name);
  if (def === undefined) return null;
  const annotations = def.annotations ?? {};
  const flags = Object.entries(annotations)
    .filter(([, on]) => on === true)
    .map(([flag]) => flag);
  const schema = def.paramsSchema;
  const params = paramLines(schema.properties, schema.required, '');
  const text = [
    `${def.name} [${toolsetOf(def.name) ?? 'core'}]${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`,
    def.description,
    '',
    params.length > 0 ? 'Params:' : 'Params: none',
    ...params,
  ].join('\n');
  return {
    text,
    json: {
      name: def.name,
      toolset: toolsetOf(def.name) ?? 'core',
      description: def.description,
      annotations,
      params: schema,
    },
  };
}
