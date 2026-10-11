/**
 * Every command a module defines is reachable: listed in its feature catalog (core) or its
 * plugin's command list, hence registered. Catches a `defineCommand` export nobody registered.
 */
import { describe, it, expect } from 'vitest';
import { getCommand, listCommands } from '@core/commands/registry';
import { commandCatalog } from '@core/commands/schema';
import type { CommandDefinition } from '@core/commands/types';

const modules = import.meta.glob(
  ['/packages/core/src/commands/**/*.ts', '/packages/domain-aec/src/**/*.ts'],
  { eager: true },
);

function isCommandDefinition(value: unknown): value is CommandDefinition<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { name?: unknown }).name === 'string' &&
    typeof (value as { run?: unknown }).run === 'function' &&
    typeof (value as { paramsSchema?: unknown }).paramsSchema === 'object'
  );
}

describe('command catalogs', () => {
  it('registers every exported command definition', () => {
    expect(Object.keys(modules).length).toBeGreaterThan(300);
    const unregistered = Object.entries(modules).flatMap(([path, exports]) =>
      Object.values(exports as Record<string, unknown>)
        .filter(isCommandDefinition)
        .filter((definition) => getCommand(definition.name) === undefined)
        .map((definition) => `${definition.name} (${path})`),
    );
    expect(unregistered).toEqual([]);
  });

  it('registers each command name once', () => {
    const names = listCommands().map((definition) => definition.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('commandCatalog keeps the given commands in order', () => {
    const [first, second] = listCommands();
    expect(commandCatalog(first as never, second as never)).toEqual([first, second]);
  });
});
