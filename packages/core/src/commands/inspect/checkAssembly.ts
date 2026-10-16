/** check_assembly: read-only buildability gate of the parts (validity, overlaps, connectivity, wall thickness, joint realisation). */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { commandError, noop, rejection, report } from '../noop';
import { PROCESS_IDS } from '../../model/processRules';
import { MAX_RAYS_TOTAL, runAssemblyCheck } from './assemblyCheckRun';
import { scopedIds } from './assemblyParts';

/**
 * @affects nothing — read-only; returns the CheckResult envelope (+ parts, skipped2D, pairsChecked) in data
 * @invariant returns the SAME document, affected []; deterministic (same document, kernel and params give identical data, numbers rounded
 *   to 12 significant digits); 2D entities are skipped and counted
 * @failure no kernel -> rejected by execute; kernel without analyze / distance -> items not_run FPR_KERNEL_UNSUPPORTED (never a pass);
 *   over a budget (parts, pairs, rays) -> rejected with FPR_BUDGET_EXCEEDED; unknown scope id/body/component -> no-op
 */
export const checkAssembly = defineCommand({
  name: 'check_assembly',
  annotations: { readOnly: true, requiresKernel: true },
  description:
    'Buildability gate of the 3D parts (solids and component instances): is every part a valid closed single-lump solid, do parts overlap ' +
    '(FPR_PAIR_HARD with overlap volume mm3, FPR_PAIR_CONTAINED), touch (info) or sit closer than the required clearance, is every part ' +
    'attached to something grounded (FPR_PART_FLOATING, FPR_PART_RESTING_ONLY), are walls thick enough for a manufacturing process ' +
    '(FPR_WALL_THIN), and is each revolute dynamics joint physically realised by a pin in a bore (OCC only; clearance and engagement in mm). ' +
    'Read-only. Every item has a stable FPR_ code, ids, values with unit suffixes (mm, mm2, mm3), a threshold with its source and a ' +
    'remediation. status is the worst item (fail > not_run > warn > pass); not_run means the installed kernel cannot verify it, never a ' +
    'pass. Scope: no selector = all parts; ids = only those entities/instances; body = the entities of a rigid body (pairs inside it are ' +
    'then checked too); component = every instance of that component. Next: fix fails; declare intended overlaps (press fit, thread, ' +
    'weld) with allow_interference; mark world-fixed parts with set_part_grounded; then simulate_motion. Computed by llull, not ' +
    'approved: a qualified engineer must review.',
  params: z.object({
    ids: z
      .array(z.string())
      .min(1)
      .optional()
      .describe('Check only these entity / instance ids. Mutually exclusive with body and component.'),
    body: z.string().optional().describe('Rigid body id (dynamics): check its entities, including pairs inside the body.'),
    component: z.string().optional().describe('Component id: check every instance of it.'),
    clearanceMm: z
      .number()
      .min(0)
      .optional()
      .describe('Required clearance between parts in millimetres; closer pairs give FPR_PAIR_CLEARANCE. Default 0 (no clearance check).'),
    touchToleranceMm: z
      .number()
      .positive()
      .optional()
      .describe('Distance in millimetres at or below which parts count as touching. Default 0.001 document units.'),
    process: z
      .enum(PROCESS_IDS)
      .optional()
      .describe('Manufacturing process whose sourced minimum wall (vendor guidance, grade B) is the wall threshold.'),
    minWallMm: z.number().positive().optional().describe('Minimum wall thickness in millimetres; overrides process.'),
    thickness: z
      .enum(['off', 'ray'])
      .optional()
      .describe('"ray" measures wall thickness by inward rays (default when process or minWallMm is given), "off" skips it.'),
    raysPerPart: z
      .number()
      .int()
      .min(1)
      .max(20000)
      .optional()
      .describe(`Thickness samples per part. Default 2000; parts × samples must stay under ${MAX_RAYS_TOTAL}.`),
    includeJoints: z
      .boolean()
      .optional()
      .describe('Also check that each revolute dynamics joint has a coaxial pin and bore. Default true.'),
  }),
  run: (doc, params, ctx): CommandResult => {
    const kernel = ctx?.kernel ?? null;
    if (kernel === null) return noop(doc, 'check_assembly: no geometry kernel is installed; no-op.');
    const selectors = [params.ids, params.body, params.component].filter((value) => value !== undefined).length;
    if (selectors > 1) return noop(doc, 'check_assembly: give at most one of ids, body, component; no-op.');
    const selected = scopedIds(doc, params);
    if (selected !== null && selected.size === 0) return noop(doc, 'check_assembly: the selected body or component has no parts; no-op.');
    const missing = [...(selected ?? [])].filter((id) => doc.entities[id] === undefined);
    if (missing.length > 0) return noop(doc, `check_assembly: unknown id(s) ${missing.join(', ')}; no-op.`);
    const outcome = runAssemblyCheck(doc, kernel, params);
    if (outcome.refused)
      return rejection(
        doc,
        `check_assembly refused: ${outcome.limit}. ${outcome.remediation}`,
        commandError('FPR_BUDGET_EXCEEDED', outcome.remediation, [], []),
      );
    const { result, extras } = outcome;
    const count = (status: string): number => result.items.filter((item) => item.status === status).length;
    const summary =
      `check_assembly: ${result.status} — ${extras['parts'] instanceof Array ? extras['parts'].length : 0} parts, ` +
      `${count('fail')} fail, ${count('warn')} warn, ${count('not_run')} not_run, ${count('info')} info, ${count('pass')} pass` +
      ` (hash ${result.inputsHash}). ` +
      (result.status === 'fail'
        ? 'Next: fix the failing items (each has a remediation), or allow_interference / set_part_grounded where intended.'
        : 'Next: simulate_motion.') +
      ' Computed by llull, not approved — needs a qualified engineer.';
    return report(doc, summary, { ...result, ...extras });
  },
});
