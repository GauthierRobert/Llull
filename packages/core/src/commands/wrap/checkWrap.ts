/** check_wrap — audit wrapped curves and embossed solids: distortion against a named limit, volume against the closed form, depth, font provenance (03 WRP M3). */

import type { CadDocument, Entity, FeatureStep, Vec2 } from '../../model/types';
import type { UvLoop } from '../../model/wrap';
import { segmentLength } from '../../geometry/planeSegments';
import { mapCurve2 } from '../../lib/nurbs/curve2d';
import { curveDomain } from '../../lib/nurbs/evaluate';
import { integrateCurve } from '../../lib/nurbs/integrate';
import { embossClosedForm } from '../../geometry/embossVolume';
import { footprintPerimeter } from '../../geometry/embossPerimeter';
import { embossNodes } from '../../geometry/embossRecipe';
import { recipeOf } from '../../geometry/shapeRecipe';
import { defineCommand, z } from '../schema';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { currentContext } from '../context';
import { wrapRejection, WRAP_REMEDIATION } from './codes';
import { DEFAULT_MAX_LENGTH_STRAIN, MAX_LENGTH_STRAIN_SOURCE, wrapData } from './conventions';
import { isFontFailure, loadFont } from './fontStore';
import { kernelVolume } from './embossRun';

/** Largest relative disagreement between the kernel volume change and the closed form (an internal-consistency guard, TECHNICAL_SPEC §5.3). */
const VOLUME_TOLERANCE = 1e-6;
/** Ceiling of the guard for fitted footprints: a larger fit tolerance cannot widen it beyond 0.1 % of the closed-form volume. */
const MAX_VOLUME_ALLOWANCE = 1e-3;
const MAX_IDS = 2000;

interface Finding {
  readonly code: string;
  readonly severity: 'fail' | 'warn';
  readonly ids: readonly string[];
  readonly value: number | string | null;
  readonly limit: number | string | null;
  readonly unit: string;
  readonly remediation: string;
}

const finding = (
  code: string,
  severity: Finding['severity'],
  ids: readonly string[],
  value: Finding['value'],
  limit: Finding['limit'],
  unit: string,
): Finding => ({ code, severity, ids, value, limit, unit, remediation: WRAP_REMEDIATION[code] ?? 'see the command description' });

/** The wrap-making step that produced or last changed `id`. */
function stepOf(doc: CadDocument, id: string): FeatureStep | undefined {
  return [...doc.featureHistory]
    .reverse()
    .find(
      (step) =>
        (step.affected ?? []).includes(id) &&
        (step.name === 'wrap_to_face' || step.name === 'emboss_on_face' || step.name === 'project_to_face'),
    );
}

/** Text entities (with their font verification) the step's sketch ids refer to. */
function textsOf(doc: CadDocument, step: FeatureStep | undefined): Array<Extract<Entity, { kind: 'text' }>> {
  const params = step?.params as { entityIds?: unknown; profileIds?: unknown } | undefined;
  const ids = [params?.entityIds, params?.profileIds]
    .flatMap((list) => (Array.isArray(list) ? list : []))
    .filter((id): id is string => typeof id === 'string');
  return ids.flatMap((id) => {
    const entity = doc.entities[id];
    return entity?.kind === 'text' && entity.font !== undefined ? [entity] : [];
  });
}

/**
 * The step that made `id` as a relief with no closed-form volume: emboss_on_face with pull walls (straight or drafted), or add_knurl with geometry (grooves cut by plain booleans). The
 * direction of its volume change is +1 (material added) or -1 (removed).
 */
function reliefOf(doc: CadDocument, id: string): { readonly direction: 1 | -1 } | undefined {
  const step = [...doc.featureHistory]
    .reverse()
    .find(
      (candidate) => (candidate.affected ?? []).includes(id) && (candidate.name === 'emboss_on_face' || candidate.name === 'add_knurl'),
    );
  const params = step?.params as { walls?: unknown; model?: unknown; mode?: unknown } | undefined;
  if (step?.name === 'emboss_on_face' && params?.walls === 'pull') return { direction: params.mode === 'emboss' ? 1 : -1 };
  if (step?.name === 'add_knurl' && params?.model === 'geometry') return { direction: -1 };
  return undefined;
}

const isWrapResult = (doc: CadDocument, entity: Entity): boolean =>
  (entity.kind === 'nurbs_curve' && entity.onFace !== undefined) ||
  (entity.kind === 'mesh' &&
    entity.brep !== undefined &&
    (embossNodes(recipeOf(entity)).length > 0 || reliefOf(doc, entity.id) !== undefined));

/**
 * @affects none (read-only)
 * @invariant fails only on a number against a limit (the named default maxLengthStrain 0.02 is reported as defaulted, never silently); `unverified` is true when a font behind a result is not pinned
 * @failure unknown id -> WRP_ENTITY_NOT_FOUND refusal
 */
export const checkWrap = defineCommand({
  name: 'check_wrap',
  description:
    'Audit the results of wrap_to_face, project_to_face and emboss_on_face. For every wrapped curve it compares the 3D length with the sketch length (relative length strain against ' +
    '`maxLengthStrain`, default 0.02 and reported as a defaulted limit); for every embossed solid it compares the exact kernel volume change with the closed form (relative difference ' +
    '1e-6; a cone, sphere or torus footprint is a fitted curve, so 2 x the construction tolerance x perimeter / area is added, capped at 1e-3; limits.volumeAllowance reports the guard applied), checks the deboss depth against the face radius and, with `minFeatureSize`, the stroke width of the profiles. Fonts that are not pinned (import_font without sourceSha256) ' +
    'make the result `unverified`; characters a font lacks are warned. Returns data { status: pass | warn | fail, findings[{ code, severity, ids, value, limit, unit, remediation }], limits, ' +
    'unverified, provenance }. `ids` default to every wrapped curve and embossed solid. Pull-wall reliefs (emboss_on_face walls pull, drafted or not) and geometry knurls have no closed form: they are counted in checked.volumesSkipped and reliefsWithoutClosedForm with a WRP_CHECK_VOLUME_SKIPPED warning, and only the direction of the volume change (emboss adds, deboss and knurl remove) is checked. Next: fix the cause named by the finding code (WRP_CHECK_DISTORTION, WRP_CHECK_VOLUME_MISMATCH, WRP_CHECK_VOLUME_SKIPPED, ' +
    'WRP_CHECK_DEPTH, WRP_CHECK_THIN_FEATURE, WRP_CHECK_FONT_UNVERIFIED, WRP_CHECK_GLYPH_MISSING, WRP_CHECK_LIMIT_DEFAULTED). With minFeatureSize, an embossed solid on a cone, sphere or torus is not checked for stroke width: WRP_CHECK_STROKE_SKIPPED (warn) counts them.',
  params: z.object({
    ids: z
      .array(z.string())
      .max(MAX_IDS)
      .optional()
      .describe('Ids of wrapped curves or embossed solids to check. Default: every one in the document.'),
    maxLengthStrain: z
      .number()
      .positive()
      .optional()
      .describe(
        'Largest accepted relative length change of a wrapped curve (1 = 100 %). Default 0.02 (named default: a WRP_CHECK_LIMIT_DEFAULTED warning is added).',
      ),
    minFeatureSize: z
      .number()
      .positive()
      .optional()
      .describe(
        'Smallest stroke width the process can make, document units. No default: the stroke check runs only when you name the process limit.',
      ),
  }),
  annotations: { readsMeshTriangles: true, readOnly: true },
  run: (doc, params, ctx): CommandResult => {
    const targets = params.ids ?? doc.order.filter((id) => doc.entities[id] !== undefined && isWrapResult(doc, doc.entities[id] as Entity));
    for (const [index, id] of targets.entries()) {
      const entity = doc.entities[id];
      if (entity === undefined)
        return wrapRejection(doc, 'check_wrap', 'WRP_ENTITY_NOT_FOUND', `entity '${id}' not found`, [id], [`ids.${index}`]);
    }
    const limit = params.maxLengthStrain ?? DEFAULT_MAX_LENGTH_STRAIN;
    const findings: Finding[] = [];
    const kernel = (ctx ?? currentContext()).kernel;
    let unverified = false;
    let checkedVolumes = 0;
    let skippedVolumes = 0;
    let reliefs = 0;
    let largestAllowance = VOLUME_TOLERANCE;
    let skippedStrokeChecks = 0;
    let curves = 0;
    for (const id of targets) {
      const entity = doc.entities[id] as Entity;
      if (entity.kind === 'nurbs_curve' && entity.onFace !== undefined) {
        curves += 1;
        const [first, last] = curveDomain(entity.curve);
        const length3d = integrateCurve(entity.curve, first, last, (_point, derivative) =>
          Math.hypot(derivative[0], derivative[1], derivative[2]),
        );
        const strain = entity.onFace.chartLength > 0 ? length3d / entity.onFace.chartLength - 1 : 0;
        if (Math.abs(strain) > limit) findings.push(finding('WRP_CHECK_DISTORTION', 'fail', [id], strain, limit, '1'));
      }
      if (entity.kind === 'mesh' && entity.brep !== undefined) {
        for (const node of embossNodes(recipeOf(entity))) {
          const closed = embossClosedForm(node);
          if (node.mode === 'deboss' && node.surface.type !== 'plane') {
            const { type, data } = node.surface;
            const radius = type === 'cylinder' || type === 'sphere' ? (data[9] as number) : type === 'torus' ? (data[10] as number) : null;
            if (radius !== null && node.depth >= radius)
              findings.push(finding('WRP_CHECK_DEPTH', 'fail', [id], node.depth, radius, doc.units));
          }
          if (params.minFeatureSize !== undefined && closed !== null && node.mode !== 'scribe') {
            const lengthScale = node.surface.type === 'cylinder' ? (node.surface.data[9] as number) : 1;
            const perimeter = node.regions.reduce(
              (sum, region) => sum + [region.outer, ...region.holes].reduce((inner, loop) => inner + loopLengthUv(loop, lengthScale), 0),
              0,
            );
            const flatFace = node.surface.type === 'plane' || node.surface.type === 'cylinder';
            const width = perimeter > 0 && flatFace ? (2 * closed.area) / perimeter : null;
            if (!flatFace) skippedStrokeChecks += 1;
            if (width !== null && width < params.minFeatureSize)
              findings.push(finding('WRP_CHECK_THIN_FEATURE', 'fail', [id], width, params.minFeatureSize, doc.units));
          }
          if (closed !== null && node.mode !== 'scribe' && kernel !== null) {
            const solid = kernel.evaluate(node);
            const base = kernel.evaluate(node.source);
            const after = solid === null ? null : kernelVolume({ kernel }, solid);
            const before = base === null ? null : kernelVolume({ kernel }, base);
            if (after !== null && before !== null) {
              checkedVolumes += 1;
              const mismatch = Math.abs(after - before - closed.delta) / Math.max(Math.abs(closed.delta), 1e-300);
              // cone, sphere and torus footprints are fitted curves: the kernel builds their edges to the recipe tolerance, which moves the boundary by that much
              const fitted = node.surface.type === 'cone' || node.surface.type === 'sphere' || node.surface.type === 'torus';
              const perimeter = fitted ? footprintPerimeter(node) : null;
              const allowed = Math.min(
                MAX_VOLUME_ALLOWANCE,
                VOLUME_TOLERANCE + (perimeter === null || !(closed.area > 0) ? 0 : (2 * node.tolerance * perimeter) / closed.area),
              );
              largestAllowance = Math.max(largestAllowance, allowed);
              if (mismatch > allowed) findings.push(finding('WRP_CHECK_VOLUME_MISMATCH', 'fail', [id], mismatch, allowed, '1'));
            } else skippedVolumes += 1;
          } else if (closed !== null && node.mode !== 'scribe') skippedVolumes += 1;
        }
      }
      const relief = entity.kind === 'mesh' && entity.brep !== undefined ? reliefOf(doc, id) : undefined;
      if (relief !== undefined && entity.kind === 'mesh') {
        reliefs += 1;
        skippedVolumes += 1;
        const top = recipeOf(entity);
        const base = kernel === null || top.op !== 'boolean' ? null : kernel.evaluate(top.a);
        const solid = kernel === null ? null : kernel.evaluate(top);
        const before = kernel === null || base === null ? null : kernelVolume({ kernel }, base);
        const after = kernel === null || solid === null ? null : kernelVolume({ kernel }, solid);
        const change = before === null || after === null ? null : after - before;
        if (change !== null && relief.direction * change <= 0)
          findings.push(
            finding(
              'WRP_CHECK_VOLUME_MISMATCH',
              'fail',
              [id],
              change,
              relief.direction > 0 ? 'volume added' : 'volume removed',
              doc.units + '^3',
            ),
          );
        findings.push(
          finding(
            'WRP_CHECK_VOLUME_SKIPPED',
            'warn',
            [id],
            change === null ? 'direction not measured' : `volume change ${change}`,
            'no closed form (pull walls, draft, helical grooves): only the direction is checked',
            'doc units^3',
          ),
        );
      }
      const texts = textsOf(doc, stepOf(doc, id));
      for (const text of texts) {
        const loaded = loadFont(doc, text.font as string);
        if (isFontFailure(loaded)) continue;
        if (!loaded.record.provenance.verified) {
          unverified = true;
          findings.push(finding('WRP_CHECK_FONT_UNVERIFIED', 'warn', [id, text.id], loaded.record.blob, 'pinned sha256', 'sha256'));
        }
        const unmapped = [
          ...new Set([...text.content].filter((c) => c.trim().length > 0 && loaded.font.glyphIndex(c.codePointAt(0) as number) === 0)),
        ];
        if (unmapped.length > 0)
          findings.push(
            finding('WRP_CHECK_GLYPH_MISSING', 'warn', [id, text.id], unmapped.join(''), 'all characters mapped', 'characters'),
          );
      }
    }
    if (params.maxLengthStrain === undefined && targets.length > 0)
      findings.push(finding('WRP_CHECK_LIMIT_DEFAULTED', 'warn', [...targets], limit, limit, '1'));
    if (skippedStrokeChecks > 0)
      findings.push(finding('WRP_CHECK_STROKE_SKIPPED', 'warn', [...targets], skippedStrokeChecks, 'plane or cylinder', 'embossed solids'));
    const status = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass';
    const data = wrapData(
      doc,
      {
        status,
        findings,
        checked: {
          ids: targets.length,
          curves,
          volumes: checkedVolumes,
          volumesSkipped: skippedVolumes,
          reliefsWithoutClosedForm: reliefs,
          ...(params.minFeatureSize === undefined ? {} : { strokeChecksSkipped: skippedStrokeChecks }),
        },
        limits: {
          maxLengthStrain: {
            value: limit,
            unit: '1',
            source: params.maxLengthStrain === undefined ? MAX_LENGTH_STRAIN_SOURCE : 'caller',
            defaulted: params.maxLengthStrain === undefined,
          },
          volumeTolerance: { value: VOLUME_TOLERANCE, unit: '1', source: 'llull WRP internal-consistency guard', defaulted: true },
          volumeAllowance: {
            value: largestAllowance,
            unit: '1',
            source: `largest guard applied: ${VOLUME_TOLERANCE} plus, for cone / sphere / torus footprints (fitted edges), 2 x construction tolerance x perimeter / area, capped at ${MAX_VOLUME_ALLOWANCE}`,
            defaulted: true,
          },
          ...(params.minFeatureSize === undefined
            ? {}
            : { minFeatureSize: { value: params.minFeatureSize, unit: doc.units, source: 'caller', defaulted: false } }),
        },
      },
      {
        unverified,
        provenance: { method: 'length strain of wrapped curves, closed-form volume of embossed regions', inputs: { ids: targets } },
      },
    );
    const failed = findings.filter((f) => f.severity === 'fail').map((f) => f.code);
    return report(
      doc,
      `check_wrap: ${status} — ${targets.length} result(s) checked (${curves} curve(s), ${checkedVolumes} emboss volume(s))${failed.length > 0 ? `; failing: ${[...new Set(failed)].join(', ')}` : ''}${unverified ? '; unverified font' : ''}.`,
      data,
    );
  },
});

/** Length of a (u, v) loop with u scaled by `uScale` (cylinder: the radius, so both axes are lengths). */
function loopLengthUv(loop: UvLoop, uScale: number): number {
  const scale = ([u, v]: Vec2): Vec2 => [u * uScale, v];
  let at = scale(loop.start);
  let total = 0;
  for (const segment of loop.segments) {
    if (segment.kind === 'line') {
      const to = scale(segment.to);
      total += segmentLength({ kind: 'line', from: at, to });
      at = to;
    } else {
      const curve = mapCurve2(segment.curve, scale);
      total += segmentLength({ kind: 'nurbs', curve });
      at = curve.poles[curve.poles.length - 1] as Vec2;
    }
  }
  return total;
}
