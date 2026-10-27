/** Runs one registered command's `run`: the step every caller of a command (execute, history replay) goes through. */

import type { CadDocument } from '../model/types';
import type { CommandDefinition, CommandResult, ExecutionContext } from './types';
import { runInContext } from './context';
import { runWithFullMeshes } from './meshAssetView';

/**
 * `def.run`, on full-resolution asset meshes when the command reads triangles (`annotations.readsMeshTriangles`). The run is marked `nested` in
 * the context it hands the command (also as the active context), so a command it executes in turn sees `ctx.nested`.
 * @invariant a read-only query degrades to the display mesh with a named warning (TECHNICAL_SPEC 13.11.7) only at the outermost call: a nested
 *   query feeds another command's result (an archive, an anchor), so it refuses MESH_ASSET_LOD_ONLY like a command that writes
 */
export function runCommand(def: CommandDefinition<unknown>, doc: CadDocument, params: unknown, ctx: ExecutionContext): CommandResult {
  const inner: ExecutionContext = ctx.nested === true ? ctx : { ...ctx, nested: true };
  const run = (): CommandResult => {
    const reads = def.annotations?.readsMeshTriangles;
    if (reads === undefined || reads === false) return def.run(doc, params, inner);
    if (def.annotations?.readsMeshTrianglesWhen?.(doc, params) === false) return def.run(doc, params, inner);
    const whole = reads === 'document' || def.annotations?.wholeDocumentWhen?.(doc, params) === true;
    // A top-level query degrades (named warning) when an asset is unreadable; whatever writes a result (a mutating command, an export) refuses.
    const degradable = def.annotations?.readOnly === true && def.annotations.writesArtifact !== true && ctx.nested !== true;
    return runWithFullMeshes(doc, def.name, params, inner, whole, degradable, (view) => def.run(view, params, inner));
  };
  return inner === ctx ? run() : runInContext(inner, run);
}
