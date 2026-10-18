import { listCommands } from '../commandTable';
import { migrateRetiredCalls } from '../persistence/retiredCommands';
import { similarNames } from '../../lib/similarNames';
import { isRecord } from '../../lib/isRecord';

/** The command `name` was merged into (`draw_circle` -> `draw_arc`), or null when `name` was never retired. */
function retiredReplacement(name: string): string | null {
  const migrated = migrateRetiredCalls({ command: name, params: {} });
  const replacement = isRecord(migrated) ? migrated['command'] : undefined;
  return typeof replacement === 'string' && replacement !== name ? replacement : null;
}

/**
 * Up to 3 registry names to suggest for an unknown command `name`: the command it was merged into if it is a retired name, then the
 * closest by typo distance and shared words. @pure
 */
export function suggestCommandNames(name: string): string[] {
  const registered = new Set(listCommands().map((def) => def.name));
  const replacement = retiredReplacement(name);
  const merged = replacement !== null && registered.has(replacement) ? [replacement] : [];
  return [...new Set([...merged, ...similarNames(name, [...registered], 3)])].slice(0, 3);
}
