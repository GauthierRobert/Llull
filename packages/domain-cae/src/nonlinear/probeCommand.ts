/** add_curve_probe: a load-displacement curve recorded at every stored increment. */

import type { AnalysisCase, CurveProbe } from '@core/model/analysis';
import { defineCommand, vec3, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analysisIdSchema } from '../shared/schemas';
import { refuseNls } from './codes';
import { isRefusal, nonlinearCase, nonlinearOf, withNonlinear } from './settings';

/** The id of the entry whose id or (unique) name is `reference`, else null. */
function resolve(bag: Readonly<Record<string, { readonly name: string }>>, order: readonly string[], reference: string): string | null {
  if (Object.hasOwn(bag, reference)) return reference;
  const named = order.filter((id) => bag[id]?.name === reference);
  return named.length === 1 ? (named[0] ?? null) : null;
}

const resolveLoad = (analysis: AnalysisCase, reference: string): string | null => resolve(analysis.loads, analysis.loadOrder, reference);
const resolveConstraint = (analysis: AnalysisCase, reference: string): string | null =>
  resolve(analysis.constraints, analysis.constraintOrder, reference);

/**
 * @affects doc.analysis.cases[analysisId].nonlinear.probes (adds 1 probe, id `prb-<step>.<k>`; affected: [probeId])
 * @invariant the load / constraint is stored by id even when given by name; the displacement is read at the mesh node nearest to the point
 * @failure unknown analysis -> FEA_ANALYSIS_NOT_FOUND; not nonlinear_static -> NLS_CASE_NOT_NONLINEAR; unknown or ambiguous load / constraint
 *   -> NLS_PROBE_REFERENCE_UNKNOWN; non-finite point -> NLS_CONTROL_INVALID (refusals, unchanged doc)
 */
export const addCurveProbe = defineCommand({
  name: 'add_curve_probe',
  description:
    'Record a load-displacement curve of a nonlinear_static analysis: one point per stored increment (see set_nonlinear_controls ' +
    'outputIncrements), read from the CalculiX .dat output. load is either { kind: "load", loadId } (the multiplied value of that load at ' +
    'each increment) or { kind: "reaction", constraintId, component } (summed reaction force of the constraint nodes, component x | y | z | ' +
    'magnitude, as printed by CalculiX). loadId / constraintId accept the id or the unique name. displacement: { point, dof } reads ux | uy | ' +
    'uz | magnitude at the mesh node nearest to the point (document units, an exact node is not required). The curve starts at (0, 0). ' +
    'Returns the probe id in affected[0]; the solved summary lists points, peak load and displacement range per probe.',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Display name of the curve, e.g. "tip".'),
    load: z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('load').describe('Load axis is the multiplied value of one load.'),
          loadId: z.string().describe('Id (or unique name) of a load of this analysis; the curve uses magnitude x step multiplier.'),
        }),
        z.object({
          kind: z.literal('reaction').describe('Load axis is the reaction force summed over the nodes of one constraint.'),
          constraintId: z.string().describe('Id (or unique name) of a constraint of this analysis; its nodes carry the reaction.'),
          component: z.enum(['x', 'y', 'z', 'magnitude']).describe('Reaction force component in the global axes, or its magnitude.'),
        }),
      ])
      .describe('What is plotted on the load axis.'),
    displacement: z
      .object({
        point: vec3('Location [x, y, z] in document units; the nearest mesh node is read.'),
        dof: z.enum(['ux', 'uy', 'uz', 'magnitude']).describe('Displacement component, or its magnitude.'),
      })
      .describe('What is plotted on the displacement axis.'),
  }),
  run: (doc, { analysisId, name, load, displacement }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseNls(doc, 'add_curve_probe', code, message, [analysisId], paths);
    const found = nonlinearCase(doc, 'add_curve_probe', analysisId);
    if (isRefusal(found)) return found;
    const { analysis } = found;
    if (!displacement.point.every(Number.isFinite))
      return fail('NLS_CONTROL_INVALID', 'point must be three finite numbers', ['displacement.point']);
    let stored: CurveProbe['load'];
    if (load.kind === 'load') {
      const loadId = resolveLoad(analysis, load.loadId);
      if (loadId === null)
        return fail('NLS_PROBE_REFERENCE_UNKNOWN', `no unique load '${load.loadId}' in '${analysisId}'`, ['load.loadId']);
      stored = { kind: 'load', loadId };
    } else {
      const constraintId = resolveConstraint(analysis, load.constraintId);
      if (constraintId === null)
        return fail('NLS_PROBE_REFERENCE_UNKNOWN', `no unique constraint '${load.constraintId}' in '${analysisId}'`, ['load.constraintId']);
      stored = { kind: 'reaction', constraintId, component: load.component };
    }
    const nonlinear = nonlinearOf(analysis);
    const id = nextId('prb');
    const probe: CurveProbe = { id, name, load: stored, displacement: { point: displacement.point, dof: displacement.dof } };
    const next = { ...nonlinear, probes: { ...nonlinear.probes, [id]: probe }, probeOrder: [...nonlinear.probeOrder, id] };
    const axis = stored.kind === 'load' ? `load ${stored.loadId}` : `reaction ${stored.component} of ${stored.constraintId}`;
    return changed(
      withNonlinear(doc, analysis, next),
      `add_curve_probe: '${id}' (${name}) plots ${axis} against ${displacement.dof} at [${displacement.point.join(', ')}] in '${analysisId}' (${next.probeOrder.length} curve probe(s)).`,
      [id],
    );
  },
});
