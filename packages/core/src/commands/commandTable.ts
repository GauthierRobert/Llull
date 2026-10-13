/**
 * The command table: every registered (guarded) definition, looked up by name. It imports no command, so the engine (`execute`), the
 * context and commands that run other commands can all read it without an import cycle. `registry.ts` fills it with the core catalog and
 * plugins.
 * @invariant names are unique; registration order is preserved (core first, then plugins)
 * @invariant filled only by importing `registry.ts`; surfaces import the API from there
 */

import type { CommandDefinition } from './types';
import { guardCommand } from './guard';

const definitions: CommandDefinition<unknown>[] = [];
const byName = new Map<string, CommandDefinition<unknown>>();

/**
 * Register `commands` (each wrapped by `guardCommand`), all or nothing.
 * @failure a name already registered, or repeated within `commands` -> throws, nothing registered
 */
export function registerCommands(source: string, commands: ReadonlyArray<CommandDefinition<unknown>>): void {
  const names = commands.map((command) => command.name);
  const clash = commands.find((command, index) => byName.has(command.name) || names.indexOf(command.name) !== index);
  if (clash) throw new Error(`${source}: command '${clash.name}' is already registered`);
  for (const command of commands) {
    const guarded = guardCommand(command);
    definitions.push(guarded);
    byName.set(guarded.name, guarded);
  }
}

export function listCommands(): ReadonlyArray<CommandDefinition<unknown>> {
  return definitions;
}

export function getCommand(name: string): CommandDefinition<unknown> | undefined {
  return byName.get(name);
}

/** One registry entry as an AI/MCP tool schema. */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: CommandDefinition<unknown>['paramsSchema'];
  annotations?: { readOnlyHint?: true; destructiveHint?: true; idempotentHint?: true };
}

function toolAnnotations(def: CommandDefinition<unknown>): ToolSchema['annotations'] {
  const ann: NonNullable<ToolSchema['annotations']> = {};
  if (def.annotations?.readOnly === true) ann.readOnlyHint = true;
  if (def.annotations?.destructive === true) ann.destructiveHint = true;
  if (def.annotations?.idempotent === true) ann.idempotentHint = true;
  return Object.keys(ann).length > 0 ? ann : undefined;
}

/** Generate AI/MCP tool schemas from the registry. */
export function toToolSchemas(): ToolSchema[] {
  return definitions.map((d) => {
    const annotations = toolAnnotations(d);
    return { name: d.name, description: d.description, input_schema: d.paramsSchema, ...(annotations ? { annotations } : {}) };
  });
}
