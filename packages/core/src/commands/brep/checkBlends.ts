/**
 * check_blends v1 (BLD M0, TECHNICAL_SPEC §4, §5.9): numeric G0 / G1 / G2 measurements at the contact lines of the fillets of a solid,
 * from the kernel's exact face queries, plus validity. Numbers and coded findings instead of a zebra render.
 */

import { hasFillet, blendSource, measureContact } from '../../geometry/blend/continuity';
import type { GeometryKernel } from '../../geometry/kernel';
import type { Entity } from '../../model/types';
import { roundSignificant } from '../../lib/significant';
import { currentContext } from '../context';
import { noop, report, tableRejection } from '../noop';
import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { diagonalOf } from './shapeDiagonal';

const sig = (value: number): number => roundSignificant(value, 10);

const refuse = tableRejection({
  SRF_ENTITY_NOT_FOUND: 'pass ids of solids that carry a fillet (fillet_edge), or omit ids to check every blended solid',
});

const DEFAULT_SAMPLES = 11;
const MAX_SAMPLES = 101;
const DEFAULT_G1_ANGLE_RAD = 0.01;
const DEFAULT_G2_REL = 0.1;
/** Default G0 gap: 1e-6 x the bounding-box diagonal (the check_continuity default). */
const G0_FRACTION = 1e-6;

type Severity = 'fail' | 'warn' | 'info';

interface Finding {
  readonly code: string;
  readonly severity: Severity;
  readonly entityId: string;
  readonly face?: number;
  readonly edge?: number;
  readonly value?: number;
  readonly limit?: number;
  readonly unit: string;
  readonly remediation: string;
  readonly message: string;
}

interface Tolerances {
  readonly g0: number;
  readonly g1AngleRad: number;
  readonly g2Rel: number;
}

interface Contact {
  readonly edge: number;
  readonly name?: string;
  readonly g0Gap: number;
  readonly g1AngleRad: number;
  readonly g2Gap: number;
  readonly g2Rel: number;
  readonly order: string;
}

interface BlendRow {
  readonly entityId: string;
  readonly face: number;
  readonly name: string;
  readonly kind: 'edge';
  readonly sourceEdges: readonly string[];
  readonly contacts: readonly Contact[];
}

interface EntityCheck {
  readonly blends: BlendRow[];
  readonly findings: Finding[];
  readonly unverified: number;
  /** The gap tolerance applied to this solid (document units). */
  readonly g0: number;
  /** Why nothing could be measured, when that is so. */
  readonly notRun?: string;
}

const REMEDIATION = {
  BLD_CHECK_G0_GAP: 'the faces do not meet at the contact: use a smaller radius or fewer edges per step',
  BLD_CHECK_G1_ANGLE: 'the blend is not tangent to a support face: rebuild the fillet with a smaller radius or fewer edges per step',
  BLD_CHECK_G2_JUMP: 'a circular fillet is never G2 to a plane: use a curvature-continuous profile when G2 is required',
  BLD_CHECK_INVALID: 'rebuild the blend with a smaller radius or fewer edges per step',
  BLD_CHECK_UNVERIFIED_PICK: 'use the native exact kernel (kernel_info), which keeps persistent names',
  BLD_CHECK_UNVERIFIED_CONTACT: 'rebuild the blend with a smaller radius, or inspect_topology / check_continuity the blend by hand',
  BLD_CHECK_TOLERANCE_DEFAULTED: 'pass g0, g1AngleRad and g2Rel explicitly to accept them',
  BLD_CHECK_REVIEW: 'a release check needs a human review of the radii (stress-relevant): sign off through the PLM release',
} as const;

function checkEntity(
  kernel: GeometryKernel,
  entity: Entity,
  samples: number,
  base: Omit<Tolerances, 'g0'>,
  g0Param: number | undefined,
  requireG2: boolean,
  unit: string,
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
      g0: g0Param ?? 0,
    };
  const tolerances: Tolerances = { ...base, g0: g0Param ?? Math.max(G0_FRACTION * diagonalOf(kernel, shape), 1e-12) };
  const analysis = kernel.analyze?.(shape);
  if (analysis !== undefined && analysis !== null && !analysis.valid)
    findings.push(invalid(entityId, unit, `the solid fails the kernel validity check (${analysis.status})`));
  const topology = kernel.topology(shape);
  const graph = kernel.faceQuery?.faceGraph(shape) ?? null;
  if (topology === null || graph === null || kernel.faceQuery === undefined)
    return { blends, findings, unverified: 0, g0: tolerances.g0, notRun: 'this kernel has no exact topology / face queries' };
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
  for (const face of topology.faces) {
    const source = face.name === undefined ? null : blendSource(face.name);
    if (source === null || face.name === undefined) continue;
    const contacts: Contact[] = [];
    const before = unverified;
    graph.edgeFaces.forEach((around, edge) => {
      if (around.length !== 2 || !around.includes(face.index)) return;
      const otherName = topology.faces[around.find((other) => other !== face.index) ?? -1]?.name;
      if (otherName === undefined || !source.supports.includes(otherName)) return;
      const measured = kernel.faceQuery?.edgeContinuity(shape, edge, samples) ?? null;
      const contact = measured === null ? null : measureContact(measured, tolerances);
      if (contact === null) return void unverified++;
      const name = topology.edges[edge]?.name;
      contacts.push({ edge, ...(name === undefined ? {} : { name }), ...roundContact(contact) });
      findings.push(...contactFindings(entityId, face.index, edge, contact, tolerances, requireG2, unit));
    });
    blends.push({ entityId, face: face.index, name: face.name, kind: 'edge', sourceEdges: [source.edge], contacts });
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
  return { blends, findings, unverified, g0: tolerances.g0 };
}

const invalid = (entityId: string, unit: string, message: string): Finding => ({
  code: 'BLD_CHECK_INVALID',
  severity: 'fail',
  entityId,
  unit,
  remediation: REMEDIATION.BLD_CHECK_INVALID,
  message,
});

const roundContact = (contact: ReturnType<typeof measureContact> & object): Omit<Contact, 'edge' | 'name'> => ({
  g0Gap: sig(contact.g0Gap),
  g1AngleRad: sig(contact.g1AngleRad),
  g2Gap: sig(contact.g2Gap),
  g2Rel: sig(contact.g2Rel),
  order: contact.order,
});

function contactFindings(
  entityId: string,
  face: number,
  edge: number,
  contact: NonNullable<ReturnType<typeof measureContact>>,
  tolerances: Tolerances,
  requireG2: boolean,
  unit: string,
): Finding[] {
  const found: Finding[] = [];
  const at = { entityId, face, edge };
  if (contact.g0Gap > tolerances.g0)
    found.push({
      ...at,
      code: 'BLD_CHECK_G0_GAP',
      severity: 'fail',
      value: sig(contact.g0Gap),
      limit: sig(tolerances.g0),
      unit,
      remediation: REMEDIATION.BLD_CHECK_G0_GAP,
      message: `faces ${face} and its support are ${sig(contact.g0Gap)} ${unit} apart along edge ${edge}`,
    });
  if (contact.g1AngleRad > tolerances.g1AngleRad)
    found.push({
      ...at,
      code: 'BLD_CHECK_G1_ANGLE',
      severity: 'fail',
      value: sig(contact.g1AngleRad),
      limit: sig(tolerances.g1AngleRad),
      unit: 'rad',
      remediation: REMEDIATION.BLD_CHECK_G1_ANGLE,
      message: `the normals differ by ${sig(contact.g1AngleRad)} rad along edge ${edge} (blend face ${face} is not tangent)`,
    });
  else if (contact.g2Rel > tolerances.g2Rel)
    found.push({
      ...at,
      code: 'BLD_CHECK_G2_JUMP',
      severity: requireG2 ? 'fail' : 'info',
      value: sig(contact.g2Rel),
      limit: sig(tolerances.g2Rel),
      unit: 'ratio',
      remediation: REMEDIATION.BLD_CHECK_G2_JUMP,
      message: `curvature jumps by ${sig(contact.g2Gap)} 1/${unit} (relative ${sig(contact.g2Rel)}) across edge ${edge}: G1 only`,
    });
  return found;
}

const statusOf = (findings: readonly Finding[]): 'pass' | 'warn' | 'fail' =>
  findings.some((finding) => finding.severity === 'fail')
    ? 'fail'
    : findings.some((finding) => finding.severity === 'warn')
      ? 'warn'
      : 'pass';

/**
 * @affects none; data = { status, blends [{ entityId, face, name, kind, sourceEdges, contacts [{ edge, name?, g0Gap, g1AngleRad, g2Gap, g2Rel, order }] }], findings [{ code, severity, entityId, face?, edge?, value?, limit?, unit, remediation, message }], tolerances, unverified, reviewRequired, reviewReason?, unit, provenance }
 * @invariant kernel-optional: without a kernel, without exact face queries or with no filleted solid the result is status "not_run" (no error); status "fail" when any finding fails, "warn" when any warns, else "pass"; "not_run" without exact face queries; each blend row lists the contacts where it meets its two support faces
 * @failure unknown id / no fillet in the solid -> SRF_ENTITY_NOT_FOUND; non-positive tolerance or samples outside 2..101 -> no-op
 */
export const checkBlends = defineCommand({
  name: 'check_blends',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Read-only continuity check of the fillets of solids (every solid with a fillet when `ids` is omitted). For each edge fillet the exact kernel measures, at `samples` points along each contact line where the ' +
    'blend meets a support face: the gap between the faces (g0Gap, document units), the angle between the outward normals (g1AngleRad, radians), and the normal-curvature jump (g2Gap in 1/unit, g2Rel relative: ' +
    '1 for a plane against a circular fillet) with the order reached (G0 = not tangent, G1, G2). Findings carry stable codes: BLD_CHECK_G1_ANGLE (fail), BLD_CHECK_G2_JUMP (fail when require is G2, else info), ' +
    'BLD_CHECK_G0_GAP, BLD_CHECK_INVALID (fail), BLD_CHECK_UNVERIFIED_PICK (warn: kernel keeps no names), BLD_CHECK_UNVERIFIED_CONTACT (warn: a blend face has no measurable contact line, so nothing is claimed), and with purpose "release" BLD_CHECK_TOLERANCE_DEFAULTED (warn) and BLD_CHECK_REVIEW (info; reviewRequired true). ' +
    'tolerances names every limit with `defaulted`. Needs the exact native kernel (check kernel_info); without it, or with no filleted solid, status is "not_run". Does not modify the document.',
  params: z.object({
    ids: z.array(z.string()).describe('Ids of solids to check. Default: every solid whose recipe contains a fillet.').optional(),
    require: z
      .enum(['G1', 'G2'])
      .describe(
        'Continuity the blends must reach: "G1" (default; a curvature jump is only an info finding) or "G2" (a curvature jump fails).',
      )
      .optional(),
    g0: z
      .number()
      .describe('Largest allowed gap between the blend and a support face, document units (> 0). Default 1e-6 x the bounding-box diagonal.')
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
    for (const id of ids ?? Object.keys(doc.entities)) {
      const entity = doc.entities[id];
      const recipe = entity?.kind === 'mesh' ? entity.brep : undefined;
      if (entity !== undefined && recipe !== undefined && hasFillet(recipe)) targets.push(entity);
      else if (ids !== undefined)
        return refuse(doc, 'check_blends', 'SRF_ENTITY_NOT_FOUND', `no solid with a fillet has id "${id}"`, [id], ['ids']);
    }
    const kernel = (ctx ?? currentContext()).kernel;
    const unit = doc.units;
    const base = { g1AngleRad: params.g1AngleRad ?? DEFAULT_G1_ANGLE_RAD, g2Rel: params.g2Rel ?? DEFAULT_G2_REL };
    const checks =
      kernel === null ? [] : targets.map((entity) => checkEntity(kernel, entity, samples, base, params.g0, require === 'G2', unit));
    const g0Used = params.g0 ?? Math.max(1e-12, ...checks.map((check) => check.g0));
    const named = {
      g0: {
        value: sig(g0Used),
        unit,
        defaulted: params.g0 === undefined,
        source: 'check_continuity default: 1e-6 x the bounding-box diagonal of each solid (the largest is shown)',
      },
      g1AngleRad: {
        value: base.g1AngleRad,
        unit: 'rad',
        defaulted: params.g1AngleRad === undefined,
        source: 'OCCT MakeFilling TolAng default',
      },
      g2Rel: { value: base.g2Rel, unit: 'ratio', defaulted: params.g2Rel === undefined, source: 'check_continuity default' },
    };
    const findings = checks.flatMap((check) => check.findings);
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
        : targets.length === 0
          ? 'no filleted solid to check'
          : (checks.find((check) => check.notRun !== undefined)?.notRun ?? null);
    const status =
      kernel === null || targets.length === 0 || checks.every((check) => check.notRun !== undefined) ? 'not_run' : statusOf(findings);
    const blends = checks.flatMap((check) => check.blends);
    const unverified = checks.reduce((total, check) => total + check.unverified, 0);
    const fails = findings.filter((finding) => finding.severity === 'fail').length;
    const summary =
      status === 'not_run'
        ? `check_blends: not_run — ${notRun ?? 'nothing to check'}; document unchanged.`
        : `check_blends: ${status} — ${blends.length} blend face(s) of ${targets.length} solid(s), ${blends.reduce((total, blend) => total + blend.contacts.length, 0)} contact line(s), ${fails} failing finding(s), ${findings.length - fails} other.`;
    return report(doc, summary, {
      status,
      blends,
      findings,
      tolerances: named,
      unverified,
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
