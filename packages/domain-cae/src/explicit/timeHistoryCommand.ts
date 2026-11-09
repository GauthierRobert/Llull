/** add_time_history: node / part / rigid-wall time histories requested of an explicit case (§3 add_time_history, TR-EXP-10 /TH/*). */

import { TIME_HISTORY_QUANTITIES, type ExplicitSpec, type ExplicitTimeHistory } from '@core/model/explicit';
import { defineCommand, z } from '@core/commands/schema';
import { changed } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { nextId } from '@lib/id';
import { analysisIdSchema } from '../shared/schemas';
import { feaTargetSchema, targetProblem, toTarget } from '../shared/target';
import { refuseExplicit } from './codes';
import { MAX_HISTORY_INTERVALS, withinHistoryCap } from './defaults';
import { explicitCase, withSpec } from './model';

/** Most histories one case may request. */
const MAX_TIME_HISTORIES = 32;

/**
 * @affects doc.analysis.cases[analysisId].explicit.timeHistories (adds 1 request; affected: [analysisId, historyId])
 * @invariant ids `th-<step>.<k>`; quantities are the kind's own, in request order; intervalS absent = the case history interval (never defaulted)
 * @failure unknown / non-explicit case / no controls -> FEA_ANALYSIS_NOT_FOUND / EXP_CASE_TYPE / EXP_CONTROLS_MISSING; duplicate name, 33rd
 *   history, repeated / wrong-kind quantities, intervalS outside (0, endTime], missing or extra target / partId / wallId for the kind,
 *   edge / plane-section targets -> EXP_TIME_HISTORY_INVALID; unresolvable target -> FEA_TARGET_UNRESOLVED / FEA_PART_NOT_IN_ANALYSIS;
 *   part not in the case -> EXP_TARGET_NOT_IN_CASE; wall id not in the case -> EXP_RIGID_WALL_NOT_FOUND
 */
export const addTimeHistory = defineCommand({
  name: 'add_time_history',
  description:
    'Request a time history of an explicit_dynamics case (run controls set first): kind node records displacement / velocity / acceleration of ' +
    'the nodes of `target` (a part with facesNear = all nodes on the nearest box face, or pointsNear = the nearest node; no edgesNear / ' +
    'intersectPlane); kind part records internal_energy / kinetic_energy / momentum / mass of the part `partId`; kind rigid_wall records ' +
    'normal_force / normal_impulse / energy of the wall `wallId` (its rw- id, affected[1] of add_rigid_wall, or its name). `intervalS` (seconds) overrides the case history ' +
    'interval of set_explicit_controls; omit it to follow that interval. Names are unique, at most 32 histories per case. Returns the history id ' +
    '(th-) in affected[1]; remove it with delete_analysis_item.',
  params: z.object({
    analysisId: analysisIdSchema,
    name: z.string().min(1).describe('Unique name within the case, e.g. "tip_velocity".'),
    kind: z.enum(['node', 'part', 'rigid_wall']).describe('What is recorded: nodes, a whole part or a rigid wall.'),
    target: feaTargetSchema.optional().describe('Kind node only: the part and the faces / points whose nodes are recorded.'),
    partId: z.string().optional().describe('Kind part only: id of a part of the case.'),
    wallId: z.string().optional().describe('Kind rigid_wall only: id (rw-...) or name of a rigid wall of the case.'),
    quantities: z
      .array(z.string())
      .min(1)
      .describe(
        'node: displacement | velocity | acceleration; part: internal_energy | kinetic_energy | momentum | mass; rigid_wall: normal_force | normal_impulse | energy. No repeats.',
      ),
    intervalS: z
      .number()
      .optional()
      .describe('Sampling interval, seconds, 0 < intervalS <= end time; omit to use the case history interval.'),
  }),
  run: (doc, { analysisId, name, kind, target, partId, wallId, quantities, intervalS }): CommandResult => {
    const fail = (code: string, message: string, paths: readonly string[] = []): CommandResult =>
      refuseExplicit(doc, 'add_time_history', code, message, [analysisId], paths);
    const invalid = (message: string, paths: readonly string[]): CommandResult => fail('EXP_TIME_HISTORY_INVALID', message, paths);
    const found = explicitCase(doc, analysisId);
    if ('code' in found) return fail(found.code, found.message);
    const { analysisCase, spec } = found;
    if (spec === undefined) return fail('EXP_CONTROLS_MISSING', `analysis '${analysisId}' has no explicit controls yet`);
    const existing = spec.timeHistoryOrder ?? [];
    if (existing.length >= MAX_TIME_HISTORIES) return invalid(`'${analysisId}' already has ${MAX_TIME_HISTORIES} time histories`, ['name']);
    if (existing.some((id) => spec.timeHistories?.[id]?.name === name)) return invalid(`a time history named '${name}' exists`, ['name']);
    const allowed: readonly string[] = TIME_HISTORY_QUANTITIES[kind];
    const wrong = quantities.find((quantity) => !allowed.includes(quantity));
    if (wrong !== undefined) return invalid(`'${wrong}' is not a ${kind} quantity (${allowed.join(', ')})`, ['quantities']);
    if (new Set(quantities).size !== quantities.length) return invalid('quantities repeat', ['quantities']);
    if (intervalS !== undefined && !(intervalS > 0 && intervalS <= spec.endTimeS))
      return invalid(`intervalS must satisfy 0 < intervalS <= end time (${spec.endTimeS} s)`, ['intervalS']);
    if (!withinHistoryCap(spec.endTimeS, intervalS ?? spec.historyIntervalS))
      return invalid(`end time / interval must be at most ${MAX_HISTORY_INTERVALS} samples (raise intervalS)`, ['intervalS']);
    const extra = [
      ...(kind !== 'node' && target !== undefined ? ['target'] : []),
      ...(kind !== 'part' && partId !== undefined ? ['partId'] : []),
      ...(kind !== 'rigid_wall' && wallId !== undefined ? ['wallId'] : []),
    ];
    if (extra.length > 0) return invalid(`${extra.join(', ')} do not apply to kind ${kind}`, extra);
    let recorded: Pick<ExplicitTimeHistory, 'target' | 'wallId'> = {};
    if (kind === 'node') {
      if (target === undefined) return invalid('kind node needs a target', ['target']);
      if (target.edgesNear !== undefined || target.intersectPlane !== undefined)
        return invalid('edge and plane-section targets are not built for llull_explicit (use facesNear or pointsNear)', ['target']);
      const problem = targetProblem(doc, analysisCase, toTarget(target));
      if (problem !== null) return fail(problem.code, problem.message, ['target']);
      recorded = {
        target: {
          entityId: target.entityId,
          ...(target.facesNear !== undefined ? { facesNear: target.facesNear } : {}),
          ...(target.pointsNear !== undefined ? { pointsNear: target.pointsNear } : {}),
        },
      };
    } else if (kind === 'part') {
      if (partId === undefined) return invalid('kind part needs partId', ['partId']);
      if (!Object.hasOwn(analysisCase.parts, partId))
        return fail('EXP_TARGET_NOT_IN_CASE', `'${partId}' is not a part of '${analysisId}'`, ['partId']);
      recorded = { target: { entityId: partId } };
    } else {
      if (wallId === undefined) return invalid('kind rigid_wall needs wallId', ['wallId']);
      const resolved = Object.hasOwn(spec.rigidWalls, wallId)
        ? wallId
        : spec.rigidWallOrder.find((id) => spec.rigidWalls[id]?.name === wallId);
      if (resolved === undefined) return fail('EXP_RIGID_WALL_NOT_FOUND', `no rigid wall '${wallId}' in '${analysisId}'`, ['wallId']);
      recorded = { wallId: resolved };
    }
    const history: ExplicitTimeHistory = { name, kind, ...recorded, quantities, ...(intervalS !== undefined ? { intervalS } : {}) };
    const id = nextId('th');
    const next: ExplicitSpec = {
      ...spec,
      timeHistories: { ...(spec.timeHistories ?? {}), [id]: history },
      timeHistoryOrder: [...existing, id],
    };
    return changed(
      withSpec(doc, analysisCase, next),
      `add_time_history: ${id} '${name}' ${kind} ${quantities.join(', ')}${intervalS !== undefined ? ` every ${intervalS} s` : ' at the case history interval'} in ${analysisId} (${existing.length + 1}/${MAX_TIME_HISTORIES}).`,
      [analysisId, id],
    );
  },
});
