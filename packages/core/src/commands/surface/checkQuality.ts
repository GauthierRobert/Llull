/** check_surface_quality: one read-only report on sheets - continuity across their interior knot lines, open edges, draft, degenerate samples. */

import type { NurbsSurfaceEntity, Vec3 } from '../../model/types';
import type { CommandResult } from '../types';
import { defineCommand, vec3, z } from '../schema';
import { report } from '../noop';
import { closestOnCurve } from '../../lib/nurbs/closest';
import { PATCH_SIDES, sideEdge, type PatchSide } from '../../lib/nurbs/crossFrame';
import { evaluateCurve } from '../../lib/nurbs/evaluate';
import { surfaceDomain } from '../../lib/nurbs/surface';
import { surfaceSample } from '../../lib/nurbs/surfaceCurvature';
import { extractSubSurface } from '../../lib/nurbs/surfaceEdit';
import type { NurbsSurfaceData } from '../../lib/nurbs/surfaceTypes';
import { len3 } from '../../lib/vec3';
import { placedSurface, surfacePoleExtent } from '../../geometry/nurbsSurface';
import { resolveSurfaceAnalysis } from '../../geometry/surfaceAnalysis/port';
import type { ContinuityTolerances, SurfaceAnalysisEngine } from '../../geometry/surfaceAnalysis/types';
import { currentContext } from '../context';
import { refuseSrf } from './shared';
import { sig, sigVec } from './surfaceShared';

const LEVELS = ['G0', 'G1', 'G2', 'G3'] as const;
type Level = (typeof LEVELS)[number];
const MAX_FINDINGS = 200;
const MAX_KNOT_LINES = 40;
const MAX_SHEETS_FOR_EDGES = 60;

type Severity = 'fail' | 'warn' | 'info';

interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly entityId: string;
  readonly edgeIndex?: number;
  readonly value: number;
  readonly limit: number;
  readonly unit: string;
  readonly worst: { readonly point: Vec3 };
  readonly remediation: string;
  readonly message: string;
}

const REMEDIATION: Readonly<Record<string, string>> = {
  SRF_CHECK_G0_GAP: 'refit the sheet through its sections or sew the pieces again: the patches do not meet along this knot line',
  SRF_CHECK_G1_ANGLE:
    'add a guide curve, raise the continuity of the loft, or blend the patches; an intended sharp edge needs a waiver from a human reviewer',
  SRF_CHECK_G2_CURVATURE:
    'refit with a higher degree / fewer knots, or blend with G2; an intended curvature break needs a waiver from a human reviewer',
  SRF_CHECK_G3: 'refit with a higher degree (quintic) across this knot line, or accept G2',
  SRF_CHECK_FREE_EDGES: 'sew_surfaces (makeSolid) the neighbouring sheets, or fill_surface / blend_surfaces the gap',
  SRF_CHECK_DRAFT_BELOW_MIN: 'change the pull direction or the surface; `flip` the sheet if its normal points into the part',
  SRF_CHECK_DEGENERATE_SAMPLES:
    'none: poles and collapsed edges have no normal; the figures skip them, so do not over-read curvature there',
  SRF_CHECK_TOLERANCE_DEFAULTED: 'give the programme tolerance explicitly when it is known',
  SRF_CHECK_NOT_A_SHEET: 'only nurbs_surface sheets are checked here; use check_continuity / measure_deviation for curves and solids',
};

/** Interior knots of a direction whose parametric continuity could still be below G3 (multiplicity >= degree - 2). */
function creaseKnots(knots: ReadonlyArray<number>, multiplicities: ReadonlyArray<number>, degree: number): number[] {
  return knots.filter((_, index) => index > 0 && index < knots.length - 1 && (multiplicities[index] as number) >= degree - 2);
}

function levelOf(
  joint: { g0Gap: number; g1AngleRad: number; g2Rel: number; g2Gap: number; g3Gap: number | null },
  tol: ContinuityTolerances,
  scale: number,
): Level | null {
  if (joint.g0Gap > tol.g0) return 'G0';
  if (joint.g1AngleRad > tol.g1AngleRad) return 'G1';
  if (!(joint.g2Gap <= tol.g2Abs || joint.g2Rel <= tol.g2Rel)) return 'G2';
  if (joint.g3Gap !== null && joint.g3Gap > tol.g2Abs && joint.g3Gap > tol.g3Rel * scale) return 'G3';
  return null;
}

/** Continuity findings across the interior crease lines of one sheet. */
function knotFindings(
  entity: NurbsSurfaceEntity,
  surface: NurbsSurfaceData,
  engine: SurfaceAnalysisEngine,
  tol: ContinuityTolerances,
  require: Level,
  samples: number,
  unit: string,
): Finding[] {
  const findings: Finding[] = [];
  const [[u0, u1], [v0, v1]] = surfaceDomain(surface);
  let lines = 0;
  const check = (direction: 'u' | 'v', knot: number, edgeIndex: number): void => {
    if (lines++ >= MAX_KNOT_LINES) return;
    const [left, right] =
      direction === 'u'
        ? [extractSubSurface(surface, [u0, knot], [v0, v1]), extractSubSurface(surface, [knot, u1], [v0, v1])]
        : [extractSubSurface(surface, [u0, u1], [v0, knot]), extractSubSurface(surface, [u0, u1], [knot, v1])];
    if (typeof left === 'string' || typeof right === 'string') return;
    const joint = engine.continuity(
      { type: 'surface', surface: left, side: direction === 'u' ? 'u1' : 'v1' },
      { type: 'surface', surface: right, side: direction === 'u' ? 'u0' : 'v0' },
      samples,
      tol,
    );
    const level = levelOf(joint, tol, Math.max(...joint.samples.map((s) => Math.abs(s.g3Gap ?? 0)), 1e-12));
    if (level === null || LEVELS.indexOf(level) > LEVELS.indexOf(require)) return;
    const [code, value, limit] =
      level === 'G0'
        ? ['SRF_CHECK_G0_GAP', joint.g0Gap, tol.g0]
        : level === 'G1'
          ? ['SRF_CHECK_G1_ANGLE', joint.g1AngleRad, tol.g1AngleRad]
          : level === 'G2'
            ? ['SRF_CHECK_G2_CURVATURE', joint.g2Rel, tol.g2Rel]
            : ['SRF_CHECK_G3', joint.g3Gap ?? 0, tol.g3Rel];
    findings.push({
      code: code as string,
      severity: 'fail',
      entityId: entity.id,
      edgeIndex,
      value: sig(value as number),
      limit: sig(limit as number),
      unit: level === 'G0' ? unit : level === 'G1' ? 'rad' : 'relative',
      worst: { point: sigVec(joint.worst.point) },
      remediation: REMEDIATION[code as string] as string,
      message: `${direction} = ${sig(knot)}: ${code === 'SRF_CHECK_G0_GAP' ? 'position gap' : 'continuity broken at'} ${sig(value as number)} (limit ${sig(limit as number)})`,
    });
  };
  creaseKnots(surface.knotsU, surface.multiplicitiesU, surface.degreeU).forEach((knot, k) => check('u', knot, k));
  creaseKnots(surface.knotsV, surface.multiplicitiesV, surface.degreeV).forEach((knot, k) => check('v', knot, 100 + k));
  return findings;
}

const sidesOf = (surface: NurbsSurfaceData): Array<{ side: PatchSide; curve: ReturnType<typeof sideEdge>['curve']; points: Vec3[] }> =>
  PATCH_SIDES.map((side) => {
    const edge = sideEdge(surface, side);
    const points = Array.from({ length: 5 }, (_, k) =>
      evaluateCurve(edge.curve, edge.interval[0] + ((edge.interval[1] - edge.interval[0]) * k) / 4),
    );
    return { side, curve: edge.curve, points };
  });

/**
 * @affects none; data = { status, findings [{ code, severity, entityId, edgeIndex?, value, limit, unit, worst, remediation, message }], counts, tolerances, checked, skipped, notChecked, unverified, reviewRequired, reviewReason?, unit, provenance }
 * @invariant status "fail" when a finding of severity fail exists, else "warn" when a warning exists, else "pass"; defaulted tolerances are named
 * @failure unknown id -> SRF_ENTITY_NOT_FOUND; bad tolerance / require / grid -> SRF_PARAM_INVALID
 */
export const checkSurfaceQuality = defineCommand({
  name: 'check_surface_quality',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only quality report on nurbs_surface sheets (all of them, or `ids`): one call, numbers and coded findings, no picture. Checks: (1) continuity ' +
    'ACROSS the interior knot lines of each sheet (a crease where the parametric continuity is low) down to the `require` level (G0 position, G1 tangent ' +
    'angle, G2 curvature, G3 curvature rate; default G1, G2 for purpose "release"), measured with the analysis engine of check_continuity; (2) free ' +
    'edges: sheet edges that no other selected sheet shares within `sewing` - a failure when `expectSolid` is true, otherwise informational; (3) with ' +
    '`pullDirection`, draft below `minDraftDeg` or undercuts (see analyze_draft); (4) degenerate samples (poles). Every finding has a stable `code`, ' +
    'severity, entityId, edgeIndex (0..: u knot lines, 100..: v knot lines; free edges 0..3 = u0, u1, v0, v1), value, limit, unit, worst point and a remediation. ' +
    '`status` is "fail", "warn" or "pass". Tolerances you do not give are defaulted and NAMED in `tolerances` with a warning. `purpose` "release" sets ' +
    '`reviewRequired` true: the figures are computed by llull and not approved - a qualified engineer must review them. Not covered here: lofts / wings ' +
    '(section deviation needs the section data) and B-rep faces of the native kernel. Solids and curves in `ids` are listed in `skipped`.',
  params: z.object({
    ids: z.array(z.string()).describe('nurbs_surface ids to check (1..200). Omit to check every nurbs_surface of the document.').optional(),
    purpose: z
      .enum(['design', 'release'])
      .describe('"design" (default) or "release" (stricter default level, marks the report as needing human review).')
      .optional(),
    require: z
      .enum(['G0', 'G1', 'G2', 'G3'])
      .describe('Continuity every interior knot line must reach. Default "G1" for design, "G2" for release.')
      .optional(),
    g0: z.number().describe('Largest position gap still G0, document units (> 0). Default 1e-6 x the size of the sheet.').optional(),
    g1AngleRad: z.number().describe('Largest angle still G1, radians (> 0). Default 0.01.').optional(),
    g2Rel: z.number().describe('Largest relative curvature jump still G2 (> 0). Default 0.1.').optional(),
    g3Rel: z.number().describe('Largest relative jump of the curvature rate still G3 (> 0). Default 0.1.').optional(),
    sewing: z
      .number()
      .describe('Distance (document units, > 0) within which two sheet edges count as shared. Default 1e-6 x the size of the sheets.')
      .optional(),
    expectSolid: z.boolean().describe('The sheets are meant to close a shell: free edges become failures. Default false.').optional(),
    pullDirection: vec3('Optional mould pull direction [x, y, z]: adds the draft check.').optional(),
    minDraftDeg: z
      .number()
      .describe('Smallest acceptable draft in degrees (-90..90) with `pullDirection`. Default 0 (undercuts only).')
      .optional(),
    samples: z.number().describe('Samples along each interior knot line, integer 3..101. Default 11.').optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { purpose = 'design', pullDirection, minDraftDeg = 0, samples = 11, expectSolid = false } = params;
    const require: Level = params.require ?? (purpose === 'release' ? 'G2' : 'G1');
    const invalid = (message: string, path: string, ids: string[] = []): CommandResult =>
      refuseSrf(doc, 'check_surface_quality', 'SRF_PARAM_INVALID', message, ids, [`params.${path}`]);
    for (const name of ['g0', 'g1AngleRad', 'g2Rel', 'g3Rel', 'sewing'] as const)
      if (params[name] !== undefined && !((params[name] as number) > 0)) return invalid(`${name} must be > 0`, name);
    if (!(Number.isInteger(samples) && samples >= 3 && samples <= 101))
      return invalid(`samples must be an integer in 3..101 (got ${samples})`, 'samples');
    if (!(minDraftDeg >= -90 && minDraftDeg <= 90))
      return invalid(`minDraftDeg must be within -90..90 (got ${minDraftDeg})`, 'minDraftDeg');
    if (pullDirection !== undefined && !(len3(pullDirection as Vec3) > 0))
      return invalid('pullDirection must be non-zero', 'pullDirection');
    const requested = params.ids;
    if (requested !== undefined && (requested.length === 0 || requested.length > 200)) return invalid('ids needs 1..200 entries', 'ids');
    const ids = requested ?? doc.order.filter((id) => doc.entities[id]?.kind === 'nurbs_surface');
    const sheets: NurbsSurfaceEntity[] = [];
    const skipped: Array<{ id: string; kind: string }> = [];
    for (const id of ids) {
      const entity = doc.entities[id];
      if (entity === undefined)
        return refuseSrf(doc, 'check_surface_quality', 'SRF_ENTITY_NOT_FOUND', `no entity "${id}"`, [id], ['params.ids']);
      if (entity.kind === 'nurbs_surface') sheets.push(entity);
      else skipped.push({ id, kind: entity.kind });
    }
    const unit = doc.units;
    const placed = sheets.map(placedSurface);
    const size = Math.max(
      ...placed.map(surfacePoleExtent).flatMap(({ min, max }) => [max[0] - min[0], max[1] - min[1], max[2] - min[2]]),
      1e-9,
    );
    const named = (
      value: number | undefined,
      fallback: number,
      name: string,
      source: string,
      toleranceUnit: string,
    ): { value: number; unit: string; source: string; defaulted: boolean } => ({
      value: value ?? fallback,
      unit: toleranceUnit,
      source: value === undefined ? source : `given: ${name}`,
      defaulted: value === undefined,
    });
    const tolerances = {
      g0: named(params.g0, 1e-6 * size, 'g0', '1e-6 x the size of the sheets', unit),
      g1AngleRad: named(params.g1AngleRad, 0.01, 'g1AngleRad', 'llull default (OCC LocalAnalysis angle tolerance)', 'rad'),
      g2Rel: named(params.g2Rel, 0.1, 'g2Rel', 'llull default (10 % relative curvature jump)', 'relative'),
      g3Rel: named(params.g3Rel, 0.1, 'g3Rel', 'llull default (10 % relative curvature-rate jump)', 'relative'),
      sewing: named(params.sewing, 1e-6 * size, 'sewing', '1e-6 x the size of the sheets', unit),
    };
    const tol: ContinuityTolerances = {
      g0: tolerances.g0.value,
      g1AngleRad: tolerances.g1AngleRad.value,
      g2Rel: tolerances.g2Rel.value,
      g2Abs: 1e-9,
      g3Rel: tolerances.g3Rel.value,
    };
    const engine = resolveSurfaceAnalysis((ctx ?? currentContext()).surfaceAnalysis);
    const findings: Finding[] = [];
    sheets.forEach((entity, index) =>
      findings.push(...knotFindings(entity, placed[index] as NurbsSurfaceData, engine, tol, require, samples, unit)),
    );
    if (sheets.length > 0 && sheets.length <= MAX_SHEETS_FOR_EDGES) {
      const all = placed.map(sidesOf);
      sheets.forEach((entity, i) =>
        (all[i] as ReturnType<typeof sidesOf>).forEach((own, sideIndex) => {
          const length = Math.max(
            ...own.points.map((p) =>
              len3([p[0] - (own.points[0] as Vec3)[0], p[1] - (own.points[0] as Vec3)[1], p[2] - (own.points[0] as Vec3)[2]]),
            ),
          );
          if (length <= tolerances.sewing.value) return;
          const shared = all.some((sides, j) =>
            sides.some((other, k) => {
              if (i === j && k === sideIndex) return false;
              return (
                own.points.every((p) => closestOnCurve(other.curve, p).distance <= tolerances.sewing.value) &&
                other.points.every((p) => closestOnCurve(own.curve, p).distance <= tolerances.sewing.value)
              );
            }),
          );
          if (shared) return;
          findings.push({
            code: 'SRF_CHECK_FREE_EDGES',
            severity: expectSolid ? 'fail' : 'info',
            entityId: entity.id,
            edgeIndex: sideIndex,
            value: 1,
            limit: 0,
            unit: 'free edges',
            worst: { point: sigVec(own.points[2] as Vec3) },
            remediation: REMEDIATION['SRF_CHECK_FREE_EDGES'] as string,
            message: `edge ${own.side} is not shared with another selected sheet within ${sig(tolerances.sewing.value)} ${unit}`,
          });
        }),
      );
    }
    if (pullDirection !== undefined)
      sheets.forEach((entity, index) => {
        const draft = engine.draft({
          shape: { type: 'surface', surface: placed[index] as NurbsSurfaceData },
          pull: pullDirection as Vec3,
          minDraftDeg,
          grid: 20,
          flip: false,
        });
        if (draft.areaBelowMin > 0 || draft.undercutArea > 0) {
          const worst = draft.samples.reduce((a, b) => (b.draftDeg < a.draftDeg ? b : a));
          findings.push({
            code: 'SRF_CHECK_DRAFT_BELOW_MIN',
            severity: 'fail',
            entityId: entity.id,
            value: sig(draft.minDeg),
            limit: minDraftDeg,
            unit: 'deg',
            worst: { point: sigVec(worst.point) },
            remediation: REMEDIATION['SRF_CHECK_DRAFT_BELOW_MIN'] as string,
            message: `${sig(draft.areaBelowMin)} ${unit}^2 below ${minDraftDeg} deg (undercut ${sig(draft.undercutArea)} ${unit}^2), minimum ${sig(draft.minDeg)} deg`,
          });
        }
      });
    sheets.forEach((entity, index) => {
      const [[u0, u1], [v0, v1]] = surfaceDomain(placed[index] as NurbsSurfaceData);
      let degenerate = 0;
      let at: Vec3 = [0, 0, 0];
      for (let i = 0; i <= 8; i++)
        for (let j = 0; j <= 8; j++) {
          const sample = surfaceSample(placed[index] as NurbsSurfaceData, u0 + ((u1 - u0) * i) / 8, v0 + ((v1 - v0) * j) / 8);
          if (sample.degenerate) {
            degenerate++;
            at = sample.point;
          }
        }
      if (degenerate > 0)
        findings.push({
          code: 'SRF_CHECK_DEGENERATE_SAMPLES',
          severity: 'warn',
          entityId: entity.id,
          value: degenerate,
          limit: 0,
          unit: 'samples of 81',
          worst: { point: sigVec(at) },
          remediation: REMEDIATION['SRF_CHECK_DEGENERATE_SAMPLES'] as string,
          message: `${degenerate} of 81 grid samples are singular (a pole or collapsed edge)`,
        });
    });
    for (const [name, entry] of Object.entries(tolerances))
      if (entry.defaulted && (name !== 'g3Rel' || LEVELS.indexOf(require) >= 3) && (name !== 'sewing' || sheets.length > 1 || expectSolid))
        findings.push({
          code: 'SRF_CHECK_TOLERANCE_DEFAULTED',
          severity: 'warn',
          entityId: '',
          value: sig(entry.value),
          limit: sig(entry.value),
          unit: entry.unit,
          worst: { point: [0, 0, 0] },
          remediation: REMEDIATION['SRF_CHECK_TOLERANCE_DEFAULTED'] as string,
          message: `${name} = ${sig(entry.value)} ${entry.unit} was taken from the default (${entry.source})`,
        });
    const shown = findings.slice(0, MAX_FINDINGS);
    const failed = findings.some((finding) => finding.severity === 'fail');
    const status = failed ? 'fail' : findings.some((finding) => finding.severity === 'warn') ? 'warn' : 'pass';
    const reviewRequired = purpose === 'release';
    const counts = { fail: 0, warn: 0, info: 0 };
    for (const finding of findings) counts[finding.severity]++;
    const data = {
      status,
      purpose,
      require,
      findings: shown,
      truncated: findings.length > shown.length,
      counts,
      tolerances,
      checked: sheets.map((sheet) => sheet.id),
      skipped,
      notChecked: [
        'section deviation of lofts / wings (needs the loft sections)',
        'B-rep faces and edges (native kernel)',
        'waivers (human approval workflow)',
      ],
      unverified: false,
      reviewRequired,
      ...(reviewRequired ? { reviewReason: 'release purpose: the figures are computed by llull and are not approved' } : {}),
      unit,
      engine: engine.provenance.engine,
      provenance: {
        method:
          'continuity of the sub-patches either side of each interior knot line (analysis engine), shared-edge matching by foot-point distance, draft and singular-sample checks',
        reference: 'check_continuity / analyze_draft machinery; Farin, Curves and Surfaces for CAGD',
        inputs: { ids: sheets.map((sheet) => sheet.id), require, samples },
      },
    };
    return report(
      doc,
      `check_surface_quality: ${sheets.length} sheet(s), ${counts.fail} failure(s), ${counts.warn} warning(s), ${counts.info} note(s) -> ${status.toUpperCase()}.` +
        (reviewRequired ? ' Computed by llull, not approved: needs a qualified engineer.' : ''),
      data,
    );
  },
});
