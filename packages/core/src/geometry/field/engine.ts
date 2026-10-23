/**
 * Field-engine port (05 IMP TR-IMP-02, RS1 rule 1): commands pass a FieldProgram and a grid, an installed engine answers. The always-present
 * TS engine (tsEngine.ts) is the default and the oracle; a host may install a faster one (native llull-field) with setFieldEngine.
 * Commands read it from ctx.fieldEngine and resolve it with resolveFieldEngine. Synchronous, no native imports.
 * @invariant a refusal carries a stable IMP_* code; an engine never throws for a bad program or grid
 * @invariant a conforming engine reproduces the TS engine's values to 1e-12 relative (same tape, f64)
 */

import type { FieldEngine } from './engineTypes';
import { tsFieldEngine } from './tsEngine';

let installed: FieldEngine | null = null;

/** Install (or clear with null) the host's field engine. */
export function setFieldEngine(engine: FieldEngine | null): void {
  installed = engine;
}

export function getFieldEngine(): FieldEngine | null {
  return installed;
}

/** The engine a command uses: the one on the context, else the TS engine. */
export function resolveFieldEngine(engine: FieldEngine | null | undefined): FieldEngine {
  return engine ?? tsFieldEngine;
}
