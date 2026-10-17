/**
 * Cross-sections and closed-form quantities of the formed features (flanged hole, bead). Sections are (radial, axial) / (across, up) pairs
 * measured from the BOTTOM face of the flat (axial 0 = bottom, T = top) for a form on the +normal side; `mirrorChain` flips a section for
 * a form on the -normal side.
 */

import type { Vec2 } from '@core/model/types';
import type { CurveSegment } from '@core/model/curve';
import type { BeadForm, FlangedHoleForm } from '@core/model/sheetMetal';
import { sampleProfile } from '@core/geometry/curveSegments';

export interface Section {
  readonly curves: CurveSegment<Vec2>[];
  readonly profile: Vec2[];
}

const line = (a: Vec2, b: Vec2): CurveSegment<Vec2> => ({ type: 'line', points: [a, b] });
const arc = (a: Vec2, through: Vec2, b: Vec2): CurveSegment<Vec2> => ({ type: 'arc', points: [a, through, b] });
const sectionOf = (curves: CurveSegment<Vec2>[]): Section => ({ curves, profile: sampleProfile(curves) });

/** The section with axial coordinate z replaced by `thickness - z` (form on the -normal side). */
export function mirrorSection(section: Section, thickness: number): Section {
  const flip = ([x, z]: Vec2): Vec2 => [x, thickness - z];
  return sectionOf(
    section.curves.map(
      (segment): CurveSegment<Vec2> =>
        segment.type === 'arc'
          ? arc(flip(segment.points[0]), flip(segment.points[1]), flip(segment.points[2]))
          : line(flip(segment.points[0] as Vec2), flip(segment.points[1] as Vec2)),
    ),
  );
}

export interface LipGeometry {
  /** Radial section of the lip (bend sector + straight wall) revolved 360 degrees about the hole axis. */
  readonly section: Section;
  /** Radius of the physical hole in the flat = where the bend starts. */
  readonly cutRadius: number;
  /** Straight wall length along the lip. */
  readonly wall: number;
  /** Smallest radius of the lip (must stay > 0). */
  readonly innerRadius: number;
}

/**
 * Lip of a flanged hole on the +normal side: concave bend of inside radius `lipRadius` through `angle`, then a straight wall so the free end
 * rises `flangeHeight` above the flat's top face.
 * @failure wall length <= 0, lip crossing the hole axis, non-positive size -> null
 */
export function lipGeometry(form: FlangedHoleForm, thickness: number): LipGeometry | null {
  const { holeDiameter, flangeHeight: height, angle, lipRadius: radius } = form;
  if (!(holeDiameter > 0) || !(height > 0) || !(radius > 0) || !(angle > 0 && angle <= Math.PI / 2 + 1e-9)) return null;
  const [sin, cos] = [Math.sin(angle), Math.cos(angle)];
  const wall = (height - radius * (1 - cos)) / sin;
  const cutRadius = holeDiameter / 2 + thickness + radius;
  const centre: Vec2 = [cutRadius, thickness + radius];
  const at = (rho: number, phi: number): Vec2 => [centre[0] - rho * Math.sin(phi), centre[1] - rho * Math.cos(phi)];
  const along = (point: Vec2): Vec2 => [point[0] - wall * cos, point[1] + wall * sin];
  const [concaveEnd, convexEnd] = [at(radius, angle), at(radius + thickness, angle)];
  const innerRadius = along(convexEnd)[0];
  if (!(wall > 1e-9) || !(innerRadius > 1e-9)) return null;
  const section = sectionOf([
    arc([cutRadius, thickness], at(radius, angle / 2), concaveEnd),
    line(concaveEnd, along(concaveEnd)),
    line(along(concaveEnd), along(convexEnd)),
    line(along(convexEnd), convexEnd),
    arc(convexEnd, at(radius + thickness, angle / 2), [cutRadius, 0]),
    line([cutRadius, 0], [cutRadius, thickness]),
  ]);
  return { section, cutRadius, wall, innerRadius };
}

/** Volume of the lip (bend sector + wall) revolved about the hole axis, from Pappus' theorem integrated in closed form. */
export function lipVolume(form: FlangedHoleForm, thickness: number): number {
  const lip = lipGeometry(form, thickness);
  if (lip === null) return 0;
  const { angle, lipRadius: r } = form;
  const outer = r + thickness;
  const bend = 2 * Math.PI * ((lip.cutRadius * angle * (outer ** 2 - r ** 2)) / 2 - ((1 - Math.cos(angle)) * (outer ** 3 - r ** 3)) / 3);
  const wallStart = lip.cutRadius - (r + thickness / 2) * Math.sin(angle);
  const wall = 2 * Math.PI * thickness * (lip.wall * wallStart - (Math.cos(angle) * lip.wall ** 2) / 2);
  return bend + wall;
}

/** Radius of the hole in the flat pattern: tangent circle radius minus the neutral bend length and the wall (approximate stretch-flange model). */
export const developedHoleRadius = (lip: LipGeometry, form: FlangedHoleForm, k: number, thickness: number): number =>
  lip.cutRadius - form.angle * (form.lipRadius + k * thickness) - lip.wall;

export interface BeadGeometry {
  /** Half-width of the crown arc where it meets the flat's top face. */
  readonly halfWidth: number;
  /** Half-width of the removed trapezoid on the bottom face. */
  readonly bottomHalfWidth: number;
  /** Half-angle of the arch about the vertical, radians. */
  readonly halfAngle: number;
  /** Full arch section (across, up), symmetric about across = 0. */
  readonly arch: Section;
  /** Half arch (across >= 0) for the revolved round ends. */
  readonly halfArch: Section;
  /** Removed region of the flat (full / half), extended past both faces so the cut is not coplanar. */
  readonly tool: Section;
  readonly halfTool: Section;
  /** Footprint half-width used for the displayed mesh hole (mean of top and bottom). */
  readonly footprintHalfWidth: number;
}

/**
 * Circular-arch bead on the +normal side: outer radius R + T about a centre at z = depth - R, junctions on the radial rays through the crown
 * ends (no blend radii).
 * @failure radius or depth <= 0, depth >= radius (the arch centre must sit below the bottom face) -> null
 */
export function beadGeometry(form: BeadForm, thickness: number): BeadGeometry | null {
  const { radius, depth } = form;
  if (!(radius > 0) || !(depth > 0) || !(depth < radius) || !(thickness > 0)) return null;
  const outer = radius + thickness;
  const centreZ = depth - radius;
  const top = thickness - centreZ;
  const halfWidth = Math.sqrt(outer ** 2 - top ** 2);
  const halfAngle = Math.asin(halfWidth / outer);
  const rayX = (z: number): number => ((z - centreZ) * halfWidth) / top;
  const innerEnd: Vec2 = [(radius * halfWidth) / outer, centreZ + (radius * top) / outer];
  const crownEnd: Vec2 = [halfWidth, thickness];
  const mirrorX = ([x, z]: Vec2): Vec2 => [-x, z];
  const onArc = (rho: number, angle: number): Vec2 => [rho * Math.sin(angle), centreZ + rho * Math.cos(angle)];
  const arch = sectionOf([
    arc(mirrorX(crownEnd), [0, thickness + depth], crownEnd),
    line(crownEnd, innerEnd),
    arc(innerEnd, [0, centreZ + radius], mirrorX(innerEnd)),
    line(mirrorX(innerEnd), mirrorX(crownEnd)),
  ]);
  const halfArch = sectionOf([
    arc([0, thickness + depth], onArc(outer, halfAngle / 2), crownEnd),
    line(crownEnd, innerEnd),
    arc(innerEnd, onArc(radius, halfAngle / 2), [0, centreZ + radius]),
    line([0, centreZ + radius], [0, thickness + depth]),
  ]);
  const below = Math.min(thickness / 2, -centreZ / 2);
  const above = thickness / 2;
  const [low, high] = [-below, thickness + above];
  const halfTool = sectionOf([
    line([0, low], [rayX(low), low]),
    line([rayX(low), low], [rayX(high), high]),
    line([rayX(high), high], [0, high]),
    line([0, high], [0, low]),
  ]);
  const tool = sectionOf([
    line([-rayX(low), low], [rayX(low), low]),
    line([rayX(low), low], [rayX(high), high]),
    line([rayX(high), high], [-rayX(high), high]),
    line([-rayX(high), high], [-rayX(low), low]),
  ]);
  const bottomHalfWidth = rayX(0);
  return { halfWidth, bottomHalfWidth, halfAngle, arch, halfArch, tool, halfTool, footprintHalfWidth: (halfWidth + bottomHalfWidth) / 2 };
}

/** Cross-section area change per unit bead length (arch area minus the removed trapezoid), closed form. */
export function beadAreaChange(form: BeadForm, thickness: number): number {
  const bead = beadGeometry(form, thickness);
  if (bead === null) return 0;
  const outer = form.radius + thickness;
  return bead.halfAngle * (outer ** 2 - form.radius ** 2) - thickness * (bead.halfWidth + bead.bottomHalfWidth);
}

/** Capsule (round ends) or rectangle (open ends) around the bead path, CCW, `halfWidth` either side. */
export function beadFootprint(start: Vec2, end: Vec2, halfWidth: number, endShape: BeadForm['endShape']): Vec2[] {
  const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
  const u: Vec2 = [(end[0] - start[0]) / length, (end[1] - start[1]) / length];
  const n: Vec2 = [-u[1], u[0]];
  const at = (centre: Vec2, along: number, across: number): Vec2 => [
    centre[0] + u[0] * along + n[0] * across,
    centre[1] + u[1] * along + n[1] * across,
  ];
  if (endShape === 'open') return [at(start, 0, -halfWidth), at(end, 0, -halfWidth), at(end, 0, halfWidth), at(start, 0, halfWidth)];
  const steps = 16;
  const cap = (centre: Vec2, from: number): Vec2[] =>
    Array.from({ length: steps + 1 }, (_, i): Vec2 => {
      const theta = from + (Math.PI * i) / steps;
      return at(centre, halfWidth * Math.cos(theta), halfWidth * Math.sin(theta));
    });
  return [...cap(end, -Math.PI / 2), ...cap(start, Math.PI / 2)];
}
