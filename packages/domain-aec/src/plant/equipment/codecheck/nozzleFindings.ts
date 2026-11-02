/** Nozzle layout findings shared by the checks of every equipment template (plant 03 EQP §7): overlap, knuckle, supports, flanges. */

import { nozzleWarnings } from '../geometry/nozzleChecks';
import { resolveVessel } from '../geometry/vesselFrame';
import type { EquipmentTemplate, NozzleRecord, VesselTemplate } from '../plantData';
import type { CodeFinding } from './asme';

export interface NozzleFinding {
  readonly severity: 'warning';
  readonly finding: CodeFinding;
}

/** A saddle supports the shell over this angle either side of the bottom line (named assumption: 120 degree contact). */
const SADDLE_HALF_CONTACT_DEG = 60;

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

/** Findings of every nozzle of an equipment (all warnings): knuckle zone, overlapping reinforcement zones, support, placeholder / unverified flange. */
export function nozzleFindings(template: EquipmentTemplate, nozzles: readonly NozzleRecord[]): NozzleFinding[] {
  const out: NozzleFinding[] = [];
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
    if (template.kind === 'vessel') for (const found of supportFindings(template, nozzle)) warn(found);
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
