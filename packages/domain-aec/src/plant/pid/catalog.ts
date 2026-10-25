import { commandCatalog } from '@core/commands/schema';

/** M1 registers no command (TECHNICAL_SPEC §10): M2 adds `import_dexpi` / `pid_report`, M3 the authoring commands. */
export const pidCatalog = commandCatalog();
