/** `analyze_pipe_stress`, `check_pipe_stress` (07 PST M3): read-only queries over the model rebuilt from the current document. */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { analyzeStressModel, type Analysis, type Finding } from '../analysis';
import { refuse, remediationOf } from '../codes';
import { modelGeometry } from '../model/geometry';
import type { StressModel } from '../model/schema';
import { SOLVER_VERSION } from '../solve/run';
import { analysisRefusal, isRefusal, modelOr } from './common';
import { decodeCursor, encodeCursor, pageOf } from './paging';

const DEG = 180 / Math.PI;
const nodeIndex = (id: string): number => Number(id.slice(1)) - 1;

/** The staleness finding of recorded results, or null. */
export function staleFinding(model: StressModel, inputHash: string): Finding | null {
  return model.recorded === undefined || model.recorded.inputHash === inputHash
    ? null
    : {
        code: 'PST_RESULTS_STALE',
        severity: 'warn',
        ids: [model.id],
        paths: ['recorded'],
        message: `the results recorded for ${model.id} were computed from other inputs (the model, pipes, supports or material changed since)${model.approval === undefined ? '' : '; the approval no longer covers the current design'}`,
        remediation: remediationOf('PST_RESULTS_STALE'),
      };
}

function maxDisplacement(analysis: Analysis, caseIndex: number): { node: string; mm: number } {
  const state = analysis.states[caseIndex];
  let best = { node: 'N1', mm: 0 };
  for (let n = 0; n < analysis.built.layout.nodes.length; n++) {
    const mm = Math.hypot(state?.displacements[n * 6] ?? 0, state?.displacements[n * 6 + 1] ?? 0, state?.displacements[n * 6 + 2] ?? 0);
    if (mm > best.mm) best = { node: `N${n + 1}`, mm };
  }
  return best;
}

function summary(analysis: Analysis, model: StressModel): Record<string, unknown> {
  const { built } = analysis;
  const stale = staleFinding(model, analysis.inputHash);
  return {
    modelId: model.id,
    rule: model.rule,
    status: analysis.status,
    model: {
      pipes: built.sources.pipes.map((pipe) => pipe.id),
      nodes: built.layout.nodes.length,
      elements: built.layout.elements.length,
      dof: built.layout.nodes.length * 6,
      supports: built.sources.supports.length,
      anchors: built.restraints.anchors.length,
      contacts: built.restraints.contacts.length,
    },
    solver: {
      version: SOLVER_VERSION,
      maxResidual: Math.max(0, ...analysis.states.map((state) => state.residual)),
      iterations: Object.fromEntries(analysis.states.map((state) => [state.name, state.iterations])),
    },
    cases: analysis.states.map((state, index) => ({
      name: state.name,
      type: state.type,
      iterations: state.iterations,
      residual: state.residual,
      maxDisplacement: maxDisplacement(analysis, index),
      contacts: state.contacts.map((outcome) => ({
        sources: outcome.contact.sources,
        node: `N${outcome.contact.node + 1}`,
        status: outcome.status,
        normalForceN: outcome.normalForceN,
      })),
    })),
    governing: analysis.governing,
    findings: [...analysis.findings, ...(stale === null ? [] : [stale])],
    inputHash: analysis.inputHash,
    resultHash: analysis.resultHash,
    recorded:
      model.recorded === undefined ? null : { status: model.recorded.status, stale: stale !== null, resultHash: model.recorded.resultHash },
    reviewRequired: true,
    provenance: {
      method:
        'frame3d Timoshenko pipe frame, bends as arc chords with flexibility k, active-set supports with return-mapped Coulomb friction',
      rule: model.rule,
      defaulted: analysis.defaulted,
      allowables: {
        ShMPa: analysis.conditions.material.ShMPa,
        ScMPa: analysis.conditions.material.ScMPa,
        f: analysis.stress.allowables.f,
        occasionalMPa: analysis.stress.occasionalMPa,
      },
      sections:
        'stiffness and expansion stress on the nominal wall; sustained and occasional stress on the wall less the corrosion allowance',
      limits:
        'end and interior extremum stations of each element; OCC cases combined by scalar or srss are evaluated at the element end stations (nodes) only',
    },
  };
}

/**
 * @affects none; data = { status, model, solver, cases, governing, findings, inputHash, resultHash, recorded, reviewRequired, provenance, details?, geometry? }
 * @invariant read-only; the FE model is rebuilt from the current pipes / supports on every call and the same document gives the same data
 * @failure unknown model -> PST_MODEL_NOT_FOUND; no conditions -> PST_CONDITIONS_MISSING; PST_WALL_UNKNOWN, PST_BEND_TOO_TIGHT, PST_UNSTABLE (ids = nodes, paths = DOF names), PST_MODEL_TOO_LARGE, PST_NONLINEAR_NOT_CONVERGED (ids = toggling restraints), PST_LOADCASE_INVALID, PST_TEMPERATURE_OUT_OF_TABLE, ...
 */
export const analyzePipeStress = defineCommand({
  name: 'analyze_pipe_stress',
  description:
    'Analyse a stress model: rebuild the finite element model from the current pipes and supports, solve every load case (weight, thermal, pressure, force primitives with non-linear supports re-evaluated per case) and apply the code check. ' +
    'Read-only. Default output is the summary: model size, solver residual and iterations per case, the largest displacement per case, the governing station per code case (ratio = stress / allowable), the findings with codes and remediation, the input hash and the support status. ' +
    '`include` adds details: "displacements" (node, mm, degrees), "reactions" (force N and moment N.mm at every anchor / support node per case), "stresses" (every station with stress, allowable, ratio, rule, SIFs); "geometry" (data.geometry: nodes { id, positionMm }, elements { id, pipeId, kind, nodeIds, pointsMm, odMm, wallMm, bendRadiusMm } and pipes { id, kind, pointsMm centreline, elementIds }, mm, building pipes and routed runs alike; use it to place support and reaction arrows); `cases` and `nodes` (ids like N3 from the summary) filter the details. ' +
    'Large models: give `limit` (details per list) to page the details; the answer then carries data.page { limit, offset, total per list, nextCursor } and the next call passes cursor = nextCursor (the same limit and filters); a cursor from other inputs is PST_CURSOR_STALE. ' +
    'Units: mm, N, N.mm, MPa. reviewRequired is always true: a qualified engineer reviews the result. Refusals carry PST_* codes (PST_UNSTABLE names the free node and DOF; add an anchor or guide there). Next: check_pipe_stress, record_pipe_stress_results.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    cases: z.array(z.string()).describe('Only these load case names in the details. Default all.').optional(),
    nodes: z
      .array(z.string().regex(/^N[1-9][0-9]*$/))
      .describe('Only these node ids (N1, N2 ...) in the details. Default all.')
      .optional(),
    include: z
      .array(z.enum(['displacements', 'reactions', 'stresses', 'geometry']))
      .describe(
        'Details to add to the summary. Default none (summary only). "geometry" adds data.geometry (not filtered by cases / nodes).',
      )
      .optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100000)
      .describe('Page size: the most entries of each requested detail list to return (displacements, reactions, stresses). Default: all.')
      .optional(),
    cursor: z.string().describe('The data.page.nextCursor of the previous page (needs limit). Default: the first page.').optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc, params): CommandResult => {
    const model = modelOr(doc, 'analyze_pipe_stress', params.modelId);
    if (isRefusal(model)) return model;
    const analysis = analyzeStressModel(doc, model);
    if (!analysis.ok) return analysisRefusal(doc, 'analyze_pipe_stress', analysis);
    const data = summary(analysis, model);
    const wanted = (state: { name: string }): boolean => params.cases === undefined || params.cases.includes(state.name);
    const nodeWanted = (index: number): boolean => params.nodes === undefined || params.nodes.some((id) => nodeIndex(id) === index);
    const include = params.include ?? [];
    const details: Record<string, unknown> = {};
    if (include.includes('displacements'))
      details['displacements'] = analysis.states
        .filter(wanted)
        .flatMap((state) =>
          analysis.built.layout.nodes.flatMap((_, n) =>
            nodeWanted(n)
              ? [
                  {
                    case: state.name,
                    node: `N${n + 1}`,
                    uMm: [0, 1, 2].map((i) => state.displacements[n * 6 + i]),
                    rotDeg: [3, 4, 5].map((i) => (state.displacements[n * 6 + i] as number) * DEG),
                  },
                ]
              : [],
          ),
        );
    if (include.includes('reactions'))
      details['reactions'] = analysis.supportLoads.filter(
        (load) =>
          (params.cases === undefined || params.cases.includes(load.case)) &&
          (params.nodes === undefined || params.nodes.includes(load.nodeId)),
      );
    if (include.includes('stresses'))
      details['stresses'] = analysis.stress.rows.filter(
        (row) =>
          (params.cases === undefined || params.cases.includes(row.case)) &&
          (params.nodes === undefined || row.node === null || params.nodes.includes(row.node)),
      );
    let page: Record<string, unknown> | null = null;
    if (params.cursor !== undefined && params.limit === undefined)
      return refuse(
        doc,
        'analyze_pipe_stress',
        'PST_PARAM_INVALID',
        'a cursor needs the limit of the page it continues',
        [model.id],
        ['limit'],
      );
    if (params.limit !== undefined) {
      let offset = 0;
      if (params.cursor !== undefined) {
        const decoded = decodeCursor(params.cursor, analysis.inputHash);
        if (!decoded.ok)
          return refuse(
            doc,
            'analyze_pipe_stress',
            decoded.stale ? 'PST_CURSOR_STALE' : 'PST_PARAM_INVALID',
            decoded.stale
              ? 'the cursor was issued for other inputs (the model changed since)'
              : 'the cursor is not one issued by this command',
            [model.id],
            ['cursor'],
          );
        offset = decoded.offset;
      }
      const totals: Record<string, number> = {};
      for (const key of Object.keys(details)) {
        const pageOfList = pageOf(details[key] as unknown[], offset, params.limit);
        details[key] = pageOfList.items;
        totals[key] = pageOfList.total;
      }
      const more = Object.values(totals).some((total) => total > offset + (params.limit as number));
      page = {
        limit: params.limit,
        offset,
        total: totals,
        nextCursor: more ? encodeCursor(analysis.inputHash, offset + params.limit) : null,
      };
    }
    const worst = analysis.governing.reduce<{ ratio: number; case: string } | null>(
      (a, b) => (a === null || b.ratio > a.ratio ? b : a),
      null,
    );
    return report(
      doc,
      `analyze_pipe_stress: ${model.id} ${analysis.states.length} case(s), ${analysis.built.layout.nodes.length} nodes, status ${analysis.status}${worst === null ? '' : `, governing ${worst.case} ratio ${worst.ratio.toFixed(3)}`}; ${analysis.findings.filter((f) => f.severity === 'fail').length} fail, ${analysis.findings.filter((f) => f.severity === 'warn').length} warning finding(s); review required.`,
      {
        ...data,
        ...(Object.keys(details).length > 0 ? { details } : {}),
        ...(page === null ? {} : { page }),
        ...(include.includes('geometry') ? { geometry: modelGeometry(analysis.built) } : {}),
      },
    );
  },
});

/**
 * @affects none; data = { items, ok, status, reviewRequired, governing, inputHash }
 * @invariant read-only; ok is false when any item is a fail; a stale recorded result is an item (PST_RESULTS_STALE), never a silent pass; status incomplete when no SUS or EXP case exists
 * @failure as analyze_pipe_stress
 */
export const checkPipeStress = defineCommand({
  name: 'check_pipe_stress',
  description:
    'Check a stress model against its piping code: runs the analysis and returns the findings as items { code, severity, ids, paths, message, remediation }. ' +
    'Fail items: PST_SUSTAINED_OVERSTRESS (S_L above S_h), PST_EXPANSION_OVERSTRESS (S_E above S_A), PST_OCCASIONAL_OVERSTRESS. Warnings: PST_SUPPORT_LIFTOFF, PST_DISPLACEMENT_LIMIT (with displacementLimitMm), PST_RESULTS_STALE (recorded results computed from other inputs), ' +
    'PST_SIF_EDITION (edition needs B31J), PST_*_DEFAULTED (named defaults), PST_MATERIAL_UNVERIFIED, PST_CASE_INCOMPLETE (no SUS or EXP case), PST_DISCONNECTED. ' +
    'ok = no fail item; status is pass, fail or incomplete. Read-only; reviewRequired is always true. Next: record_pipe_stress_results.',
  params: z.object({
    modelId: z.string().min(1).describe('Id of the stress model.'),
    displacementLimitMm: z
      .number()
      .positive()
      .describe('Warn (PST_DISPLACEMENT_LIMIT) when the operating displacement of a node exceeds this, mm.')
      .optional(),
  }),
  annotations: { readOnly: true, idempotent: true },
  run: (doc: CadDocument, { modelId, displacementLimitMm }): CommandResult => {
    const model = modelOr(doc, 'check_pipe_stress', modelId);
    if (isRefusal(model)) return model;
    const analysis = analyzeStressModel(doc, model);
    if (!analysis.ok) return analysisRefusal(doc, 'check_pipe_stress', analysis);
    const items: Finding[] = [...analysis.findings];
    const stale = staleFinding(model, analysis.inputHash);
    if (stale !== null) items.push(stale);
    if (displacementLimitMm !== undefined) {
      const over = analysis.states.flatMap((state, index) =>
        state.type === 'OPE' && maxDisplacement(analysis, index).mm > displacementLimitMm ? [maxDisplacement(analysis, index)] : [],
      );
      if (over.length > 0)
        items.push({
          code: 'PST_DISPLACEMENT_LIMIT',
          severity: 'warn',
          ids: over.map((entry) => entry.node),
          paths: [],
          message: `operating displacement ${Math.max(...over.map((entry) => entry.mm)).toFixed(1)} mm exceeds ${displacementLimitMm} mm`,
          remediation: remediationOf('PST_DISPLACEMENT_LIMIT'),
        });
    }
    const ok = !items.some((item) => item.severity === 'fail');
    return report(
      doc,
      `check_pipe_stress: ${model.id} ${analysis.status}; ${items.filter((i) => i.severity === 'fail').length} fail, ${items.filter((i) => i.severity === 'warn').length} warning item(s); review required.`,
      {
        modelId: model.id,
        ok,
        status: analysis.status,
        items,
        governing: analysis.governing,
        inputHash: analysis.inputHash,
        reviewRequired: true,
      },
    );
  },
});
