/** check_layup and request_layup_waiver: the closing check of a composite job and its human-gated exception (FR-CMP-66, FR-CMP-71). */

import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { changed, report } from '@core/commands/noop';
import type { LayupWaiver } from '@core/model/composites';
import { nextId } from '@lib/id';
import { refuseCmp } from './codes';
import { type LoadCase, layupFindings } from './layupCheck';
import { effectiveRules } from './ruleReport';
import { compositesOf, findPart, withComposites } from './state';

const loadCase = z.object({
  name: z.string().describe('Load case name.').optional(),
  Nx: z.number().describe('Membrane force Nx, N/mm.').optional(),
  Ny: z.number().describe('Membrane force Ny, N/mm.').optional(),
  Nxy: z.number().describe('Membrane shear force Nxy, N/mm.').optional(),
  Mx: z.number().describe('Moment Mx, N*mm/mm.').optional(),
  My: z.number().describe('Moment My, N*mm/mm.').optional(),
  Mxy: z.number().describe('Twisting moment Mxy, N*mm/mm.').optional(),
});

const thresholdsParam = z
  .object({
    minFraction: z.number().describe('R3 minimum fraction (0..1) of plies per family.').optional(),
    maxConsecutive: z.number().describe('R4 maximum consecutive plies of one angle (plies).').optional(),
    maxAngleChange: z.number().describe('Maximum angle change between adjacent plies, degrees.').optional(),
  })
  .describe('Per-call overrides of the part rule thresholds.')
  .optional();

/**
 * @affects nothing (read-only)
 * @invariant severity fail for rule violations, ramp conflicts, non-blendable zones and strength ratio < 1; warn for unverified material (CMP_MATERIAL_UNVERIFIED, not suppressible), defaults in force (release) and pending waivers; status = worst severity
 * @failure unknown part -> CMP_REF_MISSING
 */
export const checkLayup = defineCommand({
  name: 'check_layup',
  annotations: { readOnly: true },
  description:
    'Closing check of a composite part: aggregates the design rules R1-R5 of every zone stack, blending feasibility and ramp conflicts ' +
    '(CMP_RAMP_CONFLICT), the first-ply failure strength ratio under the given load cases (CMP_FPF_RATIO_BELOW_ONE when below 1), and ' +
    'material verification (CMP_MATERIAL_UNVERIFIED for mean / unknown data, never suppressible). Each finding has a code, severity ' +
    '(fail / warn), the offending ids, value / limit / unit and a remediation; data.status is the worst of them. ' +
    '`purpose` "release" also reports defaults in force (CMP_DEFAULT_USED), evaluates rules even if they were disabled, and sets reviewRequired. ' +
    'A failing finding with a requested waiver (request_layup_waiver) stays a failure with waiverStatus "pending" until a human approval ' +
    'exists. Loads are Nx, Ny, Nxy in N/mm and Mx, My, Mxy in N*mm/mm. Run it as the last step of every layup. Read-only.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    purpose: z.enum(['design', 'release']).describe('"design" (default) or "release" (stricter reporting, reviewRequired).').optional(),
    loads: z.array(loadCase).describe('Load cases to check the strength ratio against; omitted = no strength check.').optional(),
    thresholds: thresholdsParam,
  }),
  run: (doc, { part: partRef, purpose = 'design', loads, thresholds }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'check_layup', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const cases: readonly LoadCase[] | undefined = loads;
    const outcome = layupFindings(model, part, { purpose, loads: cases, thresholds, units: doc.units });
    const fails = outcome.findings.filter((finding) => finding.severity === 'fail');
    const reviewRequired = purpose === 'release' || (loads ?? []).length > 0;
    return report(
      doc,
      `check_layup: part "${part.name}" (${purpose}): ${outcome.status}; ${fails.length} failure(s), ${outcome.findings.length - fails.length} warning(s)${outcome.findings.length > 0 ? `: ${[...new Set(outcome.findings.map((finding) => finding.code))].join(', ')}` : ''}.${reviewRequired ? ' Computed by llull, not approved: needs a qualified engineer.' : ''}`,
      {
        status: outcome.status,
        part: part.id,
        purpose,
        findings: outcome.findings,
        defaults: outcome.defaults,
        thresholds: effectiveRules(part, thresholds).named,
        unverified: outcome.unverifiedMaterials.length > 0,
        unverifiedMaterials: outcome.unverifiedMaterials,
        reviewRequired,
        ...(reviewRequired ? { reviewReason: 'computed by llull, not approved: margins and releases need a qualified engineer' } : {}),
        provenance: {
          method: 'aggregate of rules R1-R5, zone blending, CLT first-ply failure',
          reference: 'NASA RP-1351; common published guidelines',
          inputs: { part: part.id, purpose },
        },
      },
    );
  },
});

/**
 * @affects creates doc.composites.waivers[waiver-<step>.<k>] with no approval reference
 * @invariant the approval reference cannot be set by a parameter: only a human approval recorded through the plugin lifecycle (09 PLM) sets it; the finding stays a failure meanwhile
 * @failure unknown part -> CMP_REF_MISSING; no current finding with that code on those ids -> CMP_WAIVER_NO_FINDING
 */
export const requestLayupWaiver = defineCommand({
  name: 'request_layup_waiver',
  description:
    'Request a waiver for a failing finding of check_layup (a rule violation, a strength ratio below 1, a disabled rule for release): ' +
    'give its `code` and the `ids` it lists, and a `reason`. The waiver is recorded as PENDING; it does not change the verdict: only a ' +
    'qualified human approval makes it effective, and an agent cannot grant it. Refused (CMP_WAIVER_NO_FINDING) when check_layup ' +
    '(purpose release) has no current finding with that code on those ids.',
  params: z.object({
    part: z.string().describe('Part id or name.'),
    code: z.string().describe('Finding code from check_layup, e.g. CMP_FPF_RATIO_BELOW_ONE.'),
    ids: z.array(z.string()).describe('Ids the finding lists (zone ids, ply ids); every one must belong to the finding.'),
    reason: z.string().min(1).describe('Why the finding is acceptable (for the reviewer).'),
    loads: z
      .array(loadCase)
      .describe('The load cases of the check_layup run that produced the finding (needed for strength findings).')
      .optional(),
  }),
  run: (doc, { part: partRef, code, ids, reason, loads }): CommandResult => {
    const model = compositesOf(doc);
    const part = findPart(model, partRef);
    if (part === null) return refuseCmp(doc, 'request_layup_waiver', 'CMP_REF_MISSING', `no part '${partRef}'`, [], ['params.part']);
    const current = layupFindings(model, part, { purpose: 'release', loads, units: doc.units });
    const match = current.findings.find(
      (finding) => finding.code === code && finding.severity === 'fail' && ids.every((id) => finding.ids.includes(id)),
    );
    if (match === undefined)
      return refuseCmp(
        doc,
        'request_layup_waiver',
        'CMP_WAIVER_NO_FINDING',
        `no failing finding ${code} on ${ids.join(', ') || 'any id'} in part "${part.name}"`,
        ids,
        ['params.code'],
      );
    const id = nextId('waiver');
    const waiver: LayupWaiver = { id, partId: part.id, code, ids: [...ids], reason, requestedBy: 'agent' };
    return changed(
      withComposites(doc, { waivers: { ...model.waivers, [id]: waiver } }),
      `request_layup_waiver: recorded PENDING waiver ${id} for ${code} on ${ids.join(', ') || 'the part'}; the finding stays a failure until a qualified human approves it.`,
      [id],
    );
  },
});
