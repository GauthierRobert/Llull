/** set_mesh_storage: whether saved files keep the triangles of kernel results or rebuild them on load (roadmap v0.5 constructive vs evaluated). */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { changed, noop } from '../noop';
import { currentContext } from '../context';
import { kernelStampOf } from '../persistence/kernelStamp';
import { omittableMeshCount } from '../persistence/derivedMeshes';
import { modelingToleranceOf } from '../../model/kernelSettings';
import type { DocumentKernelSettings } from '../../model/types';

/**
 * @affects sets `kernelSettings.meshStorage`; a document without `kernelSettings` gets one naming the active kernel ('manifold' when none is installed)
 * @invariant like set_modeling_tolerance, a fresh slice stamps the ctx kernel as provenance: a replay under another kernel stamps that one (no geometry changes)
 * @invariant 'recipe' only changes what a SAVE writes (kernel-result `mesh` entities with a `brep` and no `asset` / `meshSource` are written empty and
 *   rebuilt on load); entities in the document keep their triangles
 * @failure mode not 'full' / 'recipe' -> rejected by the schema (no-op); already in that mode -> no-op, affected:[]
 */
export const setMeshStorage = defineCommand({
  name: 'set_mesh_storage',
  description:
    'Choose how saved files store kernel results (boolean / fillet / chamfer meshes that carry an exact recipe). "full" (default) writes their triangles. ' +
    '"recipe" omits them: the file keeps only the recipe and the triangles are rebuilt on open, so the file is much smaller but opening it needs a ' +
    'geometry kernel that can rebuild every recipe (an exact-only recipe, e.g. a fillet, needs the native kernel: LLULL_KERNEL=occt-native). ' +
    'Imported meshes and meshes with a mesh asset or pinned source are always stored.',
  annotations: { idempotent: true },
  params: z.object({
    mode: z
      .enum(['full', 'recipe'])
      .describe('"full" keeps kernel-result triangles in saved files (default); "recipe" omits them and rebuilds on open.'),
  }),
  run: (doc, { mode }, ctx): CommandResult => {
    if ((doc.kernelSettings?.meshStorage ?? 'full') === mode)
      return noop(doc, `set_mesh_storage: mesh storage is already '${mode}'; no-op.`);
    const kernel = doc.kernelSettings?.kernel ?? kernelStampOf((ctx ?? currentContext()).kernel)?.kernel ?? 'manifold';
    const kernelSettings: DocumentKernelSettings = {
      ...doc.kernelSettings,
      kernel,
      modelingTolerance: modelingToleranceOf(doc),
      meshStorage: mode,
    };
    const count = omittableMeshCount(doc);
    const detail =
      mode === 'recipe'
        ? `saved files will omit the triangles of ${count} kernel-result mesh${count === 1 ? '' : 'es'} and rebuild them on open (needs a kernel).`
        : 'saved files keep every kernel-result mesh.';
    return changed({ ...doc, kernelSettings }, `set_mesh_storage: mesh storage '${mode}': ${detail}`, []);
  },
});
