/**
 * check_blends v1 (BLD M0, TECHNICAL_SPEC §4, §5.9): numeric G0 / G1 / G2 measurements at the contact lines of the fillets of a solid,
 * from the kernel's exact face queries, plus validity. Numbers and coded findings instead of a zebra render.
 */

import { hasFillet, blendSource, measureContact } from '../../geometry/blend/continuity';
import type { GeometryKernel } from '../../geometry/kernel';
import type { Entity, ShapeRecipe } from '../../model/types';
import { roundSignificant } from '../../lib/significant';
import { currentContext } from '../context';
import { noop, report, tableRejection } from '../noop';
import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { diagonalOf } from './shapeDiagonal';
import { recordsByFace } from './blendChains';
import { judgeJunction, junctionsOf, supportCrease } from './blendJunctions';
import { CORNER_G0_FACTOR, PROFILE_G0_FACTOR, namedTolerances, withBlendScaleFloor } from './checkBlendTolerances';
import { checkCornerPatches, roundContact } from './checkBlendStars';
import { blendFaceContacts } from '../../geometry/blend/blendInfo';
import { REMEDIATION, cliffFinding, contactFindings, statusOf, type Finding, type Tolerances } from './checkBlendFindings';
import { RADIUS_LAW_TOLERANCE, checkRadius, lawIndex } from './checkBlendRadius';
import { cliffEdgeOf } from '../../geometry/blend/cliffEdge';
import { readChamferLegs } from './checkChamferLegs';
import { chamferNodes, legFilletNodes } from '../../geometry/blend/blendInfo';
import type { BlendRow, Contact, EntityCheck } from './checkBlendRows';

const sig = (value: number): number => roundSignificant(value, 10);

const refuse = tableRejection({
  SRF_ENTITY_NOT_FOUND:
    'pass ids of solids that carry a blend (fillet_edge, fillet_faces, fillet_full_round, blend_union), or omit ids to check every blended solid',
});

const DEFAULT_SAMPLES = 11;
const MAX_SAMPLES = 101;
const DEFAULT_G1_ANGLE_RAD = 0.01;
const DEFAULT_G2_REL = 0.1;
/** Default G0 gap: 1e-6 x the bounding-box diagonal (the check_continuity default). */
const G0_FRACTION = 1e-6;
/** A face whose normal curvature is below this fraction of 1 / (bounding-box diagonal) is flat for the G2 reading (a plane's reading is noise). */
const FLAT_CURVATURE_FRACTION = 1e-8;

function checkEntity(
  kernel: GeometryKernel,
  entity: Entity,
  samples: number,
  base: Omit<Tolerances, 'g0' | 'flatCurvature'>,
  g0Param: number | undefined,
  requireG2: boolean,
  unit: string,
  only?: ReadonlySet<string>,
): EntityCheck {
  const entityId = entity.id;
  const findings: Finding[] = [];
  const blends: BlendRow[] = [];
  const recipe = entity.kind === 'mesh' ? entity.brep : undefined;
  const shape = recipe === undefined ? null : kernel.evaluate(recipe);
  if (shape === null)
    return {
      blends,
      findings: [invalid(entityId, unit, 'the kernel cannot rebuild the exact solid from its recipe')],
      unverified: 0,
      unverifiedJunctions: 0,
      g0: g0Param ?? 0,
    };
  const diagonal = diagonalOf(kernel, shape);
  const tolerances: Tolerances = {
    ...base,
    g0: g0Param ?? Math.max(G0_FRACTION * diagonal, 1e-12),
    ...(diagonal > 0 ? { flatCurvature: FLAT_CURVATURE_FRACTION / diagonal } : {}),
  };
  const analysis = kernel.analyze?.(shape);
  if (analysis !== undefined && analysis !== null && !analysis.valid)
    findings.push(invalid(entityId, unit, `the solid fails the kernel validity check (${analysis.status})`));
  const topology = kernel.topology(shape);
  const graph = kernel.faceQuery?.faceGraph(shape) ?? null;
  if (topology === null || graph === null || kernel.faceQuery === undefined)
    return {
      blends,
      findings,
      unverified: 0,
      unverifiedJunctions: 0,
      g0: tolerances.g0,
      notRun: 'this kernel has no exact topology / face queries',
    };
  const named = topology.faces.some((face) => face.name !== undefined);
  if (!named)
    findings.push({
      code: 'BLD_CHECK_UNVERIFIED_PICK',
      severity: 'warn',
      entityId,
      unit,
      remediation: REMEDIATION.BLD_CHECK_UNVERIFIED_PICK,
      message: 'this kernel keeps no face names: the blend faces cannot be identified, so no contact was measured',
    });
  let unverified = 0;
  let unverifiedJunctions = 0;
  const laws = recordsByFace(topology, lawIndex(kernel, recipe as ShapeRecipe));
  const contactsOf = new Map(blendFaceContacts(topology, graph).map((entry) => [entry.face, entry]));
  // two blends are a chain junction when both are profiled blends of one fillet node (a crease between two steps, or a mitre, is not tangent by intent)
  const chained = (a: number, b: number): boolean => {
    const first = laws.get(a),
      second = laws.get(b);
    return (
      first !== undefined &&
      second !== undefined &&
      first.node === second.node &&
      first.profile !== undefined &&
      first.profile.type !== 'circular'
    );
  };
  for (const face of topology.faces) {
    const source = face.name === undefined ? null : blendSource(face.name);
    if (source === null || face.name === undefined) continue;
    if (only !== undefined && !only.has(face.name)) continue;
    const contacts: Contact[] = [];
    const before = unverified;
    // width of the blend: its area over its longest edge (the contact lines)
    const longest = Math.max(
      ...graph.edgeFaces.flatMap((around, edge) => (around.includes(face.index) ? [topology.edges[edge]?.length ?? 0] : [])),
      0,
    );
    const profiled = (laws.get(face.index)?.profile?.type ?? 'circular') !== 'circular';
    const own: Tolerances = profiled ? { ...tolerances, g0: g0Param ?? tolerances.g0 * PROFILE_G0_FACTOR } : tolerances;
    const faceTolerances = withBlendScaleFloor(own, face.area, longest);
    graph.edgeFaces.forEach((around, edge) => {
      if (around.length !== 2 || !around.includes(face.index)) return;
      const otherName = topology.faces[around.find((other) => other !== face.index) ?? -1]?.name;
      if (otherName === undefined || !source.supports.includes(otherName)) return;
      const measured = kernel.faceQuery?.edgeContinuity(shape, edge, samples) ?? null;
      const contact = measured === null ? null : measureContact(measured, faceTolerances);
      if (contact === null) return void unverified++;
      const name = topology.edges[edge]?.name;
      contacts.push({ edge, ...(name === undefined ? {} : { name }), ...roundContact(contact) });
      findings.push(...contactFindings(entityId, face.index, edge, contact, faceTolerances, requireG2, unit));
    });
    const junctions: Contact[] = [];
    let missed = 0;
    for (const junction of junctionsOf(topology, graph, face.index, chained)) {
      const across = kernel.faceQuery?.edgeContinuity(shape, junction.edge, samples) ?? null;
      // Across a crease of the part (a mitre) each blend is tangent to its own support at one end of the junction, so the normals differ there by the
      // crease of the SUPPORT faces (read from them, not from the blends under test): the junction is held to g1AngleRad beyond it, and each end to the
      // crease of the supports it touches. A smooth chain has no crease and keeps the plain rule.
      const neighbourFace = topology.faces.findIndex((candidate) => candidate.name === junction.neighbour);
      const crease = supportCrease(
        topology,
        graph,
        face.index,
        neighbourFace,
        junction.edge,
        (edge) => kernel.faceQuery?.edgeContinuity(shape, edge, samples) ?? null,
      );
      const verdict = judgeJunction(across ?? [], crease, faceTolerances.g1AngleRad);
      const jointTolerances: Tolerances = { ...faceTolerances, g1AngleRad: verdict.limit };
      const joint = across === null ? null : measureContact(across, jointTolerances);
      if (joint === null) {
        missed++;
        continue;
      }
      const name = topology.edges[junction.edge]?.name;
      junctions.push({
        edge: junction.edge,
        ...(name === undefined ? {} : { name }),
        neighbour: junction.neighbour,
        ...(crease > 0 ? { creaseRad: sig(crease) } : {}),
        ...roundContact(joint),
      });
      findings.push(...contactFindings(entityId, face.index, junction.edge, joint, jointTolerances, false, unit));
      if (verdict.endsOff > faceTolerances.g1AngleRad)
        findings.push({
          entityId,
          face: face.index,
          edge: junction.edge,
          code: 'BLD_CHECK_G1_ANGLE',
          severity: 'fail',
          value: sig(verdict.endsOff),
          limit: sig(faceTolerances.g1AngleRad),
          unit: 'rad',
          remediation: REMEDIATION.BLD_CHECK_G1_ANGLE,
          message: `an end of junction edge ${junction.edge} differs by ${sig(verdict.endsOff)} rad from the ${sig(crease)} rad crease of the supports there (blend face ${face.index})`,
        });
    }
    unverifiedJunctions += missed;
    if (missed > 0)
      findings.push({
        code: 'BLD_CHECK_UNVERIFIED_CONTACT',
        severity: 'warn',
        entityId,
        face: face.index,
        unit,
        remediation: REMEDIATION.BLD_CHECK_UNVERIFIED_CONTACT,
        message: `${missed} junction(s) of blend face ${face.index} (${face.name}) with the next blend of its chain could not be measured by the kernel`,
      });
    const jointSource = laws.get(face.index)?.source;
    const located = contactsOf.get(face.index);
    const readback = located === undefined ? null : checkRadius(kernel, shape, located, laws.get(face.index), samples);
    for (const deviation of readback?.deviations ?? [])
      findings.push({
        code: 'BLD_CHECK_RADIUS_LAW',
        severity: 'fail',
        entityId,
        face: face.index,
        value: deviation.deviation,
        limit: sig(RADIUS_LAW_TOLERANCE * deviation.expected),
        unit,
        remediation: REMEDIATION.BLD_CHECK_RADIUS_LAW,
        message: `blend face ${face.index} has radius ${deviation.actual} ${unit} at t = ${deviation.t} where the law gives ${deviation.expected}`,
      });
    const cliffEdge = cliffEdgeOf(kernel, shape, topology, graph, face.index, samples);
    if (cliffEdge !== null) findings.push(cliffFinding(entityId, face.index, face.name, cliffEdge));
    blends.push({
      entityId,
      face: face.index,
      name: face.name,
      kind: 'edge',
      sourceEdges: [source.edge],
      contacts,
      ...(junctions.length === 0 ? {} : { junctions }),
      profile: laws.get(face.index)?.profile?.type ?? 'circular',
      ...(readback?.radius == null ? {} : { radius: readback.radius, lawChecked: readback.lawChecked }),
      ...(readback?.lawNote === undefined ? {} : { lawNote: readback.lawNote }),
      ...(jointSource === undefined ? {} : { source: jointSource }),
    });
    if (unverified > before || contacts.length === 0)
      findings.push({
        code: 'BLD_CHECK_UNVERIFIED_CONTACT',
        severity: 'warn',
        entityId,
        face: face.index,
        unit,
        remediation: REMEDIATION.BLD_CHECK_UNVERIFIED_CONTACT,
        message:
          contacts.length === 0
            ? `blend face ${face.index} (${face.name}) has no contact line against its support faces: nothing was measured`
            : `${unverified - before} contact line(s) of blend face ${face.index} could not be measured by the kernel`,
      });
  }
  // The corner patches (a star sub-patch `blend(v:...)#k` is judged at the default g0, the plate patch of the fallback at 5x it): checkBlendStars.ts
  const plateTolerances: Tolerances = { ...tolerances, g0: g0Param ?? tolerances.g0 * CORNER_G0_FACTOR };
  const world = { kernel, shape, topology, graph, entityId, unit };
  unverified += checkCornerPatches({ world, samples, tolerances, plateTolerances, requireG2 }, blends, findings);
  return { blends, findings, unverified, unverifiedJunctions, g0: tolerances.g0 };
}

const invalid = (entityId: string, unit: string, message: string): Finding => ({
  code: 'BLD_CHECK_INVALID',
  severity: 'fail',
  entityId,
  unit,
  remediation: REMEDIATION.BLD_CHECK_INVALID,
  message,
});

/**
 * @affects none; data = { status, blends [{ entityId, face, name, kind, sourceEdges, source? (blend_union joints: "joints[i]" or "default"), contacts [{ edge, name?, g0Gap, g1AngleRad, g2Gap, g2Rel, order }], junctions? [{ edge, name?, neighbour, g0Gap, g1AngleRad, ... }] }], findings [{ code, severity, entityId, face?, edge?, value?, limit?, unit, remediation, message }], tolerances, unverified, reviewRequired, reviewReason?, unit, provenance }
 * @invariant kernel-optional: without a kernel, without exact face queries or with no filleted solid the result is status "not_run" (no error); status "fail" when any finding fails, "warn" when any warns, else "pass"; "not_run" without exact face queries; each blend row lists the contacts where it meets its two support faces; a corner patch (kind "corner") lists every edge it shares, measured on the open interior (g1AngleRad) and at its two end points (g1EndAngleRad)
 * @failure unknown id / no fillet in the solid -> SRF_ENTITY_NOT_FOUND; non-positive tolerance or samples outside 2..101 -> no-op
 */
/** The findings of the blend faces named in `only` alone, at the default tolerances (the guard of a fillet step reads just the faces the step made: its cost follows the step, not the history). */
export function checkBlendFaces(kernel: GeometryKernel, entity: Entity, only: ReadonlySet<string>, unit: string): Finding[] {
  const base = { g1AngleRad: DEFAULT_G1_ANGLE_RAD, g2Rel: DEFAULT_G2_REL };
  return checkEntity(kernel, entity, DEFAULT_SAMPLES, base, undefined, false, unit, only).findings;
}

export const checkBlends = defineCommand({
  name: 'check_blends',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only continuity and radius check of the blends of solids: the results of fillet_edge, fillet_faces, fillet_full_round and blend_union (every solid with such a blend when `ids` is omitted). For each blend face the exact kernel measures, at `samples` points along each contact line where the ' +
    'blend meets a support face: the gap between the faces (g0Gap, document units), the angle between the outward normals (g1AngleRad, radians), and the normal-curvature jump (g2Gap in 1/unit, g2Rel relative: ' +
    '1 for a plane against a circular fillet) with the order reached (G0 = not tangent, G1, G2). Findings carry stable codes: BLD_CHECK_G1_ANGLE (fail), BLD_CHECK_G2_JUMP (fail when require is G2, else info), BLD_CHECK_SPOKE_G2 (warn, require G2 only: a seam between two sub-patches of a G2 corner star), ' +
    'BLD_CHECK_G0_GAP, BLD_CHECK_INVALID (fail), BLD_CHECK_UNVERIFIED_PICK (warn: kernel keeps no names), BLD_CHECK_UNVERIFIED_CONTACT (warn: a blend face has no measurable contact line, so nothing is claimed), BLD_CHECK_BLEND_LEGS (fail) and BLD_CHECK_BLEND_UNVERIFIED (warn) for a fillet with two legs (size2): such a row has no radius (size is a leg, a length on a face), its legs are read in `data.legs`; BLD_CHECK_RADIUS_LAW (fail: the realised radius is off the radius asked for by more than 1e-4 relative; compared for fillet_edge radius laws and for every joint of a blend_union, whose radii are the default radius or the joints pick), and with purpose "release" BLD_CHECK_TOLERANCE_DEFAULTED (warn) and BLD_CHECK_REVIEW (info; reviewRequired true). ' +
    'Where one blend face meets the next blend face of a tangent chain (not a support of it) the row lists that junction edge under `junctions` (only between blends of one profiled fillet step; G0 against g0Profile = 5 x g0, G1 against g1AngleRad; BLD_CHECK_G0_GAP / BLD_CHECK_G1_ANGLE like a contact; a re-skinned profile chain can kink there when the wall curvature jumps; where the chain turns across a crease of the part (an N-gon rim, a polyline outline: the blends are mitred) each blend is tangent to its own support at one end of the junction, so the normals differ there by the crease of the SUPPORT faces (read from them, up to the 0.11 rad OCCT chains): the junction reports it as creaseRad, is judged against g1AngleRad beyond it, and each end against the crease of the supports it touches; a smooth chain keeps the plain g1AngleRad). A setback corner patch is a row of kind "corner" listing every edge it shares (an edge between two sub-patches that continues an edge of the part left sharp at the corner is a crease spoke, order "crease": G0 against g0, its angle at the sharp edge must equal the dihedral of that edge (creaseRad), must fade monotonically to the pole, and g1AngleRad is the pole reading, a warn above the limit) (an exact star, named blend(v:...)#k, is one row per sub-patch with profile "star" and is judged at g0; the plate patch of the fallback, named blend(v:...), has profile "patch"; the star of a curvature-profile step is G2 to the blend and flat faces it meets and G1 across its own seams: under require "G2" its contacts with those faces pass, and the curvature jump across a seam is a warn BLD_CHECK_SPOKE_G2, never BLD_CHECK_G2_JUMP; a G1 star fails with BLD_CHECK_G2_JUMP everywhere): G0 over the whole contact against g0 (star) or g0Corner (plate), G1 on the open interior (g1AngleRad) and at the two end points apart (g1EndAngleRad; above the limit it is a BLD_CHECK_G1_ANGLE warn). tolerances names every limit with `defaulted` (g0Corner only when a corner row exists).  Needs the exact native kernel (check kernel_info); without it, or with no filleted solid, status is "not_run". Does not modify the document.',
  params: z.object({
    ids: z
      .array(z.string())
      .describe('Ids of solids to check. Default: every solid whose recipe contains a fillet, a face blend or a blend_union.')
      .optional(),
    require: z
      .enum(['G1', 'G2'])
      .describe(
        'Continuity the blends must reach: "G1" (default; a curvature jump is only an info finding) or "G2" (a curvature jump fails).',
      )
      .optional(),
    g0: z
      .number()
      .describe(
        'Largest allowed gap between the blend and a support face, document units (> 0). Default 1e-6 x the bounding-box diagonal. Profile blend rows (conic / curvature, contacts and junctions: tolerance g0Profile, the B-spline fit of a re-skinned blend) and plate corner patch contacts (blend rows of kind "corner" with profile "patch") default to 5 x this (tolerance g0Corner: the plate-surface fit of a setback patch is that accurate; an exact star is judged at g0 itself); an explicit g0 applies to them unchanged.',
      )
      .optional(),
    g1AngleRad: z
      .number()
      .describe('Largest allowed angle between the outward normals at a contact, radians (> 0). Default 0.01.')
      .optional(),
    g2Rel: z.number().describe('Largest relative normal-curvature jump still counted as G2, dimensionless (> 0). Default 0.1.').optional(),
    samples: z.number().int().describe(`Points per contact line (2..${MAX_SAMPLES}). Default ${DEFAULT_SAMPLES}.`).optional(),
    purpose: z
      .enum(['design', 'release'])
      .describe(
        '"release" flags the result reviewRequired (fillet radii are often stress-relevant) and warns when tolerances were defaulted. Default "design".',
      )
      .optional(),
  }),
  run: (doc, params, ctx): CommandResult => {
    const { ids, require = 'G1', samples = DEFAULT_SAMPLES, purpose = 'design' } = params;
    for (const name of ['g0', 'g1AngleRad', 'g2Rel'] as const) {
      const value = params[name];
      if (value !== undefined && !(value > 0)) return noop(doc, `check_blends: ${name} must be > 0 (got ${value}); no-op.`);
    }
    if (samples < 2 || samples > MAX_SAMPLES)
      return noop(doc, `check_blends: samples must be in 2..${MAX_SAMPLES} (got ${samples}); no-op.`);
    const targets: Entity[] = [];
    const chamfered: Entity[] = [];
    for (const id of ids ?? Object.keys(doc.entities)) {
      const entity = doc.entities[id];
      const recipe = entity?.kind === 'mesh' ? entity.brep : undefined;
      const withChamfer = recipe !== undefined && (chamferNodes(recipe).length > 0 || legFilletNodes(recipe).length > 0);
      if (entity !== undefined && recipe !== undefined && hasFillet(recipe)) targets.push(entity);
      if (entity !== undefined && withChamfer) chamfered.push(entity);
      if (recipe !== undefined && (hasFillet(recipe) || withChamfer)) continue;
      if (ids !== undefined)
        return refuse(doc, 'check_blends', 'SRF_ENTITY_NOT_FOUND', `no solid with a blend has id "${id}"`, [id], ['ids']);
    }
    const kernel = (ctx ?? currentContext()).kernel;
    const unit = doc.units;
    const base = { g1AngleRad: params.g1AngleRad ?? DEFAULT_G1_ANGLE_RAD, g2Rel: params.g2Rel ?? DEFAULT_G2_REL };
    const checks =
      kernel === null ? [] : targets.map((entity) => checkEntity(kernel, entity, samples, base, params.g0, require === 'G2', unit));
    const g0Used = params.g0 ?? Math.max(1e-12, ...checks.map((check) => check.g0));
    const named = namedTolerances({
      g0Used,
      unit,
      g0Given: params.g0 !== undefined,
      g1AngleRad: base.g1AngleRad,
      g1Given: params.g1AngleRad !== undefined,
      g2Rel: base.g2Rel,
      g2Given: params.g2Rel !== undefined,
      profiled: checks.some((check) => check.blends.some((blend) => blend.kind === 'edge' && blend.profile !== 'circular')),
      cornered: checks.some((check) => check.blends.some((blend) => blend.kind === 'corner' && blend.profile === 'patch')),
    });
    const legs = kernel === null ? [] : chamfered.map((entity) => readChamferLegs(kernel, entity, unit));
    const legRows = legs.flatMap((read) => read.rows);
    const chamferRows = legRows.filter((row) => row.op === 'chamfer');
    const filletLegRows = legRows.filter((row) => row.op === 'fillet');
    const unverifiedChamfers = legRows.filter((row) => row.note !== undefined);
    const findings = [
      ...checks.flatMap((check) => check.findings),
      ...legs.flatMap((read) => read.findings),
      // a chamfer whose legs could not be compared is not a pass: it is a warning that names why
      ...unverifiedChamfers.map(
        (row): Finding => ({
          code: row.op === 'fillet' ? 'BLD_CHECK_BLEND_UNVERIFIED' : 'BLD_CHECK_CHAMFER_UNVERIFIED',
          severity: 'warn',
          entityId: row.entityId,
          ...(row.face === null ? {} : { face: row.face }),
          edge: row.edge,
          unit,
          remediation: row.op === 'fillet' ? REMEDIATION.BLD_CHECK_BLEND_UNVERIFIED : REMEDIATION.BLD_CHECK_CHAMFER_UNVERIFIED,
          message: `the legs of the ${row.op === 'fillet' ? 'blend' : 'chamfer'} of edge ${row.edge} were not verified: ${row.note}`,
        }),
      ),
    ];
    const defaulted = Object.entries(named)
      .filter(([, tolerance]) => tolerance.defaulted)
      .map(([name]) => name);
    if (purpose === 'release') {
      const subject = targets.map((entity) => entity.id);
      if (defaulted.length > 0)
        findings.push({
          code: 'BLD_CHECK_TOLERANCE_DEFAULTED',
          severity: 'warn',
          entityId: subject[0] ?? '',
          unit,
          remediation: REMEDIATION.BLD_CHECK_TOLERANCE_DEFAULTED,
          message: `tolerances ${defaulted.join(', ')} are defaults`,
        });
      findings.push({
        code: 'BLD_CHECK_REVIEW',
        severity: 'info',
        entityId: subject[0] ?? '',
        unit,
        remediation: REMEDIATION.BLD_CHECK_REVIEW,
        message: `release check of ${subject.length} solid(s): fillet radii need a human review`,
      });
    }
    const notRun =
      kernel === null
        ? 'no geometry kernel is installed'
        : targets.length === 0 && legRows.length === 0
          ? 'no filleted solid to check'
          : (checks.find((check) => check.notRun !== undefined)?.notRun ?? null);
    const status =
      kernel === null ||
      (targets.length === 0 && legRows.length === 0) ||
      (legRows.every((row) => row.maxDeviation === null) && checks.every((check) => check.notRun !== undefined))
        ? 'not_run'
        : statusOf(findings);
    const blends = checks.flatMap((check) => check.blends);
    const unverified = checks.reduce((total, check) => total + check.unverified, 0) + unverifiedChamfers.length;
    const unverifiedJunctions = checks.reduce((total, check) => total + check.unverifiedJunctions, 0);
    const fails = findings.filter((finding) => finding.severity === 'fail').length;
    const summary =
      status === 'not_run'
        ? `check_blends: not_run — ${notRun ?? 'nothing to check'}; document unchanged.`
        : `check_blends: ${status} — ${blends.length} blend face(s) of ${targets.length} solid(s), ${blends.reduce((total, blend) => total + blend.contacts.length, 0)} contact line(s), ${fails} failing finding(s), ${findings.length - fails} other.`;
    return report(doc, summary, {
      status,
      blends,
      ...(chamferRows.length === 0 ? {} : { chamfers: chamferRows }),
      ...(filletLegRows.length === 0 ? {} : { legs: filletLegRows }),
      findings,
      tolerances: named,
      unverified,
      unverifiedJunctions,
      reviewRequired: purpose === 'release',
      ...(purpose === 'release' ? { reviewReason: 'fillet radii are often stress-relevant; a human reviews them (release check)' } : {}),
      ...(notRun === null ? {} : { notRunReason: notRun }),
      unit,
      provenance: {
        method: `kernel edgeContinuity at ${samples} samples per contact line; contacts = edges where a blend face meets its support faces`,
        inputs: { ids: targets.map((entity) => entity.id), require, purpose },
      },
    });
  },
});
