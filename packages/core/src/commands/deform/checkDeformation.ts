/** check_deformation — pass / warn / fail verdict of deformed bodies with coded findings (01 DEF M1, FR-DEF-22, AF-20). Read-only. */

import type { CadDocument, Entity } from '../../model/types';
import { JACOBIAN_FLOOR } from '../../geometry/deform/bounds';
import { findSelfIntersections } from '../../geometry/mesh/selfIntersection';
import { weldMesh } from '../../geometry/mesh/weld';
import { isClosedMesh, openEdgeCount } from '../../geometry/meshClosure';
import { MESH_TS_TRIANGLE_CAP } from '../../geometry/mesh/engineTypes';
import { defineCommand, z } from '../schema';
import { currentContext } from '../context';
import { report } from '../noop';
import type { CommandResult } from '../types';
import { type DeformAnalysis, analyzeDeformed } from './analysis';
import { defRejection } from './codes';
import { deformNodeOf } from './sourceMesh';

type Severity = 'fail' | 'warn';

interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly ids: readonly string[];
  readonly value: number;
  readonly limit: number;
  readonly unit: string;
  readonly message: string;
  readonly remediation: string;
}

/** Named default tolerances (01 DEF §5.9). */
const CREASE_RAD = 0.01;
/** Exact path: the adaptive mass rule of the native kernel reaches 1e-7 on the pack bodies (spec 1e-4). */
const DRIFT_EXACT = 1e-4;
const DRIFT_MESH = 5e-3;

function finding(partial: Omit<Finding, 'ids'>, id: string): Finding {
  return { ...partial, ids: [id] };
}

/** Self-intersecting triangle pairs of a stored mesh (null when it is above the TypeScript cap). */
function crossings(entity: Entity): number | null {
  if (entity.kind !== 'mesh') return null;
  const welded = weldMesh(entity.mesh, 1e-7);
  if (welded.triangles.length / 3 > MESH_TS_TRIANGLE_CAP) return null;
  return findSelfIntersections(welded.positions, welded.triangles, 1).count;
}

interface Limits {
  readonly approx: number | undefined;
  readonly volumeDriftRel: number | undefined;
  readonly creaseRad: number | undefined;
}

function findingsOf(id: string, entity: Entity, analysis: DeformAnalysis, unit: string, limits: Limits): Finding[] {
  const found: Finding[] = [];
  const { sampled, range } = analysis;
  // the vertex samples miss a fold sitting between vertices or exactly on a region end: the closed form over the body extent covers it
  const worst = range.min < sampled.min ? { value: range.min, at: range.minAt } : { value: sampled.min, at: sampled.minAt };
  if (worst.value <= JACOBIAN_FLOOR) {
    found.push(
      finding(
        {
          code: 'DEF_CHECK_FOLDOVER',
          severity: 'fail',
          value: worst.value,
          limit: JACOBIAN_FLOOR,
          unit: 'det J',
          message: `the map folds the body: min det J ${worst.value.toPrecision(6)} at [${worst.at.map((v) => v.toPrecision(5)).join(', ')}]`,
          remediation: 'reduce the parameter of the deformation (see the DEF_FOLDOVER / DEF_BEND_RADIUS_TOO_SMALL limit) and re-run it',
        },
        id,
      ),
    );
  }
  const pairs = crossings(entity);
  if (pairs !== null && pairs > 0)
    found.push(
      finding(
        {
          code: 'DEF_CHECK_SELF_INTERSECTION',
          severity: 'fail',
          value: pairs,
          limit: 0,
          unit: 'pairs',
          message: `${pairs} triangle pair(s) of the result cross each other`,
          remediation: 'reduce the angle or extent of the deformation',
        },
        id,
      ),
    );
  if (entity.kind === 'mesh' && !isClosedMesh(entity.mesh))
    found.push(
      finding(
        {
          code: 'DEF_CHECK_NOT_CLOSED',
          severity: 'fail',
          value: openEdgeCount(entity.mesh, 0),
          limit: 0,
          unit: 'edges',
          message: 'the result mesh has open edges',
          remediation: 'check_mesh purpose=boolean names the defect; re-run the deformation with a smaller parameter',
        },
        id,
      ),
    );
  const approxLimit = limits.approx ?? analysis.node.output.tolerance * (1 + 1e-9);
  if (analysis.approximationError !== null && analysis.approximationError > approxLimit)
    found.push(
      finding(
        {
          code: 'DEF_CHECK_APPROX_ERROR',
          severity: 'fail',
          value: analysis.approximationError,
          limit: approxLimit,
          unit,
          message: `chordal deviation ${analysis.approximationError.toPrecision(4)} ${unit} > ${approxLimit.toPrecision(4)} ${unit}`,
          remediation: 'lower output.tolerance and re-run the deformation',
        },
        id,
      ),
    );
  const driftLimit = limits.volumeDriftRel ?? (analysis.path === 'exact' ? DRIFT_EXACT : DRIFT_MESH);
  if (analysis.volume.driftRel > driftLimit)
    found.push(
      finding(
        {
          code: 'DEF_CHECK_VOLUME_DRIFT',
          severity: 'fail',
          value: analysis.volume.driftRel,
          limit: driftLimit,
          unit: 'relative',
          message: `measured volume ${analysis.volume.measured.toPrecision(8)} differs from the predicted ${analysis.volume.predicted.toPrecision(8)} ${unit}^3`,
          remediation: 'lower output.tolerance and re-run the deformation',
        },
        id,
      ),
    );
  const creaseLimit = limits.creaseRad ?? CREASE_RAD;
  const creaseWorst = analysis.creases.filter((crease) => crease.present).reduce((max, crease) => Math.max(max, crease.angleRad), 0);
  if (creaseWorst > creaseLimit)
    found.push(
      finding(
        {
          code: 'DEF_CHECK_REGION_CREASE',
          severity: 'warn',
          value: creaseWorst,
          limit: creaseLimit,
          unit: 'rad',
          message: `a linear ramp leaves a ${creaseWorst.toPrecision(4)} rad crease at a region end`,
          remediation: 'use falloff "smooth"',
        },
        id,
      ),
    );
  if (analysis.path === 'mesh')
    found.push(
      finding(
        {
          code: 'DEF_CHECK_MESH_RESULT',
          severity: 'warn',
          value: entity.kind === 'mesh' ? entity.mesh.indices.length / 3 : 0,
          limit: 0,
          unit: 'triangles',
          message: 'the result is a faceted mesh, not an exact B-rep',
          remediation: 'use the native kernel with mode "exact" (every law of the deformation commands has an exact path there)',
        },
        id,
      ),
    );
  return found;
}

/**
 * @affects none (read-only); data = status, findings with codes / ids / value / limit / unit, named tolerances, unverified, reviewRequired, provenance
 * @invariant status is "fail" when any finding fails, "warn" when only warnings remain, else "pass"; the notes about the check itself
 *   (DEF_CHECK_TOLERANCE_DEFAULTED, DEF_CHECK_INPUT_UNVERIFIED) are listed but never change the status; purpose "release" on a mesh result sets reviewRequired
 * @failure unknown id -> DEF_ENTITY_NOT_FOUND; no deform node -> DEF_NOT_DEFORMED; source not rebuildable -> DEF_SOURCE_UNAVAILABLE
 */
export const checkDeformation = defineCommand({
  name: 'check_deformation',
  annotations: { readsMeshTriangles: true, readOnly: true },
  description:
    'Pass / warn / fail verdict for deformed bodies, with coded findings an agent can act on. Checked: fold-over (min det J <= 1e-6, DEF_CHECK_FOLDOVER), ' +
    'self-intersection and open edges of the result (DEF_CHECK_SELF_INTERSECTION, DEF_CHECK_NOT_CLOSED), chordal deviation above the tolerance ' +
    '(DEF_CHECK_APPROX_ERROR), the result volume against the volume predicted from det J (DEF_CHECK_VOLUME_DRIFT; independent proof the result is what the law describes), ' +
    'crease at a linear region end (DEF_CHECK_REGION_CREASE, warn), faceted mesh result (DEF_CHECK_MESH_RESULT, warn). Each finding has the entity id, the value and ' +
    'the limit with its unit, and the fix. data.tolerances lists every limit with its source (a named default is also reported as DEF_CHECK_TOLERANCE_DEFAULTED); ' +
    'data.unverified is true when an input is an unpinned imported mesh (DEF_CHECK_INPUT_UNVERIFIED, never suppressible). ' +
    'purpose "release" on a mesh result or unverified input sets data.reviewRequired with the reason. Lengths in document units. Read-only: end every deformation job with it.',
  params: z.object({
    ids: z
      .array(z.string())
      .max(100)
      .describe('Ids of the deformed mesh entities to check. Default: every entity whose recipe has a deform node.')
      .optional(),
    purpose: z
      .enum(['design', 'release'])
      .describe(
        '"design" (default): a faceted result is only a warning. "release": a faceted result or an unverified input also sets reviewRequired.',
      )
      .optional(),
    approx: z
      .number()
      .positive()
      .describe('Largest acceptable chordal deviation, document units. Default: the tolerance the deformation was run with.')
      .optional(),
    volumeDriftRel: z
      .number()
      .positive()
      .describe(
        'Largest acceptable relative difference between the result and predicted volume, unitless. Default 1e-4 for an exact result, 5e-3 for a mesh result.',
      )
      .optional(),
    creaseRad: z.number().positive().describe('Largest acceptable crease angle at a linear region end, radians. Default 0.01.').optional(),
  }),
  run: (doc: CadDocument, { ids, purpose = 'design', approx, volumeDriftRel, creaseRad }, ctx): CommandResult => {
    const targets = ids ?? doc.order.filter((id) => doc.entities[id] !== undefined && deformNodeOf(doc.entities[id] as Entity) !== null);
    const kernel = (ctx ?? currentContext()).kernel;
    const findings: Finding[] = [];
    const entities: Array<Record<string, unknown>> = [];
    const unverifiedIds: string[] = [];
    let meshResult = false;
    let firstTolerance: number | undefined;
    for (const id of targets) {
      const entity = doc.entities[id];
      if (entity === undefined)
        return defRejection(doc, 'check_deformation', 'DEF_ENTITY_NOT_FOUND', `entity '${id}' not found`, [id], ['params.ids']);
      const node = deformNodeOf(entity);
      if (node === null)
        return defRejection(
          doc,
          'check_deformation',
          'DEF_NOT_DEFORMED',
          `entity '${id}' (kind '${entity.kind}') has no deform node`,
          [id],
          ['params.ids'],
        );
      const analysis = analyzeDeformed(doc, entity, node, kernel);
      if ('code' in analysis) return defRejection(doc, 'check_deformation', analysis.code, analysis.message, [id], ['params.ids']);
      firstTolerance ??= node.output.tolerance;
      const own = findingsOf(id, entity, analysis, doc.units, { approx, volumeDriftRel, creaseRad });
      findings.push(...own);
      if (analysis.unverified) unverifiedIds.push(id);
      if (analysis.path === 'mesh') meshResult = true;
      entities.push({
        id,
        law: node.law.kind,
        path: analysis.path,
        status: own.some((f) => f.severity === 'fail') ? 'fail' : own.some((f) => f.severity === 'warn') ? 'warn' : 'pass',
        jacobianMin: analysis.sampled.min,
        volumeDriftRel: analysis.volume.driftRel,
      });
    }
    const tolerances: Array<Record<string, unknown>> = [];
    const named = (name: string, value: number | undefined, unit: string, given: number | undefined, source: string): void => {
      tolerances.push({
        name,
        value: given ?? value,
        unit,
        source: given === undefined ? source : 'caller',
        defaulted: given === undefined,
      });
    };
    named('approx', firstTolerance, doc.units, approx, 'the tolerance the deformation was run with');
    named('volumeDriftRel', meshResult ? DRIFT_MESH : DRIFT_EXACT, 'relative', volumeDriftRel, 'llull DEF default, TECHNICAL_SPEC §5.9');
    named('creaseRad', CREASE_RAD, 'rad', creaseRad, 'llull DEF default, TECHNICAL_SPEC §5.9');
    const notes: Finding[] = [];
    const defaulted = tolerances.filter((entry) => entry['defaulted'] === true).map((entry) => String(entry['name']));
    if (defaulted.length > 0 && targets.length > 0)
      notes.push({
        code: 'DEF_CHECK_TOLERANCE_DEFAULTED',
        severity: 'warn',
        ids: [...targets],
        value: defaulted.length,
        limit: 0,
        unit: 'tolerances',
        message: `${defaulted.join(', ')} used the named default`,
        remediation: 'pass the tolerance to state it',
      });
    if (unverifiedIds.length > 0)
      notes.push({
        code: 'DEF_CHECK_INPUT_UNVERIFIED',
        severity: 'warn',
        ids: unverifiedIds,
        value: unverifiedIds.length,
        limit: 0,
        unit: 'meshes',
        message: 'an input mesh has no pinned source sha256',
        remediation: 'import with sourceSha256 set to the file hash',
      });
    const status = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.some((f) => f.severity === 'warn') ? 'warn' : 'pass';
    const reasons = [
      ...(meshResult ? ['release of a faceted mesh result: a person must confirm the mesh is acceptable'] : []),
      ...(unverifiedIds.length > 0 ? ['release of a body built from an unverified input mesh'] : []),
    ];
    const reviewReason = purpose === 'release' && reasons.length > 0 ? reasons.join('; ') : undefined;
    const data = {
      purpose,
      status,
      findings: [...findings, ...notes],
      entities,
      tolerances,
      unverified: unverifiedIds.length > 0,
      reviewRequired: reviewReason !== undefined,
      ...(reviewReason === undefined ? {} : { reviewReason }),
      unit: doc.units,
      provenance: {
        method: 'analyze_deformation per entity, then coded thresholds',
        kernel: kernel?.name ?? null,
        reference: 'Barr 1984; 01 DEF TECHNICAL_SPEC §5.9, §5.10',
      },
      ids: targets,
    };
    const codes = [...new Set(findings.map((f) => f.code))];
    return report(
      doc,
      `check_deformation purpose=${purpose}: ${status.toUpperCase()} for ${targets.length} deformed body(ies)${codes.length > 0 ? ` — ${codes.join(', ')}` : ''}${unverifiedIds.length > 0 ? '; input unverified (no pinned sha256)' : ''}${reviewReason === undefined ? '' : '; review required'}.`,
      data,
    );
  },
});
