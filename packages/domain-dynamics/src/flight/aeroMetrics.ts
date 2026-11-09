/** Aero surface numbers of a flight run (13 FLT M4, FR-FLT-08): angle-of-attack and pivot ranges, lift / drag, peak load, table validity and staleness. */

import { AERO, AERO_SLOTS } from './aeroBlock';
import type { FlightLoop } from './flightBlock';
import { aeroBase } from './flightBlock';

export interface AeroSurfaceMetrics {
  readonly bodyId: string;
  readonly alphaDeg: { readonly min: number; readonly max: number; readonly final: number };
  readonly pivotDeg: { readonly final: number };
  readonly finalCl: number;
  readonly finalCd: number;
  readonly finalLiftN: number;
  readonly finalDragN: number;
  readonly peakLiftN: number;
  readonly peakLiftTimeS: number;
  readonly validAlphaDeg: readonly [number, number];
  /** Share of the physics steps with the angle of attack or pivot angle outside the table. */
  readonly outsideFraction: number;
  /** The body (or its entities) changed since the table was generated. */
  readonly stale: boolean;
  readonly unverified: boolean;
}

/** Per-surface metrics of `loop` read from the final aux state (`final(slot)`), with their warnings. */
export function aeroMetrics(
  loop: FlightLoop,
  final: (slot: number) => number,
  physicsSteps: number,
  staleIds: readonly string[],
): { readonly surfaces: Record<string, AeroSurfaceMetrics>; readonly warnings: string[] } {
  const warnings: string[] = [];
  const surfaces: Record<string, AeroSurfaceMetrics> = {};
  loop.aero.forEach(({ surface }, i) => {
    const at = (field: number): number => final(aeroBase(loop) + AERO_SLOTS * i + field);
    const outside = at(AERO.outsideSteps);
    const stale = staleIds.includes(surface.id);
    surfaces[surface.id] = {
      bodyId: surface.bodyId,
      alphaDeg: { min: at(AERO.minAlpha), max: at(AERO.maxAlpha), final: at(AERO.alpha) },
      pivotDeg: { final: at(AERO.pivot) },
      finalCl: at(AERO.cl),
      finalCd: at(AERO.cd),
      finalLiftN: at(AERO.lift),
      finalDragN: at(AERO.drag),
      peakLiftN: at(AERO.peakLift),
      peakLiftTimeS: at(AERO.peakLiftTime),
      validAlphaDeg: surface.validAlphaDeg,
      outsideFraction: outside / Math.max(1, physicsSteps),
      stale,
      unverified: surface.unverified || stale,
    };
    if (outside > 0)
      warnings.push(
        `FLT_AERO_OUTSIDE_TABLE: surface '${surface.id}' flew at α ${at(AERO.minAlpha).toPrecision(3)}° to ${at(AERO.maxAlpha).toPrecision(3)}°, outside its table [${surface.table.alphaDeg[0]}, ${surface.table.alphaDeg[surface.table.alphaDeg.length - 1]}]° (or its pivot range) for ${((100 * outside) / Math.max(1, physicsSteps)).toPrecision(3)} % of the steps: the coefficients were held at the table edge`,
      );
    if (stale)
      warnings.push(
        `FLT_AERO_TABLE_STALE: the body '${surface.bodyId}' or its entities changed since the table of '${surface.id}' was generated: run generate_aero_table again`,
      );
  });
  return { surfaces, warnings };
}
