import type { CadDocument } from '@core/model/types';
import { defineCommand, z } from '@core/commands/schema';
import type { CommandResult } from '@core/commands/types';
import { noop, report } from '@core/commands/noop';
import { toMm } from '@core/model/units';
import type { BuildingModel, GratingElement } from '@aec/building/types';
import { elementsOf, getBuilding } from '../../../building/model';
import { round } from '../../../shared/numeric';
import { refuse, remediationOf, type StaCode } from '../codes';
import type { Finding } from '../access/finding';
import { gratingAreaM2 } from './gratingMeasure';
import {
  allowableConcentratedKNPerM,
  allowableUniformKPa,
  concentratedDeflectionMm,
  selfWeightKPa,
  uniformDeflectionMm,
} from './gratingSpan';
import { barDirection, bearsUnder, isPerpendicular, supportLineOf, type SupportLine } from './gratingSupports';
import { findGratingType, type GratingType } from './gratingTypes';

const SOURCE = 'ANSI/NAAMM MBG 531 steel load-table basis (F = 18000 psi, E = 29000 ksi), closed forms of 06 STA §5.4 (grade A)';

interface Limits {
  readonly deflectionMm: (spanMm: number) => number;
  readonly label: string;
}

const finding = (
  code: StaCode,
  ruleId: string,
  panel: GratingElement,
  severity: 'fail' | 'warn',
  measured: { value: number; unit: string },
  limit: { max?: number; unit: string },
  clause: string,
  source: string,
): Finding => ({
  code,
  ruleId,
  ruleset: ruleId.startsWith('PROJECT') ? 'project' : 'naamm_mbg_531',
  clause,
  severity,
  grade: severity === 'fail' ? 'A' : 'B',
  ids: [panel.id],
  measured,
  limit,
  remediation: remediationOf(code),
  source,
});

/** The two supports of a panel as they are in the model now, or the finding that says why they are not. */
function currentSupports(
  doc: CadDocument,
  building: BuildingModel,
  panel: GratingElement,
  type: GratingType,
): { readonly lines: readonly [SupportLine, SupportLine] } | { readonly problem: Finding } {
  const direction = barDirection(panel.bearingBarAngle);
  const level = building.levels[panel.levelId];
  const undersideMm = toMm(doc, (level?.elevation ?? 0) + panel.topOffset) - type.barDepthMm;
  const lines: SupportLine[] = [];
  for (const id of panel.supportIds) {
    const member = building.elements[id];
    const line = member?.category === 'member' ? supportLineOf(doc, building, member, direction) : null;
    if (line === null) {
      return {
        problem: finding(
          'STA_NO_SUPPORT_FOUND',
          'NAAMM-SUPPORT',
          panel,
          'fail',
          { value: 0, unit: 'supports' },
          { max: 2, unit: 'supports' },
          `support ${id} is no longer a horizontal steel member`,
          SOURCE,
        ),
      };
    }
    if (!isPerpendicular(line)) {
      return {
        problem: finding(
          'STA_GRATING_SPAN_DIRECTION',
          'NAAMM-SPAN-DIRECTION',
          panel,
          'fail',
          { value: round((Math.acos(Math.min(1, line.parallelism)) * 180) / Math.PI, 2), unit: 'deg' },
          { unit: 'deg' },
          `support ${id} is not perpendicular (+-5 deg) to the bearing bars`,
          SOURCE,
        ),
      };
    }
    if (!bearsUnder(line, undersideMm)) {
      return {
        problem: finding(
          'STA_NO_SUPPORT_FOUND',
          'NAAMM-SUPPORT',
          panel,
          'fail',
          { value: round(undersideMm - line.topMm, 2), unit: 'mm' },
          { max: 10, unit: 'mm' },
          `support ${id} no longer bears: its top is ${round(undersideMm - line.topMm, 2)} mm under the grating underside (allowed 0..10)`,
          SOURCE,
        ),
      };
    }
    lines.push(line);
  }
  const [a, b] = lines as [SupportLine, SupportLine];
  return { lines: [a, b] };
}

/**
 * @affects none: read-only query, answers in `data` { verdict, panels, findings, unverifiedTypesUsed, reviewRequired }
 * @invariant span = distance between the two support axes along the bars (clear span: minus the half flange widths); demand includes the grating self weight, reported separately from the applied load
 * @failure id that is not a grating -> STA_UNKNOWN_ELEMENT; neither or both of deflectionLimitMm / deflectionRatio -> no-op
 */
export const checkGrating = defineCommand({
  name: 'check_grating',
  description:
    'Check grating panels for bending strength and deflection as simply supported spans (NAAMM MBG 531 basis: F = 18000 psi, E = 29000 ksi, bearing bars only). ' +
    'The span is re-measured from the supporting members now in the model. Per panel: spanMm, allowableUniformKPa (U = 8FS/L2, self weight excluded as in the tables), ' +
    'allowableConcentratedKNPerM (C = 4FS/L, midspan line load across the width), deflectionMm under the APPLIED load alone, totalDeflectionMm and the utilisations including the ' +
    'grating self weight, and findings STA_GRATING_OVERSTRESS / STA_GRATING_DEFLECTION (fail), STA_GRATING_SPAN_DIRECTION / STA_NO_SUPPORT_FOUND (supports edited since), ' +
    'STA_GRATING_TYPE_UNVERIFIED (warn). No defaults: give the design uniform load in kPa (kN/m2) and exactly one deflection limit. Lengths in the answer are millimetres whatever the document units. ' +
    'Read-only; reviewRequired is always true (a qualified person signs walking surfaces).',
  annotations: { readOnly: true, idempotent: true },
  params: z.object({
    uniformLoadKPa: z
      .number()
      .min(0)
      .describe('Design uniform live load, kPa (kN/m2); 100 psf = 4.788. Grating self weight is added by the check.'),
    concentratedLoadKNPerM: z
      .number()
      .positive()
      .optional()
      .describe(
        'Optional midspan line load across the panel width, kN per metre of width (concentrated case of the NAAMM tables, checked alone with the self weight).',
      ),
    deflectionLimitMm: z
      .number()
      .positive()
      .optional()
      .describe('Absolute midspan deflection limit, millimetres (1/4 in = 6.35). Give this or deflectionRatio.'),
    deflectionRatio: z
      .number()
      .positive()
      .optional()
      .describe('Deflection limit as span / ratio, e.g. 200 for L/200. Give this or deflectionLimitMm.'),
    ids: z.array(z.string()).optional().describe('Grating element ids to check. Default: every grating panel.'),
    spanBasis: z
      .enum(['centreline', 'clear'])
      .optional()
      .describe(
        '"centreline" (default, conservative): distance between support axes; "clear": minus the half top-flange width of each support.',
      ),
  }),
  run: (doc, params): CommandResult => {
    if ((params.deflectionLimitMm === undefined) === (params.deflectionRatio === undefined))
      return noop(doc, 'check_grating: give exactly one of deflectionLimitMm or deflectionRatio (no default limit exists); no-op.');
    const building = getBuilding(doc);
    const unknown = (params.ids ?? []).filter((id) => building.elements[id]?.category !== 'grating');
    if (unknown.length > 0)
      return refuse(doc, 'check_grating', 'STA_UNKNOWN_ELEMENT', `${unknown.join(', ')} is not a grating`, unknown, ['ids']);
    const wanted = params.ids === undefined ? undefined : new Set(params.ids);
    const panels = elementsOf(building, 'grating').filter((panel) => wanted?.has(panel.id) ?? true);
    const basis = params.spanBasis ?? 'centreline';
    const limits: Limits = {
      deflectionMm: (spanMm) => params.deflectionLimitMm ?? spanMm / (params.deflectionRatio ?? 1),
      label: params.deflectionLimitMm !== undefined ? `${params.deflectionLimitMm} mm` : `L/${params.deflectionRatio}`,
    };
    const unverified = new Set<string>();
    const rows = panels.map((panel) => {
      const type = findGratingType(panel.gratingType);
      const findings: Finding[] = [];
      if (type === undefined) {
        findings.push(
          finding(
            'STA_GRATING_TYPE_UNKNOWN',
            'NAAMM-TYPE',
            panel,
            'fail',
            { value: 0, unit: 'types' },
            { unit: 'types' },
            `type ${panel.gratingType} left the catalogue`,
            SOURCE,
          ),
        );
        return { id: panel.id, mark: panel.mark, gratingType: panel.gratingType, verdict: 'fail' as const, findings };
      }
      if (!type.verified) {
        unverified.add(type.name);
        findings.push(
          finding(
            'STA_GRATING_TYPE_UNVERIFIED',
            'NAAMM-TYPE-VERIFIED',
            panel,
            'warn',
            { value: type.massKgM2, unit: 'kg/m2' },
            { unit: 'kg/m2' },
            type.name,
            type.massSource,
          ),
        );
      }
      const supports = currentSupports(doc, building, panel, type);
      if ('problem' in supports) {
        findings.push(supports.problem);
        return { id: panel.id, mark: panel.mark, gratingType: type.name, verdict: 'fail' as const, findings };
      }
      const [a, b] = supports.lines;
      const centre = Math.abs(b.sMm - a.sMm);
      const spanMm = basis === 'clear' ? centre - a.halfWidthMm - b.halfWidthMm : centre;
      const allowableU = allowableUniformKPa(type, spanMm);
      const allowableC = allowableConcentratedKNPerM(type, spanMm);
      const selfKPa = selfWeightKPa(type);
      const totalKPa = params.uniformLoadKPa + selfKPa;
      const deflectionApplied = uniformDeflectionMm(type, spanMm, params.uniformLoadKPa);
      const deflectionTotal = uniformDeflectionMm(type, spanMm, totalKPa);
      const concentrated = params.concentratedLoadKNPerM;
      const stressU = totalKPa / allowableU;
      const stressC = concentrated === undefined ? 0 : concentrated / allowableC + selfKPa / allowableU;
      const deflectionC =
        concentrated === undefined ? 0 : concentratedDeflectionMm(type, spanMm, concentrated) + uniformDeflectionMm(type, spanMm, selfKPa);
      const limit = limits.deflectionMm(spanMm);
      const stress = Math.max(stressU, stressC);
      const worstDeflection = Math.max(deflectionTotal, deflectionC);
      if (stress > 1 + 1e-9)
        findings.push(
          finding(
            'STA_GRATING_OVERSTRESS',
            'NAAMM-STRESS',
            panel,
            'fail',
            { value: round(stress, 4), unit: 'utilisation' },
            { max: 1, unit: 'utilisation' },
            `bending stress F = 18000 psi over ${round(spanMm, 1)} mm`,
            SOURCE,
          ),
        );
      if (worstDeflection > limit + 1e-9)
        findings.push(
          finding(
            'STA_GRATING_DEFLECTION',
            'PROJECT-GRATING-DEFLECTION',
            panel,
            'fail',
            { value: round(worstDeflection, 4), unit: 'mm' },
            { max: round(limit, 4), unit: 'mm' },
            `deflection limit ${limits.label} (caller supplied)`,
            'caller: deflectionLimitMm / deflectionRatio',
          ),
        );
      return {
        id: panel.id,
        mark: panel.mark,
        gratingType: type.name,
        spanMm: round(spanMm, 3),
        spanBasis: basis,
        supportIds: panel.supportIds,
        areaM2: round(gratingAreaM2(doc, panel), 6),
        allowableUniformKPa: round(allowableU, 4),
        allowableConcentratedKNPerM: round(allowableC, 4),
        selfWeightKPa: round(selfKPa, 5),
        appliedUniformKPa: params.uniformLoadKPa,
        deflectionMm: round(deflectionApplied, 5),
        totalDeflectionMm: round(deflectionTotal, 5),
        concentratedDeflectionMm: concentrated === undefined ? null : round(deflectionC, 5),
        deflectionLimitMm: round(limit, 4),
        stressUtilisation: round(stress, 4),
        deflectionUtilisation: round(worstDeflection / limit, 4),
        utilisation: round(Math.max(stress, worstDeflection / limit), 4),
        verdict: findings.some((f) => f.severity === 'fail')
          ? ('fail' as const)
          : findings.length > 0
            ? ('warn' as const)
            : ('pass' as const),
        findings,
      };
    });
    const findings = rows.flatMap((row) => row.findings);
    const verdict = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass';
    const fails = rows.filter((row) => row.verdict === 'fail').length;
    return report(
      doc,
      `check_grating: ${verdict} — ${rows.length} panel(s), ${fails} fail; load ${params.uniformLoadKPa} kPa + self weight, deflection limit ${limits.label}; review required.`,
      {
        verdict,
        panels: rows,
        findings,
        deflectionLimit: limits.label,
        unverifiedTypesUsed: [...unverified].sort(),
        source: SOURCE,
        reviewRequired: true,
      },
    );
  },
});
