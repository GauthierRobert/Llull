/**
 * Registry schema guard.
 *
 * Asserts that toToolSchemas() and listCommands() are 1:1 — same names, same count.
 * Exits 0 on success, 1 on mismatch.
 *
 * Run with: npx tsx scripts/check-registry-schema.ts
 *
 * @layer scripts (CI utility, not part of core/ui)
 * @invariant toToolSchemas().map(t=>t.name).sort() === listCommands().map(d=>d.name).sort()
 */

import { listCommands, toToolSchemas } from '../src/core/commands/registry.ts';

const commandNames = listCommands()
  .map((d) => d.name)
  .sort();
const schemaNames = toToolSchemas()
  .map((t) => t.name)
  .sort();

let failed = false;

if (commandNames.length !== schemaNames.length) {
  console.error(
    `[check-registry-schema] FAIL: listCommands() has ${commandNames.length} entries ` +
      `but toToolSchemas() has ${schemaNames.length} entries.`,
  );
  failed = true;
}

const inCommandsNotSchemas = commandNames.filter((n) => !schemaNames.includes(n));
const inSchemasNotCommands = schemaNames.filter((n) => !commandNames.includes(n));

if (inCommandsNotSchemas.length > 0) {
  console.error(
    `[check-registry-schema] FAIL: in listCommands() but NOT in toToolSchemas(): ${inCommandsNotSchemas.join(', ')}`,
  );
  failed = true;
}

if (inSchemasNotCommands.length > 0) {
  console.error(
    `[check-registry-schema] FAIL: in toToolSchemas() but NOT in listCommands(): ${inSchemasNotCommands.join(', ')}`,
  );
  failed = true;
}

if (failed) {
  process.exit(1);
}

process.stdout.write(
  `[check-registry-schema] OK: ${commandNames.length} commands and tool schemas are in sync.\n`,
);
