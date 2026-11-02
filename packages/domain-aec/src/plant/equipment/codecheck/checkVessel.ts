/**
 * Findings of `check_equipment` for one vessel (plant 03 EQP §4, §7): ASME VIII-1 under-thickness / MAWP failures, covered-by-the-formulas
 * warnings, nozzle layout warnings, unverified or unsourced inputs, placeholder flanges. Pure; the findings are data, never refusals.
 */

import type { EquipmentElement } from '@aec/building/types';
import { nozzleWarnings } from '../geometry/nozzleChecks';
import { resolveVessel } from '../geometry/vesselFrame';
import type { NozzleRecord, VesselTemplate } from '../plantData';
import { remediationOf } from '../model';
import { asmeThickness, type CodeFinding } from './asme';

export type IssueSeverity = 'fail' | 'warning';

export interface EquipmentIssue {
  readonly code: string;
  readonly severity: IssueSeverity;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
  readonly message: string;
  readonly remediation: string;
}

export interface VesselCheck {
  readonly issues: EquipmentIssue[];
  /** True when a code thickness / MAWP was computed for this vessel (pressure equipment: the result needs a qualified review). */
  readonly reviewRequired: boolean;
}

/** A saddle supports the shell over this angle either side of the bottom line (named assumption: 120 degree contact). */
const SADDLE_HALF_CONTACT_DEG = 60;

const issueOf = (element: EquipmentElement, severity: IssueSeverity, finding: CodeFinding): EquipmentIssue => ({
  code: finding.code,
  severity,
  ids: [element.id],
  paths: finding.paths,
  message: `${element.mark}: ${finding.message}`,
  remediation: remediationOf(finding.code),
});

/** Nozzles whose body crosses a skirt wall (head nozzle reaching past the shell outside radius) or sits over a saddle. */
function supportFindings(template: VesselTemplate, nozzle: NozzleRecord): CodeFinding[] {
  const geometry = resolveVessel(template);
  if ('error' in geometry) return [];
  const { location } = nozzle;
  const { support } = template;
  const reach = Math.max(nozzle.flange.outsideDiameter, nozzle.neckOutsideDiameter) / 2;
  const at = (path: string): string[] => [`nozzles.${nozzle.mark}.${path}`];
  if (support.type === 'skirt' && location.on === 'head' && location.head === 'bottom') {
    const skirtInside = geometry.radius + geometry.shellThickness;
    if (location.radialOffset + reach > skirtInside)
      return [
        {
          code: 'EQP_NOZZLE_IN_SUPPORT',
          message: `nozzle ${nozzle.mark} reaches the skirt wall (offset + flange radius ${location.radialOffset + reach} > ${skirtInside})`,
          paths: at('location.radialOffset'),
        },
      ];
  }
  if (support.type === 'saddles' && location.on === 'shell' && 'station' in location) {
    const fromBottom = Math.abs((((location.orientationDeg % 360) + 360) % 360) - 180);
    if (fromBottom <= SADDLE_HALF_CONTACT_DEG) {
      const hit = support.stations.find((station) => Math.abs(station - location.station) < support.width / 2 + reach);
      if (hit !== undefined)
        return [
          {
            code: 'EQP_NOZZLE_IN_SUPPORT',
            message: `nozzle ${nozzle.mark} (station ${location.station}) is over the saddle at station ${hit}`,
            paths: at('location'),
          },
        ];
    }
  }
  return [];
}

function nozzleFindings(
  template: VesselTemplate,
  nozzles: readonly NozzleRecord[],
): Array<{ severity: IssueSeverity; finding: CodeFinding }> {
  const out: Array<{ severity: IssueSeverity; finding: CodeFinding }> = [];
  const warn = (finding: CodeFinding): void => void out.push({ severity: 'warning', finding });
  nozzles.forEach((nozzle, index) => {
    const prefix = `nozzles.${nozzle.mark}`;
    for (const found of nozzleWarnings(template, nozzle, []))
      warn({ code: found.code, message: `nozzle ${nozzle.mark}: ${found.message}`, paths: [`${prefix}.${found.path}`] });
    for (const other of nozzles.slice(index + 1))
      for (const found of nozzleWarnings(template, nozzle, [other]).filter((candidate) => candidate.code === 'EQP_NOZZLE_OVERLAP'))
        warn({
          code: found.code,
          message: `nozzles ${nozzle.mark} and ${other.mark}: ${found.message}`,
          paths: [`${prefix}.location`, `nozzles.${other.mark}.location`],
        });
    for (const found of supportFindings(template, nozzle)) warn(found);
    if (nozzle.flange.placeholder)
      warn({
        code: 'EQP_FLANGE_PLACEHOLDER',
        message: `nozzle ${nozzle.mark}: flange is a placeholder (no catalogue row for DN ${nozzle.dn} ${nozzle.rating} ${nozzle.facing})`,
        paths: [`${prefix}.flange`],
      });
    else if (nozzle.flange.unverified)
      warn({
        code: 'EQP_TABLE_UNVERIFIED',
        message: `nozzle ${nozzle.mark}: the flange row is unverified (catalogue grade below A)`,
        paths: [`${prefix}.flange`],
      });
  });
  return out;
}

/** Severity of a thickness-calculation refusal reported as a finding: all are warnings (the vessel cannot be judged by the MVP formulas). */
const COVERAGE_CODES = [
  'EQP_DESIGN_DATA_MISSING',
  'EQP_ALLOWABLE_MISSING',
  'EQP_FORMULA_OUT_OF_RANGE',
  'EQP_HEAD_NOT_COVERED',
  'EQP_PARAM_INVALID',
];

/**
 * @param element a vessel (`plant.template.kind === 'vessel'`)
 * @invariant fails only on computed under-thickness / MAWP below design; a part the formulas do not cover is a warning, never a pass
 */
export function checkVessel(element: EquipmentElement, mmPerUnit: number): VesselCheck {
  const plant = element.plant;
  if (plant === undefined || plant.template.kind !== 'vessel') return { issues: [], reviewRequired: false };
  const found: Array<{ severity: IssueSeverity; finding: CodeFinding }> = [];
  const result = asmeThickness(plant, { mmPerUnit, corroded: true });
  let reviewRequired = false;
  if ('refusal' in result) {
    const code = COVERAGE_CODES.includes(result.refusal.code) ? result.refusal.code : 'EQP_PARAM_INVALID';
    found.push({ severity: 'warning', finding: { ...result.refusal, code } });
    const stress = plant.design?.allowableStress;
    if (stress !== undefined && (stress.source === undefined || stress.source === ''))
      found.push({
        severity: 'warning',
        finding: { code: 'EQP_VALUE_UNSOURCED', message: 'allowable stress S has no source', paths: ['design.allowableStress.source'] },
      });
  } else {
    for (const part of result.parts) {
      if ('refusal' in part)
        found.push({ severity: 'warning', finding: { ...part.refusal, message: `${part.key}: ${part.refusal.message}` } });
      else {
        reviewRequired = true;
        for (const code of part.result.failures) {
          const text =
            code === 'EQP_MAWP_BELOW_DESIGN'
              ? `${part.key} MAWP ${part.result.mawpMPa.toPrecision(6)} MPa is below the design pressure ${result.pressureMPa} MPa`
              : `${part.key} available thickness ${part.result.availableThicknessMm.toPrecision(6)} mm is below the required ${part.result.requiredCorrodedThicknessMm.toPrecision(6)} mm (corroded)`;
          found.push({
            severity: 'fail',
            finding: { code, message: text, paths: [part.key === 'shell' ? 'shellThickness' : 'headThickness'] },
          });
        }
      }
    }
    for (const warning of result.warnings) found.push({ severity: 'warning', finding: warning });
  }
  const geometry = resolveVessel(plant.template);
  if (!('error' in geometry) && geometry.unverified)
    found.push({
      severity: 'warning',
      finding: { code: 'EQP_TABLE_UNVERIFIED', message: 'a head standard row below grade A gives the head proportions', paths: ['heads'] },
    });
  found.push(...nozzleFindings(plant.template, plant.nozzles));
  return { issues: found.map(({ severity, finding }) => issueOf(element, severity, finding)), reviewRequired };
}
