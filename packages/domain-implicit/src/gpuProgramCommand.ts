/** implicit_gpu_program: the field of an implicit body compiled to GLSL for the viewport's ray-marched preview (05 IMP 14.x), or the names of what blocks it. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { compileFieldToGlsl } from '@core/geometry/field/glsl';
import { refuseImplicit } from './codes';
import { compileField } from './compile';
import { resolveTarget } from './measure';

/**
 * @affects none (read-only); data = id, field, gpu (bool), glsl { source, constants, key, instructionCount, lipschitz, quality, bounds } or unsupported[]
 * @invariant the GLSL is the tape of `compileField` (the one the meshers sample), so the preview shows the field the exact contouring will mesh; same structure => same `key`, only `constants` change
 * @invariant not a document change and no kernel: the host renders; ops without a GPU path (mesh_sdf, strut_set, sample_field), unbounded fields and tapes over 4000 instructions answer `gpu: false` with their names
 * @failure unknown id -> IMP_FIELD_NOT_FOUND; a field the compiler refuses -> its code
 */
export const implicitGpuProgram = defineCommand({
  name: 'implicit_gpu_program',
  description:
    'Compile the field of an implicit body (id from create_implicit_body) or of a field node to GLSL for a GPU ray-marched preview in the viewport, before or without meshing: data.gpu true with data.glsl ' +
    '{ source (helper functions, `uniform vec4 uC[n]`, `float fieldAt(x, y, z)`), constants (the uniform contents; a parameter drag that keeps the structure changes only these), key (equal key = same shader), lipschitz ' +
    '(step = f / lipschitz is safe), quality, bounds (the support box), instructionCount }, or data.gpu false with data.unsupported naming what has no GPU path (strut_set, mesh_sdf, sample_field, unbounded, tape_too_long): ' +
    'those fields keep the mesh preview. Read-only; document units.',
  annotations: { readsMeshTriangles: true, readOnly: true },
  params: z.object({ id: z.string().describe('Id of an implicit body or of a field node.') }),
  run: (doc, { id }): CommandResult => {
    const target = resolveTarget(doc, id);
    if (target === undefined)
      return refuseImplicit(doc, 'implicit_gpu_program', 'IMP_FIELD_NOT_FOUND', `no implicit body or field '${id}'`, [id], ['params.id']);
    const compiled = compileField(doc, target.fieldId);
    if (!compiled.ok) return refuseImplicit(doc, 'implicit_gpu_program', compiled.code, compiled.message, compiled.ids);
    const bounds = target.body?.bounds ?? compiled.program.bounds;
    const glsl = compileFieldToGlsl({ ...compiled.program, bounds });
    if (!glsl.ok)
      return report(doc, `implicit_gpu_program: '${id}' has no GPU path (${glsl.unsupported.join(', ')}); the mesh preview stays.`, {
        id,
        field: target.fieldId,
        gpu: false,
        unsupported: glsl.unsupported,
      });
    const { ok: _ok, ...program } = glsl;
    return report(
      doc,
      `implicit_gpu_program: '${id}' compiled to GLSL (${glsl.instructionCount} instructions, ${glsl.constants.length} constants, quality ${glsl.quality}, lipschitz ${glsl.lipschitz}, key ${glsl.key}).`,
      {
        id,
        field: target.fieldId,
        gpu: true,
        glsl: { ...program, minFeature: Number.isFinite(compiled.minFeature) ? compiled.minFeature : null },
        unit: doc.units,
      },
    );
  },
});
