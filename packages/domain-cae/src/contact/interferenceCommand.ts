/** interference_fit: Lamé contact pressure and bore stresses of a shaft (or inner ring) pressed into a hub (PHY-06 FR-CNT-09). */

import { defineCommand, z } from '@core/commands/schema';
import { report } from '@core/commands/noop';
import type { CommandResult } from '@core/commands/types';
import { significantNumber } from '@lib/compactNumber';
import { NOT_APPROVED, refuseCnt } from './codes';
import { interferencePressure, planeStrainRing, ringStresses, type Ring } from './lame';

const material = { E: z.number().describe("Young's modulus, MPa (> 0)."), nu: z.number().describe("Poisson's ratio, in (-1, 0.5).") };

const valid = (ring: Ring): boolean => Number.isFinite(ring.E) && ring.E > 0 && Number.isFinite(ring.nu) && ring.nu > -1 && ring.nu < 0.5;

/**
 * @invariant read-only and pure; pressure from radial displacement compatibility at the interface (bisection, identical to the generator to
 *   1e-9); plane strain = plane stress with E/(1 - nu^2), nu/(1 - nu); every result `reviewRequired: true`
 * @failure radii not 0 <= innerRadius < interface < hub outer radius, E <= 0, nu outside (-1, 0.5), interference <= 0 ->
 *   CNT_LAME_INPUT_INVALID (refusal, unchanged doc)
 */
export const interferenceFit = defineCommand({
  name: 'interference_fit',
  description:
    'Interference (shrink / press) fit hand check with Lamé thick-cylinder theory: contact pressure from radial displacement compatibility, ' +
    'radial and hoop stresses at both radii of the inner part (solid shaft: innerRadius 0) and of the hub. Lengths mm, moduli MPa, stresses ' +
    'MPa (tension positive). plane: "stress" (thin discs) or "strain" (long parts); state it, there is no default. Returns data { ' +
    'contactPressure_MPa, inner { atBore (null for a solid shaft), atInterface }, outer { atInterface, atOuter } each { r_mm, radial_MPa, hoop_MPa }, formula, ' +
    'reviewRequired }. Example: solid steel shaft r 20 in a steel hub r_o 40, radial interference 0.01, plane stress -> p 39.375 MPa, hub ' +
    'bore hoop 65.625 MPa. Pure, reads no document; temperature-dependent fits: fit_at_temperature.',
  annotations: { readOnly: true },
  params: z.object({
    inner: z
      .object({
        innerRadius: z.number().describe('Bore radius of the inner part, mm (0 = solid shaft).'),
        outerRadius: z.number().describe('Outer radius of the inner part = interface radius, mm.'),
        ...material,
      })
      .describe('Shaft or inner ring.'),
    outer: z
      .object({ outerRadius: z.number().describe('Outer radius of the hub, mm.'), ...material })
      .describe('Hub (its bore is the interface).'),
    radialInterference: z.number().describe('Radial interference (shaft radius minus hub bore radius before assembly), mm (> 0).'),
    plane: z.enum(['stress', 'strain']).describe('Plane stress (thin discs) or plane strain (long cylinders).'),
  }),
  run: (doc, { inner, outer, radialInterference, plane }): CommandResult => {
    const innerRing: Ring = inner;
    const outerRing: Ring = { innerRadius: inner.outerRadius, outerRadius: outer.outerRadius, E: outer.E, nu: outer.nu };
    const radii = inner.innerRadius >= 0 && inner.innerRadius < inner.outerRadius && inner.outerRadius < outer.outerRadius;
    if (!radii || !valid(innerRing) || !valid(outerRing) || !(Number.isFinite(radialInterference) && radialInterference > 0))
      return refuseCnt(
        doc,
        'interference_fit',
        'CNT_LAME_INPUT_INVALID',
        'need 0 <= inner.innerRadius < inner.outerRadius < outer.outerRadius, E > 0, nu in (-1, 0.5) and radialInterference > 0',
        [],
        [radii ? 'radialInterference' : 'inner.innerRadius'],
      );
    const shaft = plane === 'strain' ? planeStrainRing(innerRing) : innerRing;
    const hub = plane === 'strain' ? planeStrainRing(outerRing) : outerRing;
    const p = interferencePressure(shaft, hub, radialInterference);
    const at = (ring: Ring, pIn: number, pOut: number, r: number): { r_mm: number; radial_MPa: number; hoop_MPa: number } => {
      const stress = ringStresses(ring, pIn, pOut, r);
      return { r_mm: r, radial_MPa: stress.radial, hoop_MPa: stress.hoop };
    };
    const hubBore = at(hub, p, 0, inner.outerRadius);
    const n = (value: number): string => significantNumber(value, 6);
    return report(
      doc,
      `interference_fit: plane ${plane}, interface r ${n(inner.outerRadius)} mm, radial interference ${n(radialInterference)} mm: contact pressure ${n(p)} MPa, hub bore hoop ${n(hubBore.hoop_MPa)} MPa. ${NOT_APPROVED}`,
      {
        plane,
        contactPressure_MPa: p,
        inner: {
          atBore: inner.innerRadius > 0 ? at(shaft, 0, p, inner.innerRadius) : null,
          atInterface: at(shaft, 0, p, inner.outerRadius),
        },
        outer: { atInterface: hubBore, atOuter: at(hub, p, 0, outer.outerRadius) },
        formula:
          'u(r) = A r + B/r, sigma_r = E/(1-nu^2)[(1+nu)A - (1-nu)B/r^2]; p solves u_hub(b) - u_shaft(b) = delta_r (plane strain: E -> E/(1-nu^2), nu -> nu/(1-nu))',
        source: 'Lamé thick cylinders (derived); generator validation/generate_cnt_reference.py',
        reviewRequired: true,
      },
    );
  },
});
