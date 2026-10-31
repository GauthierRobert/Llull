/** blend_overlay — read-only geometry to DRAW the check_blends readings on a solid: contact / junction / corner / chamfer polylines in world coordinates with their measured angle and status (06 BLD M5 review overlays). */

import { chamferNodes } from '../../geometry/blend/blendInfo';
import { hasFillet } from '../../geometry/blend/continuity';
import { is3D, type CadDocument, type Vec3 } from '../../model/types';
import { currentContext } from '../context';
import { report, tableRejection } from '../noop';
import { defineCommand, z } from '../schema';
import type { CommandResult } from '../types';
import { checkBlends } from './checkBlends';

const refuse = tableRejection({
  SRF_ENTITY_NOT_FOUND: 'pass the id of a solid (a filleted solid draws its contacts; any other solid answers status "not_run")',
});

/** Findings listed at most (the overlay names the first failing one; the full list is check_blends). */
const MAX_FINDINGS = 20;

export type OverlayStatus = 'pass' | 'warn' | 'fail' | 'not_run';
export type OverlayRole = 'contact' | 'junction' | 'corner' | 'chamfer';

/** One measured line of a blend, sampled in world coordinates, with what check_blends read on it. */
export interface BlendOverlayLine {
  readonly role: OverlayRole;
  readonly edge: number;
  readonly face: number | null;
  /** Name of the blend face (the persistent name), null for a chamfer without a face. */
  readonly blend: string | null;
  /** 'star' | 'patch' for a corner patch, else the section profile of the blend ('circular', 'conic', ...). */
  readonly profile: string;
  readonly status: OverlayStatus;
  /** Largest angle between the outward normals on the line, rad (null for a chamfer: it has legs, not normals). */
  readonly angleRad: number | null;
  /** Largest gap between the faces, document units (null for a chamfer). */
  readonly gap: number | null;
  /** Chamfer only: the largest relative deviation of a leg from its law. */
  readonly deviation: number | null;
  readonly points: Vec3[];
}

interface CheckedContact {
  readonly edge: number;
  readonly g0Gap: number;
  readonly g1AngleRad: number;
  readonly g1EndAngleRad?: number;
}
interface CheckedBlend {
  readonly face: number;
  readonly name: string;
  readonly kind: 'edge' | 'corner';
  readonly profile: string;
  readonly contacts: readonly CheckedContact[];
  readonly junctions?: readonly CheckedContact[];
}
interface CheckedChamfer {
  readonly edge: number;
  readonly face: number | null;
  readonly name: string | null;
  readonly maxDeviation: number | null;
  readonly note?: string;
}
interface CheckedFinding {
  readonly code: string;
  readonly severity: 'fail' | 'warn' | 'info';
  readonly face?: number;
  readonly edge?: number;
  readonly message: string;
}
interface Checked {
  readonly status: OverlayStatus;
  readonly blends: readonly CheckedBlend[];
  readonly chamfers?: readonly CheckedChamfer[];
  readonly findings: readonly CheckedFinding[];
  readonly notRunReason?: string;
}

/** The worst severity of the findings that name this face and edge (a null edge: the findings of the face alone): fail, warn or pass (info is a pass). */
function statusOfFindings(findings: readonly CheckedFinding[], face: number | null, edge: number | null): OverlayStatus {
  const own = findings.filter((found) => found.face === (face ?? undefined) && found.edge === (edge ?? undefined));
  return own.some((found) => found.severity === 'fail') ? 'fail' : own.some((found) => found.severity === 'warn') ? 'warn' : 'pass';
}

const emptyAnswer = (doc: CadDocument, summary: string, reason: string): CommandResult =>
  report(doc, summary, {
    status: 'not_run',
    lines: [],
    counts: { pass: 0, warn: 0, fail: 0, not_run: 0 },
    findings: [],
    firstFailure: null,
    notRunReason: reason,
    unit: doc.units,
  });

/**
 * @affects none (read-only); data = { status, lines [{ role: contact | junction | corner | chamfer, edge, face, blend, profile, status: pass | warn | fail | not_run, angleRad, gap, deviation, points[] }], counts, findings [{ code, severity, face, edge, message }], firstFailure, notRunReason?, unit }
 * @invariant the readings are check_blends' own (run in-process on the same solid, never re-measured here): a line's status is the worst severity of the findings that name its edge, or a failing finding of its blend face alone (radius law); a blend row without a measurable line counts as one "not_run"; points are the kernel's edge samples
 * @failure unknown id or not a solid -> SRF_ENTITY_NOT_FOUND; a solid without a blend, or no exact kernel -> status "not_run" with notRunReason (no error)
 */
export const blendOverlay = defineCommand({
  name: 'blend_overlay',
  annotations: { readOnly: true, idempotent: true },
  description:
    'Geometry to DRAW the check_blends readings of one solid for review, in world coordinates (document units): data.lines [{ role: "contact" | "junction" | "corner" | "chamfer", edge, face, blend, profile ("star" | "patch" for a corner patch), ' +
    'status: "pass" | "warn" | "fail" | "not_run", angleRad (largest angle between the outward normals on the line), gap, deviation (chamfer legs), points[] }], data.counts {pass, warn, fail, not_run}, data.findings (the first 20 warnings and failures of check_blends) and ' +
    'data.firstFailure. The readings are those of check_blends (same tolerances, same findings): a line is "fail" when a failing finding names its edge, "warn" for a warning, else "pass"; a blend with no measurable contact counts as "not_run". ' +
    'A solid without a blend, or no exact native kernel, answers status "not_run" with notRunReason. Read-only; nothing is stored. Next: check_blends for the numbers behind the picture.',
  params: z.object({
    id: z.string().describe('Id of the solid whose blends are drawn.'),
    samples: z.number().int().min(2).max(101).optional().describe('Points sampled along each line (default 11).'),
  }),
  run: (doc: CadDocument, params, ctx): CommandResult => {
    const entity = doc.entities[params.id];
    if (entity === undefined || !is3D(entity) || entity.kind === 'instance')
      return refuse(doc, 'blend_overlay', 'SRF_ENTITY_NOT_FOUND', `no solid has id "${params.id}"`, [params.id], ['id']);
    const recipe = entity.kind === 'mesh' ? entity.brep : undefined;
    if (recipe === undefined || !(hasFillet(recipe) || chamferNodes(recipe).length > 0))
      return emptyAnswer(doc, `blend_overlay: '${params.id}' has no blend; nothing to draw.`, 'no filleted or chamfered solid to check');
    const count = params.samples ?? 11;
    const context = ctx ?? currentContext();
    const data = checkBlends.run(doc, { ids: [params.id], samples: count }, context).data as Checked | undefined;
    const kernel = context.kernel;
    const query = kernel?.faceQuery;
    const shape = kernel === null || kernel === undefined ? null : kernel.evaluate(recipe);
    if (data === undefined || kernel === null || kernel === undefined || query === undefined || shape === null) {
      const reason = data?.notRunReason ?? 'no exact kernel';
      return emptyAnswer(doc, `blend_overlay: '${params.id}' not drawn — ${reason}.`, reason);
    }
    const lines: BlendOverlayLine[] = [];
    const pointsOf = (edge: number): Vec3[] => query.edgeSamples(shape, edge, count)?.map((sample) => sample.point) ?? [];
    let rowsWithoutLines = 0;
    for (const blend of data.blends) {
      const faceFails = statusOfFindings(data.findings, blend.face, null) === 'fail';
      const rows: Array<[OverlayRole, CheckedContact]> = [
        ...blend.contacts.map((contact): [OverlayRole, CheckedContact] => [blend.kind === 'corner' ? 'corner' : 'contact', contact]),
        ...(blend.junctions ?? []).map((junction): [OverlayRole, CheckedContact] => ['junction', junction]),
      ];
      if (rows.length === 0) rowsWithoutLines += 1;
      for (const [role, contact] of rows) {
        const own = statusOfFindings(data.findings, blend.face, contact.edge);
        lines.push({
          role,
          edge: contact.edge,
          face: blend.face,
          blend: blend.name,
          profile: blend.profile,
          status: own === 'pass' && faceFails ? 'fail' : own,
          angleRad: Math.max(contact.g1AngleRad, contact.g1EndAngleRad ?? 0),
          gap: contact.g0Gap,
          deviation: null,
          points: pointsOf(contact.edge),
        });
      }
    }
    for (const chamfer of data.chamfers ?? []) {
      lines.push({
        role: 'chamfer',
        edge: chamfer.edge,
        face: chamfer.face,
        blend: chamfer.name,
        profile: 'chamfer',
        status: chamfer.note !== undefined ? 'not_run' : statusOfFindings(data.findings, chamfer.face, chamfer.edge),
        angleRad: null,
        gap: null,
        deviation: chamfer.maxDeviation,
        points: pointsOf(chamfer.edge),
      });
    }
    const counts = { pass: 0, warn: 0, fail: 0, not_run: rowsWithoutLines };
    for (const line of lines) counts[line.status] += 1;
    const findings = data.findings
      .filter((found) => found.severity !== 'info')
      .slice(0, MAX_FINDINGS)
      .map((found) => ({
        code: found.code,
        severity: found.severity,
        face: found.face ?? null,
        edge: found.edge ?? null,
        message: found.message,
      }));
    const firstFailure = findings.find((found) => found.severity === 'fail') ?? null;
    return report(
      doc,
      `blend_overlay: '${params.id}' ${data.status} — ${lines.length} line(s): ${counts.pass} pass, ${counts.warn} warn, ${counts.fail} fail, ${counts.not_run} not run.`,
      {
        status: data.status,
        lines,
        counts,
        findings,
        firstFailure,
        ...(data.notRunReason === undefined ? {} : { notRunReason: data.notRunReason }),
        unit: doc.units,
      },
    );
  },
});
