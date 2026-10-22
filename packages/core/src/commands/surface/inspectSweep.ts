/** inspect_sweep: read-only frames, twist, scale, curvature and fold margin of a sweep along its path. */

import type { CommandResult } from '../types';
import { defineCommand, z } from '../schema';
import { report, tableRejection } from '../noop';
import { roundSignificant } from '../../lib/significant';
import { evaluateSweep } from '../../geometry/sweepEval/evaluate';
import { sweepSamples, sweepTotals } from '../../geometry/sweepEval/inspect';
import { baseSectionArea } from '../../geometry/sweepEval/laws';
import { sweepAnalyticVolume } from '../../geometry/sweepEval/volume';
import { sweepRealisation } from '../../geometry/sweepEval/realisation';

const MAX_SAMPLES = 2000;
const sig = (value: number): number => roundSignificant(value, 10);
const sigOrNull = (value: number | null): number | null => (value === null ? null : sig(value));
const sig3 = (v: readonly number[]): number[] => v.map(sig);

const refuse = tableRejection({
  SWG_ENTITY_NOT_FOUND: 'pass the id of a sweep entity (sweep_profile, add_coil)',
  SWG_PARAM_INVALID: 'give samples as an integer 2..2000, or at as fractions in [0, 1]',
  SWG_FRAME_DEGENERATE: 'the sweep cannot be carried along its path; rebuild it with orientation minimal',
  SWG_LAW_INVALID: 'fix the sweep laws with edit_step_params',
  SWG_LAW_NONPOSITIVE: 'fix the sweep laws with edit_step_params',
});

/**
 * @affects none; data = { id, unit, pathLength, sectionArea, samples [{ t, s, point, tangent, normal, binormal, twistRad, scale, curvatureRadius, sectionExtent, margin }], totals, realisation, provenance }
 * @invariant frames are entity-local; margin <= 1 means the swept envelope folds (SWG_SELF_INTERSECTION_LOCAL); null = no fold risk (straight run)
 * @failure unknown id / not a sweep -> SWG_ENTITY_NOT_FOUND; samples outside 2..2000 or at outside [0, 1] -> SWG_PARAM_INVALID
 */
export const inspectSweep = defineCommand({
  name: 'inspect_sweep',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only: report frames and sizes of a sweep (sweep_profile, add_coil) along its path. At `samples` equally spaced arc-length fractions (default 21, 2..2000) or at explicit `at` fractions ' +
    'return the entity-local point, unit tangent, section axes (normal = section x, binormal = section y), twist (radians), scale, ' +
    'path curvature radius, the section extent toward the centre of curvature and the fold margin (curvature radius / extent; <= 1 means the swept surface folds onto itself, null on straight runs). ' +
    'Totals: pathLength and integralAreaDs (∫ section area ds, the volume of a section centred on the path), twistVsMinimalRad (net section rotation about the path relative to the twist-free frame), ' +
    'twistVsFrenetRad (net rotation of the Frenet frame relative to the twist-free frame, ∫ torsion ds; null where Frenet is undefined), analyticVolume when the section is round (else null; use mass_properties). ' +
    'Lengths in document units, areas in units squared, angles in radians. Use it to explain a frame mode or to find where a sweep is about to fold.',
  params: z.object({
    id: z.string().describe('Id of a sweep entity.'),
    samples: z
      .number()
      .describe('Number of equally spaced arc-length fractions, integer 2..2000. Default 21. Ignored when `at` is given.')
      .optional(),
    at: z.array(z.number()).describe('Explicit arc-length fractions in [0, 1] to measure (at most 2000).').optional(),
  }),
  run: (doc, { id, samples = 21, at }): CommandResult => {
    const entity = doc.entities[id];
    if (entity?.kind !== 'sweep') return refuse(doc, 'inspect_sweep', 'SWG_ENTITY_NOT_FOUND', `no sweep with id "${id}"`, [id], ['id']);
    const bad = (message: string, path: string): CommandResult => refuse(doc, 'inspect_sweep', 'SWG_PARAM_INVALID', message, [id], [path]);
    if (at === undefined && !(Number.isInteger(samples) && samples >= 2 && samples <= MAX_SAMPLES))
      return bad(`samples must be an integer in 2..${MAX_SAMPLES} (got ${samples})`, 'samples');
    if (at !== undefined && (at.length === 0 || at.length > MAX_SAMPLES || at.some((t) => !(t >= 0 && t <= 1))))
      return bad(`at must hold 1..${MAX_SAMPLES} fractions in [0, 1]`, 'at');
    const ts = at ?? Array.from({ length: samples }, (_, k) => k / (samples - 1));
    const measured = sweepSamples(entity, ts);
    const totals = sweepTotals(entity);
    const evaluation = evaluateSweep(entity);
    if (!Array.isArray(measured) || 'code' in totals || !('frames' in evaluation)) {
      const issue = !Array.isArray(measured)
        ? measured
        : 'code' in totals
          ? totals
          : { code: 'SWG_FRAME_DEGENERATE', message: 'sweep cannot be evaluated' };
      return refuse(doc, 'inspect_sweep', issue.code, issue.message, [id], []);
    }
    const analyticVolume = sweepAnalyticVolume(entity);
    const orientation = entity.orientation?.mode ?? 'minimal';
    const data = {
      id,
      unit: doc.units,
      pathLength: sig(evaluation.length),
      sectionArea: sig(baseSectionArea(entity)),
      samples: measured.map((m) => ({
        t: sig(m.t),
        s: sig(m.s),
        point: sig3(m.point),
        tangent: sig3(m.tangent),
        normal: sig3(m.normal),
        binormal: sig3(m.binormal),
        twistRad: sig(m.twistRad),
        scale: sig(m.scale),
        curvatureRadius: sigOrNull(m.curvatureRadius),
        sectionExtent: sigOrNull(m.sectionExtent),
        margin: sigOrNull(m.margin),
      })),
      totals: {
        twistVsMinimalRad: sig(totals.twistVsMinimalRad),
        twistVsFrenetRad: sigOrNull(totals.twistVsFrenetRad),
        integralAreaDs: sig(totals.integralAreaDs),
        analyticVolume: sigOrNull(analyticVolume),
      },
      realisation: sweepRealisation(entity),
      provenance: {
        method: {
          minimal: 'RMF double reflection',
          frenet: 'Frenet',
          fixed: 'fixed section plane',
          binormal: 'binormal direction',
          axis_plane: 'screw frame about an axis',
        }[orientation],
        reference: 'Wang et al. 2008 (RMF); Frenet-Serret',
        inputs: { id, samples: ts.length },
      },
    };
    const margins = measured.flatMap((m) => (m.margin === null ? [] : [m.margin]));
    return report(
      doc,
      `inspect_sweep ${id}: path length ${sig(evaluation.length)} ${doc.units}, ${orientation} frame, ${ts.length} samples, ` +
        `twist vs minimal ${sig(totals.twistVsMinimalRad)} rad, ∫A ds ${sig(totals.integralAreaDs)}, ` +
        `${margins.length === 0 ? 'no fold risk (straight)' : `least fold margin ${sig(Math.min(...margins))}`}.`,
      data,
    );
  },
});
