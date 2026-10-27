/**
 * The mesh a native-capable command hands the engine: loaded (welded, world space), measured and, for a closed-surface op, wound outward. The host runs
 * such a command again after each native job (TECHNICAL_SPEC 13.8), so the work is kept in the resolve memo (13.9) keyed by the entity object: the second
 * run gets the same `MeshData` objects back, which is also what lets the engine reuse its packed job files.
 * @invariant a pure function of (entity, weld tolerance, asset store); an entity or document that changed is a different object, hence a miss
 */

import type { CadDocument, MeshData } from '../../model/types';
import type { ExecutionContext } from '../types';
import { type LoadFailure, type SolidMesh, contextOf, isLoadFailure, loadSolidMesh, measureMesh, outwardMesh } from './meshCommon';

export interface PreparedMesh {
  readonly loaded: SolidMesh;
  readonly before: ReturnType<typeof measureMesh>;
  /** The engine input: `loaded.mesh`, wound outward when asked for and the mesh is closed. */
  readonly input: MeshData;
}

/** Load, measure and (with `outward`) orient entity `id`; a refusal as the `LoadFailure` of `loadSolidMesh`. */
export function prepareSolidMesh(
  doc: CadDocument,
  ctx: ExecutionContext | undefined,
  id: string,
  options: { readonly weldTolerance?: number; readonly outward: boolean },
): PreparedMesh | LoadFailure {
  const context = contextOf(ctx);
  const compute = (): PreparedMesh | LoadFailure => {
    const loaded = loadSolidMesh(doc, id, options.weldTolerance, context.meshAssets);
    if (isLoadFailure(loaded)) return loaded;
    const before = measureMesh(loaded.mesh);
    return { loaded, before, input: options.outward && before.closed ? outwardMesh(loaded.mesh) : loaded.mesh };
  };
  const entity = doc.entities[id];
  if (context.resolveMemo === null || context.resolveMemo === undefined || entity === undefined) return compute();
  const tag = `prepared|${options.weldTolerance ?? 'default'}|${options.outward}`;
  return context.resolveMemo.once(entity, tag, compute, (value) =>
    'code' in value
      ? 1
      : value.loaded.mesh.positions.length +
        value.loaded.mesh.indices.length +
        (value.input === value.loaded.mesh ? 0 : value.input.indices.length),
  );
}
