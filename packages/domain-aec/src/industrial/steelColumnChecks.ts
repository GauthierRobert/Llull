/**
 * Column verification (EN 1993-1-1): axial load = beam reactions at every level above the segment
 * plus self weight, checked per storey segment between beam levels as a braced column
 * (Lcr = segment length, both axes): cross-section Npl,Rd (§6.2.4) and flexural buckling Nb,Rd (§6.3.1).
 * @layer domain-aec
 * @pure
 */

import { memberBuckling } from './steelDesign';
import { GAMMA_IMPOSED, GAMMA_PERMANENT, type ColumnNode } from './steelFraming';
import { selfWeightPerMetre, type SteelBar } from './steelMemberBars';
import {
  analysedRow,
  columnSection,
  metres,
  ULS_COMBINATION,
  type CheckLine,
  type MemberRow,
} from './steelMemberRows';

/** Beam ends whose axes differ by less than this are one level, mm. */
const LEVEL_TOLERANCE = 300;

export interface ColumnSegment {
  /** Axis heights of the segment, mm. */
  readonly from: number;
  readonly to: number;
  /** Factored axial force at the segment foot, kN. */
  readonly axial: number;
  /** Characteristic self weight of the segment, kN. */
  readonly weight: number;
}

/**
 * Segments of a column between its beam levels (and the stub above the top level).
 * @invariant axial(from) = Σ ULS reactions of levels at / above the segment top + 1.35 × self weight above its foot
 */
export function columnSegments(
  column: SteelBar,
  nodes: ReadonlyArray<ColumnNode>,
): ColumnSegment[] {
  const low = Math.min(column.start[2], column.end[2]);
  const high = Math.max(column.start[2], column.end[2]);
  const weightPerMetre = column.profile ? selfWeightPerMetre(column.profile) : 0;
  const groups: ColumnNode[][] = [];
  for (const node of [...nodes].sort((a, b) => a.zAxis - b.zAxis)) {
    const last = groups[groups.length - 1];
    const previous = last?.[last.length - 1];
    if (last && previous && node.zAxis - previous.zAxis <= LEVEL_TOLERANCE) last.push(node);
    else groups.push([node]);
  }
  const levels = groups.map((group) => ({
    z: group.reduce((sum, node) => sum + node.zAxis, 0) / group.length,
    load: group.reduce(
      (sum, node) => sum + GAMMA_PERMANENT * node.permanent + GAMMA_IMPOSED * node.imposed,
      0,
    ),
  }));
  const inside = levels.map((level) => ({ ...level, z: Math.min(high, Math.max(low, level.z)) }));
  const boundaries = [low, ...inside.map((level) => level.z), high].filter(
    (z, index, all) => index === 0 || z - (all[index - 1] as number) >= 1,
  );
  const segments: ColumnSegment[] = [];
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index] as number;
    const to = boundaries[index + 1] as number;
    const above = inside
      .filter((level) => level.z >= to - 0.5)
      .reduce((sum, level) => sum + level.load, 0);
    segments.push({
      from,
      to,
      axial: above + (GAMMA_PERMANENT * weightPerMetre * (high - from)) / 1000,
      weight: (weightPerMetre * (to - from)) / 1000,
    });
  }
  return segments;
}

const curveText = (shape: string, slender: boolean): string =>
  shape === 'I' ? (slender ? 'curves a/b' : 'curves b/c') : 'curve a';

/** Row of a column from its segments. */
export function checkColumn(column: SteelBar, segments: ReadonlyArray<ColumnSegment>): MemberRow {
  const gate = columnSection(column);
  if ('skipped' in gate) return gate.skipped;
  const { profile, sectionClass, resistance } = gate;
  let section: CheckLine | undefined;
  let buckling: CheckLine | undefined;
  for (const segment of segments) {
    const length = segment.to - segment.from;
    const axial = segment.axial * 1000;
    const sectionUtilisation = axial / resistance.axial;
    if (!section || sectionUtilisation > section.utilisation) {
      section = {
        name: 'cross-section compression (§6.2.4)',
        utilisation: sectionUtilisation,
        combination: ULS_COMBINATION,
        detail: `${profile.name} class ${sectionClass}, z ${metres(segment.from)}–${metres(segment.to)} m: N ${segment.axial.toFixed(0)} kN ≤ Npl,Rd ${(resistance.axial / 1000).toFixed(0)} kN`,
      };
    }
    const result = memberBuckling(profile, column.fy, axial, 0, { major: length, minor: length });
    if (!buckling || result.utilisation > buckling.utilisation) {
      const chi = Math.min(result.chiMajor, result.chiMinor);
      buckling = {
        name: 'flexural buckling (§6.3.1)',
        utilisation: result.utilisation,
        combination: ULS_COMBINATION,
        detail: `${profile.name} (${curveText(profile.shape, profile.h / profile.b > 1.2)}), z ${metres(segment.from)}–${metres(segment.to)} m, Lcr ${metres(length)} m: N ${segment.axial.toFixed(0)} kN ≤ Nb,Rd ${((chi * resistance.axial) / 1000).toFixed(0)} kN (χ ${chi.toFixed(2)})`,
      };
    }
  }
  return analysedRow(column, [section, buckling], {
    NEd: Math.max(0, ...segments.map((segment) => segment.axial)),
    segments: segments.length,
  });
}
