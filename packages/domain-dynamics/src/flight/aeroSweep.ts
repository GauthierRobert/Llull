/** Vortex-lattice sweep inputs of generate_aero_table (13 FLT M4): body-axes sections to the flow frame, pivot rotation, result rows. */

import type { Vec3 } from '@core/model/vectors';
import { dot3 } from '@lib/vec3';
import { flowFrame, type ForwardAxis } from './aeroModel';
import type { LatticeRow } from './aeroTable';

const RAD = Math.PI / 180;

/** One section of a surface as the agent gives it: body axes, document units. */
export interface BodySection {
  readonly leadingEdge: Vec3;
  readonly chord: number;
  readonly incidenceDeg?: number | undefined;
}

/** Section in the flow frame of `forward` (x downstream, y spanwise, z up). */
interface FlowSection {
  readonly leadingEdge: Vec3;
  readonly chord: number;
  readonly incidenceDeg: number;
}

/** Point of the body axes in the flow frame of `forward`. */
export function toFlow(point: Vec3, forward: ForwardAxis): Vec3 {
  const frame = flowFrame(forward);
  return [dot3(point, frame.x), dot3(point, frame.y), point[2]];
}

/**
 * Sections in the flow frame, the pivoting ones turned by `pivot.deg` (nose up positive) about the spanwise axis through `pivot.point` (flow
 * frame): the leading edges rotate in the x-z plane and the incidence grows by the angle, as for a wing turned as a whole. The lattice measures
 * incidence and camber about the span direction of the section list, so a half wing running toward -y would turn nose-down for a positive
 * incidence: such a list is mirrored about y = 0 when the surface is mirrored anyway (`reflect`; coefficients are even in the mirror, the
 * lattice clustering is kept) and reversed otherwise.
 */
export function flowSections(
  sections: readonly BodySection[],
  forward: ForwardAxis,
  pivot: { readonly point: Vec3; readonly deg: number } | null,
  reflect: boolean,
): FlowSection[] {
  const mapped = sections.map((section): FlowSection => {
    const [x, y, z] = toFlow(section.leadingEdge, forward);
    const incidenceDeg = section.incidenceDeg ?? 0;
    if (pivot === null || pivot.deg === 0) return { leadingEdge: [x, y, z], chord: section.chord, incidenceDeg };
    const theta = pivot.deg * RAD;
    const dx = x - pivot.point[0];
    const dz = z - pivot.point[2];
    return {
      leadingEdge: [
        pivot.point[0] + dx * Math.cos(theta) + dz * Math.sin(theta),
        y,
        pivot.point[2] - dx * Math.sin(theta) + dz * Math.cos(theta),
      ],
      chord: section.chord,
      incidenceDeg: incidenceDeg + pivot.deg,
    };
  });
  const run = (mapped[mapped.length - 1]?.leadingEdge[1] ?? 0) - (mapped[0]?.leadingEdge[1] ?? 0);
  if (!(run < 0)) return mapped;
  return reflect
    ? mapped.map((section) => ({ ...section, leadingEdge: [section.leadingEdge[0], -section.leadingEdge[1], section.leadingEdge[2]] }))
    : mapped.reverse();
}

/** Rows of an analyze_vortex_lattice `data.polar` (null when the data has no usable rows). */
export function latticeRows(data: unknown): LatticeRow[] | null {
  const polar = (data as { polar?: unknown } | undefined)?.polar;
  if (!Array.isArray(polar) || polar.length === 0) return null;
  const rows = polar.map((row: Record<string, unknown>) => ({
    alphaDeg: Number(row['alphaDeg']),
    cl: Number(row['cl']),
    cdi: Number(row['cdi']),
    cm: Number(row['cm']),
  }));
  return rows.every((row) => Object.values(row).every(Number.isFinite)) ? rows : null;
}
