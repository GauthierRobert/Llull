/** add_external_thread (SC-F2): modelled ISO metric external thread M3-M20 on a cylinder (bolt / stud / threaded shaft end). */

import { round6 } from '../../lib/compactNumber';
import type { ShapeRecipe } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { kernelUnavailable } from '../kernelRefusal';
import { commitKernelResult, evaluateRecipe } from '../kernelShape';
import { operandRecipe } from '../../geometry/operandRecipe';
import { newEntity } from '../entity/newEntity';
import { noop } from '../noop';
import { fromMm } from '../../model/units';
import { externalThreadForm, externalThreadRemovedVolume, isoBasicDiameters, parseIsoMetric } from '../../lib/threadForm';
import { MAX_THREAD_TURNS, externalThreadGroove } from '../../geometry/threadTool';
import { refuse } from './ftr';

/** The cylinder radius must equal the thread major radius within this fraction of the major diameter. */
const DIAMETER_TOLERANCE = 1e-3;

/**
 * @affects replaces the cylinder `target` by 1 mesh entity: the cylinder with a helical groove (exact B-rep recipe: boolean subtract of the thread tool)
 * @invariant cylinder diameter = thread major diameter; the groove has the ISO 68-1 basic external profile (root flat P/4 at d1 = d - 1.082532 P,
 *   crest flat P/8 at d); removed volume over a length L = groove area x 2 pi r_centroid x L / P (data.analyticRemovedVolume)
 * @failure missing / non-cylinder target, designation not ISO metric M3-M20, cylinder diameter differs from the major diameter, length < 1 pitch or
 *   beyond the cylinder, too many turns, no kernel, kernel refusal -> rejected no-op with an FTR_* code
 */
export const addExternalThread = defineCommand({
  name: 'add_external_thread',
  annotations: { requiresKernel: true },
  description:
    'Cut a modelled ISO metric EXTERNAL thread (M3-M20) into a cylinder: a real helical groove of the ISO 68-1 basic profile (H = 0.866025 P, ' +
    'pitch diameter d2 = d - 0.649519 P, groove bottom at the minor diameter d1 = d - 1.082532 P). target must be a cylinder entity (add_cylinder) ' +
    'whose DIAMETER equals the thread major diameter (within 0.1%). size is "M8" (ISO 261 coarse pitch: M3 0.5, M4 0.7, M5 0.8, M6 1, M8 1.25, ' +
    'M10 1.5, M12 1.75, M14 2, M16 2, M18 2.5, M20 2.5) or "M8x1" (explicit/fine pitch); sizes are in mm in the designation, the cylinder in ' +
    'the document unit. The thread covers `length` from the chosen end of the cylinder (end "top" = the +Z end of the cylinder in its own frame, ' +
    '"bottom" = the other); omit length for the whole cylinder. The groove runs out through that end face. Consumes target, creates one mesh ' +
    'entity. data = { designation, pitch, majorDiameter, pitchDiameter, minorDiameter, threadLength, analyticRemovedVolume } in document units. ' +
    'Refusal codes: FTR_PART_NOT_FOUND, FTR_THREAD_DESIGNATION_INVALID, FTR_HOLE_DIAMETERS_INCONSISTENT, FTR_NEEDS_EXACT_KERNEL, FTR_FEATURE_BUILD_FAILED.',
  params: z.object({
    target: z.string().describe('Id of the cylinder entity (kind "cylinder") to thread.'),
    size: z.string().describe('ISO metric size: "M8" (coarse pitch) or "M8x1" (explicit pitch). M3-M20 only.'),
    length: z
      .number()
      .positive()
      .optional()
      .describe(
        'Threaded length measured from the chosen end, in document length units (>= one pitch, <= cylinder height). Omit for the full height.',
      ),
    end: z
      .enum(['top', 'bottom'])
      .optional()
      .describe('Which end of the cylinder carries the thread: "top" (local +Z, default) or "bottom".'),
    handedness: z.enum(['right', 'left']).optional().describe('"right" (default) or "left" thread.'),
  }),
  run: (doc, { target, size, length, end = 'top', handedness = 'right' }, ctx): CommandResult => {
    const fail = (code: Parameters<typeof refuse>[2], why: string, remediation: string, paths: readonly string[]): CommandResult =>
      refuse(doc, 'add_external_thread', code, why, remediation, [target], paths);
    const cylinder = doc.entities[target];
    if (cylinder === undefined)
      return fail('FTR_PART_NOT_FOUND', `entity '${target}' not found`, 'pass the id of a cylinder entity', ['target']);
    if (cylinder.kind !== 'cylinder')
      return fail(
        'FTR_PART_NOT_FOUND',
        `entity '${target}' is a ${cylinder.kind}, not a cylinder`,
        'create the threaded part with add_cylinder (diameter = thread major diameter)',
        ['target'],
      );
    const iso = parseIsoMetric(size);
    if (typeof iso === 'string') return fail('FTR_THREAD_DESIGNATION_INVALID', iso, 'use M3..M20, e.g. M8 or M8x1', ['size']);
    const [major, pitch] = [fromMm(doc, iso.majorDiameterMm), fromMm(doc, iso.pitchMm)];
    if (Math.abs(2 * cylinder.radius - major) > DIAMETER_TOLERANCE * major)
      return fail(
        'FTR_HOLE_DIAMETERS_INCONSISTENT',
        `cylinder Ø${round6(2 * cylinder.radius)} does not match ${iso.designation} major Ø${round6(major)}`,
        `recreate the cylinder with diameter ${round6(major)}`,
        ['target'],
      );
    const threadLength = length ?? cylinder.height;
    if (threadLength > cylinder.height * (1 + 1e-9))
      return fail(
        'FTR_FEATURE_BUILD_FAILED',
        `thread length ${threadLength} exceeds the cylinder height ${cylinder.height}`,
        'shorten the thread',
        ['length'],
      );
    const form = externalThreadForm(pitch, major);
    const half = cylinder.height / 2;
    const groove = externalThreadGroove(form, threadLength, end === 'top' ? half : -half, end === 'top' ? 1 : -1, handedness === 'left');
    if (groove === null)
      return fail(
        'FTR_FEATURE_BUILD_FAILED',
        `thread length ${threadLength} is shorter than one pitch (${round6(pitch)}) or needs more than ${MAX_THREAD_TURNS} turns`,
        'use a length between one pitch and the turn limit',
        ['length'],
      );
    const kernel = (ctx ?? currentContext()).kernel;
    if (!kernel) return noop(doc, kernelUnavailable('add_external_thread'));
    const tool = newEntity('mesh', 'thread-tool', { mesh: groove, threadTool: true }, [...cylinder.position], '#888888', {
      rotation: cylinder.rotation,
    });
    const recipe: ShapeRecipe = {
      op: 'boolean',
      boolean: 'subtract',
      a: operandRecipe(kernel, cylinder),
      b: { op: 'solid', entity: tool },
    };
    const result = evaluateRecipe(kernel, recipe);
    if (result === 'refused' || result === 'empty')
      return fail(
        'FTR_FEATURE_BUILD_FAILED',
        `the kernel could not cut the thread (${result})`,
        'check the cylinder and the thread length',
        [],
      );
    const basic = isoBasicDiameters(major, pitch);
    const analytic = externalThreadRemovedVolume(form, threadLength);
    const data = {
      designation: iso.designation,
      pitch,
      majorDiameter: major,
      pitchDiameter: basic.pitchDiameter,
      minorDiameter: basic.minorDiameter,
      threadLength,
      analyticRemovedVolume: analytic,
    };
    const committed = commitKernelResult(
      doc,
      kernel,
      result,
      [cylinder],
      (newId, triangles) =>
        `add_external_thread: ${iso.designation}${iso.coarse ? ' (coarse)' : ''} ${handedness}-hand thread, length ${round6(threadLength)} at the ${end} end of '${target}' ` +
        `(d1 Ø${round6(basic.minorDiameter)}, d2 Ø${round6(basic.pitchDiameter)}) → mesh '${newId}' (${triangles} triangles). Target consumed.`,
    );
    return { ...committed, data };
  },
});
