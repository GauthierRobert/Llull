/**
 * Regeneration hygiene. Replay rebuilds a fresh document but keeps the materials and components no history step creates BY NAME, and the
 * joints / constraints / drive relations no step lists in `affected` (core history/carry.ts). The design step creates them through nested
 * commands, so without this its own records from the previous run would come back and clash with the re-run (`component already exists`).
 */

import type { CadDocument } from '@core/model/types';
import type { ExecutionContext } from '@core/commands/types';
import { stepIdSource } from '@lib/id';
import { attempt, DesignError } from './errors';
import type { Statement } from './parse';
import { runDesign } from './run';

const LISTED_TABLES = ['joints', 'constraints', 'driveRelations'] as const;

/** Whether a line may create materials or components (command names that mention them): only then is the clean pass worth its cost. */
function touchesMaterialsOrComponents(statements: readonly Statement[]): boolean {
  return statements.some((s) =>
    s.kind === 'command' ? /material|component/.test(s.command) : s.kind === 'for' ? touchesMaterialsOrComponents(s.body) : false,
  );
}

/** Keys `after` added to the joint / constraint / drive-relation tables: listed in `affected`, replay regenerates them instead of carrying them. */
export function addedRecordKeys(before: CadDocument, after: CadDocument): string[] {
  return LISTED_TABLES.flatMap((table) => Object.keys(after[table]).filter((key) => before[table][key] === undefined));
}

/**
 * The input of a regeneration: `doc` without the materials and components a clean run of the design creates (they are the previous run's,
 * carried by replay). The clean run mints ids from its own source, so the real run keeps the step's ids. A design that needs materials or
 * components from outside itself cannot run clean: `doc` is kept as is.
 */
export function withoutOwnRecords(doc: CadDocument, statements: readonly Statement[], ctx: ExecutionContext, stepKey: string): CadDocument {
  if (Object.keys(doc.materials).length === 0 && Object.keys(doc.components).length === 0) return doc;
  if (!touchesMaterialsOrComponents(statements)) return doc;
  const clean = attempt(() => runDesign({ ...doc, materials: {}, components: {} }, statements, { ...ctx, ids: stepIdSource(stepKey) }));
  if (clean instanceof DesignError) return doc;
  const own = clean.document;
  return {
    ...doc,
    materials: Object.fromEntries(Object.entries(doc.materials).filter(([key]) => own.materials[key] === undefined)),
    components: Object.fromEntries(Object.entries(doc.components).filter(([key]) => own.components[key] === undefined)),
  };
}
