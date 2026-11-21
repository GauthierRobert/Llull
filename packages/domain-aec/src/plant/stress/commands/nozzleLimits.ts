/** `set_nozzle_load_limit` and `check_nozzle_loads`: nozzle load limits per stress model, checked on the stored results in the 03 EQP nozzle frame (07 PST §5.9, FR-PST-14). */

import { defineCommand, z } from '@core/commands/schema';
import { changed, report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { nextId } from '@lib/id';
import { elementsOf, getBuilding } from '../../../building/model';
import { equipmentPorts, type ConnectionPort } from '../../equipment/geometry/ports';
import { currentInputHash } from '../analysis';
import { evaluateNozzleRule, nozzleRuleShape, vec3, type NozzleRule } from '../code/nozzleRule';
import { nozzleFrame, toFrame } from '../code/nozzleFrame';
import type { Vec3 } from '../code/nozzleLimits';
import { refuse } from '../codes';
import type { NozzleLimit, StressModel } from '../model/schema';
import { withModel } from '../model/store';
import { isRefusal, modelOr } from './common';

const NMM_PER_NM = 1000;

/** The 03 EQP port `<tag>:<mark>` of the document, or undefined. */
function findPort(doc: CadDocument, portId: string): ConnectionPort | undefined {
  const building = getBuilding(doc);
  for (const element of elementsOf(building, 'equipment')) {
    const port = equipmentPorts(building, element).find((candidate) => candidate.id === portId);
    if (port !== undefined) return port;
  }
  return undefined;
}

const holds = (doc: CadDocument, model: StressModel, holderId: string): boolean =>
  model.restraints.some((restraint) => restraint.id === holderId) ||
  elementsOf(getBuilding(doc), 'pipeSupport').some((support) => support.id === holderId && model.scope.ids.includes(support.pipeId));

/**
 * @affects plant.stress.models[modelId].nozzleLimits: the limit of the port set (replaced when the port already has one); recorded results and approval stay (limits are checks on the results, not solver inputs)
 * @invariant the rule is validated now by evaluating it on a zero load (missing table, orientation, limits or nominal size are refused here, not at check time); one limit per port
 * @failure unknown model -> PST_MODEL_NOT_FOUND; unknown port -> PST_NOZZLE_PORT_NOT_FOUND; holder neither a support on the model pipes nor a restraint of the model -> PST_NOZZLE_NODE_NOT_FOUND; incomplete rule -> PST_NOZZLE_LIMIT_MISSING or PST_PARAM_INVALID; zero frameX -> PST_PARAM_INVALID
 */
export const setNozzleLoadLimit = defineCommand({
  name: 'set_nozzle_load_limit',
  description:
    'Bind a load limit to one equipment nozzle of a stress model, for check_nozzle_loads. portId is the 03 EQP port "<tag>:<mark>" (equipment_ports lists them); holderId is the id of the pipe support or the stress restraint (add_stress_restraint, normally an anchor at the nozzle flange) that holds the pipe at that nozzle: its reaction is the nozzle load. ' +
    'The rule is the one of nozzle_load_check: standard nema_sm23 / api617 (with nominalIn), api610 (with orientation and the Table 5 `table` you supply) or user (userLimits). Loads are checked in the nozzle frame: z along the nozzle axis pointing away from the equipment, y = world +Z projected on the plane normal to the axis (world +Y for a vertical nozzle), x = y cross z; ' +
    "give frameX (a world vector, e.g. the pump shaft) to take x as its projection on that plane instead (y = z cross x). This frame is llull's stated convention: it is NOT the API 610 Annex F axes unless frameX is the shaft direction. One limit per port: setting it again replaces the earlier one. Returns data { modelId, limitId, portId }.",
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    portId: z.string().min(1).describe('Equipment port id "<tag>:<mark>", e.g. "P-101:N2".'),
    holderId: z
      .string()
      .min(1)
      .describe('Id of the pipe support (on a pipe of the model) or stress restraint of the model that holds the pipe at the nozzle.'),
    frameX: vec3
      .describe('Optional world direction taken as the nozzle frame x axis (projected on the plane normal to the nozzle axis).')
      .optional(),
    ...nozzleRuleShape,
  }),
  run: (doc, params): CommandResult => {
    const model = modelOr(doc, 'set_nozzle_load_limit', params.modelId);
    if (isRefusal(model)) return model;
    const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[]): CommandResult =>
      refuse(doc, 'set_nozzle_load_limit', code, message, ids, paths);
    const port = findPort(doc, params.portId);
    if (port === undefined) return fail('PST_NOZZLE_PORT_NOT_FOUND', `no equipment port "${params.portId}"`, [params.portId], ['portId']);
    if (!holds(doc, model, params.holderId))
      return fail(
        'PST_NOZZLE_NODE_NOT_FOUND',
        `${params.holderId} is neither a restraint of model ${model.id} nor a pipe support on its pipes`,
        [params.holderId],
        ['holderId'],
      );
    if (nozzleFrame(port.direction, params.frameX) === null)
      return fail('PST_PARAM_INVALID', 'frameX must not be zero or along the nozzle axis', [params.portId], ['frameX']);
    const { modelId, ...stored } = params;
    void modelId;
    const trial = evaluateNozzleRule(stored, [0, 0, 0], [0, 0, 0], true);
    if ('error' in trial) return fail(trial.error.code, trial.error.message, [params.portId], [trial.error.path]);
    const limits = model.nozzleLimits ?? [];
    const id = limits.find((limit) => limit.portId === params.portId)?.id ?? nextId('nozlim');
    const limit: NozzleLimit = { id, ...stored };
    return {
      ...changed(
        withModel(doc, { ...model, nozzleLimits: [...limits.filter((entry) => entry.id !== id), limit] }),
        `set_nozzle_load_limit: ${id} on ${params.portId} (${params.standard}, held by ${params.holderId}) in model ${model.id}.`,
        [model.id, id],
      ),
      data: { modelId: model.id, limitId: id, portId: params.portId },
    };
  },
});

interface NozzleRow {
  readonly limitId: string;
  readonly portId: string;
  readonly case: string;
  readonly nodeId: string;
  readonly forceNozzleFrameN: Vec3;
  readonly momentNozzleFrameNm: Vec3;
  readonly ratio: number;
  readonly ok: boolean;
  readonly rule: string;
  readonly grade: 'B' | 'C';
  readonly components?: unknown;
}

/**
 * @affects none; data = { modelId, rows: [{ limitId, portId, case, nodeId, forceNozzleFrameN, momentNozzleFrameNm, ratio, ok, rule, grade }], worst, ok, warnings, unverified, reviewRequired, inputHash }
 * @invariant read-only: the load on the nozzle is minus the recorded support reaction at the holder (global axes) expressed in the nozzle frame, N and N.m; reads the recorded results, never reruns the analysis; scalar / srss combinations have no support loads and are not listed
 * @failure unknown model -> PST_MODEL_NOT_FOUND; no limits -> PST_NOZZLE_NO_LIMITS; nothing recorded -> PST_NOT_RECORDED; inputs changed since the record -> PST_RESULTS_STALE; port or holder gone -> PST_NOZZLE_PORT_NOT_FOUND / PST_NOZZLE_NODE_NOT_FOUND; a ratio above 1 -> PST_NOZZLE_OVERLOAD (detail carries every row)
 */
export const checkNozzleLoads = defineCommand({
  name: 'check_nozzle_loads',
  description:
    'Check every nozzle limit of a stress model (set_nozzle_load_limit) against the RECORDED stress results (record_pipe_stress_results): per load case the support reaction at the holder, with its sign reversed (the load the pipe puts on the equipment), is expressed in the nozzle frame (z along the nozzle axis away from the equipment, see set_nozzle_load_limit) and evaluated with the rule of the limit (as nozzle_load_check). ' +
    'Optional `cases` limits the check to named load cases (nozzle limits normally govern the operating cases; sustained and expansion-range cases are listed too unless you filter). Refused with PST_NOT_RECORDED when nothing is recorded and PST_RESULTS_STALE when the inputs changed since the record. A ratio above 1 is refused with PST_NOZZLE_OVERLOAD and every row in error.detail. ' +
    'Limits are unverified secondary-source or caller-supplied rules (PST_NOZZLE_LIMIT_UNVERIFIED warning); reviewRequired is always true. Read-only.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    cases: z.array(z.string().min(1)).min(1).describe('Load case names to check. Default: every recorded case.').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, { modelId, cases }): CommandResult => {
    const model = modelOr(doc, 'check_nozzle_loads', modelId);
    if (isRefusal(model)) return model;
    const fail = (code: string, message: string, ids: readonly string[], paths: readonly string[]): CommandResult =>
      refuse(doc, 'check_nozzle_loads', code, message, ids, paths);
    const limits = model.nozzleLimits ?? [];
    if (limits.length === 0) return fail('PST_NOZZLE_NO_LIMITS', `model ${model.id} has no nozzle limits`, [model.id], ['modelId']);
    const recorded = model.recorded;
    if (recorded === undefined) return fail('PST_NOT_RECORDED', `model ${model.id} has no recorded results`, [model.id], ['modelId']);
    const inputHash = currentInputHash(doc, model);
    if (inputHash !== recorded.inputHash)
      return fail('PST_RESULTS_STALE', `the inputs of ${model.id} changed since the record`, [model.id], ['modelId']);
    const unknown = (cases ?? []).filter((name) => !recorded.cases.includes(name));
    if (unknown.length > 0) return fail('PST_PARAM_INVALID', `no recorded case ${unknown.join(', ')}`, unknown, ['cases']);
    const rows: NozzleRow[] = [];
    const unverified = new Set<string>();
    const warnings = new Map<string, string>();
    for (const limit of limits) {
      const port = findPort(doc, limit.portId);
      if (port === undefined) return fail('PST_NOZZLE_PORT_NOT_FOUND', `no equipment port "${limit.portId}"`, [limit.portId], ['portId']);
      const frame = nozzleFrame(port.direction, limit.frameX);
      const loads = recorded.supportLoads.filter(
        (load) => load.supportIds.includes(limit.holderId) && (cases === undefined || cases.includes(load.case)),
      );
      if (frame === null || loads.length === 0)
        return fail(
          'PST_NOZZLE_NODE_NOT_FOUND',
          `no recorded reaction held by ${limit.holderId} for ${limit.id}`,
          [limit.holderId],
          ['holderId'],
        );
      for (const load of loads) {
        const force = toFrame(frame, [-load.forceN[0], -load.forceN[1], -load.forceN[2]]);
        const moment = toFrame(frame, [-load.momentNmm[0] / NMM_PER_NM, -load.momentNmm[1] / NMM_PER_NM, -load.momentNmm[2] / NMM_PER_NM]);
        const evaluated = evaluateNozzleRule(limit as NozzleRule, force, moment, true);
        if ('error' in evaluated) return fail(evaluated.error.code, evaluated.error.message, [limit.id], [evaluated.error.path]);
        evaluated.unverified.forEach((entry) => unverified.add(entry));
        evaluated.warnings.forEach((entry) => warnings.set(entry.code, entry.message));
        rows.push({
          limitId: limit.id,
          portId: limit.portId,
          case: load.case,
          nodeId: load.nodeId,
          forceNozzleFrameN: force,
          momentNozzleFrameNm: moment,
          ratio: evaluated.ratio,
          ok: evaluated.ok,
          rule: evaluated.ruleId,
          grade: evaluated.grade,
          ...(evaluated.numbers['components'] === undefined ? {} : { components: evaluated.numbers['components'] }),
        });
      }
    }
    const worst = rows.reduce((a, b) => (b.ratio > a.ratio ? b : a));
    const ok = rows.every((row) => row.ok);
    const data = {
      modelId: model.id,
      rows,
      worst: { limitId: worst.limitId, portId: worst.portId, case: worst.case, ratio: worst.ratio },
      ok,
      warnings: [...warnings].map(([code, message]) => ({ code, message })),
      unverified: [...unverified],
      reviewRequired: true,
      inputHash,
    };
    const text = `${rows.length} nozzle load(s) on ${limits.length} limit(s), worst ${worst.portId} ${worst.case} ratio ${worst.ratio.toFixed(4)}`;
    if (!ok)
      return refuse(
        doc,
        'check_nozzle_loads',
        'PST_NOZZLE_OVERLOAD',
        `${text}: a nozzle load exceeds its limit`,
        [worst.portId],
        ['modelId'],
        data,
      );
    return report(doc, `check_nozzle_loads: ${text}, all within the limits; reviewRequired.`, data);
  },
});
