/**
 * Wing frame geometry: leading-edge stations from the span-wise sweep and dihedral, and the exact placement of an airfoil curve into the
 * wing frame (x aft, y right, z up). Placement is affine, so it keeps NURBS curves exactly NURBS curves.
 */

import type { WingSection, WingSegment } from '@core/model/aero';
import type { Vec3 } from '@core/model/types';
import type { NurbsCurveData } from '@lib/nurbs/types';
import { reverseCurve } from '@lib/nurbs/edit';

const RAD = Math.PI / 180;

export interface WingStation {
  readonly span: number;
  readonly chord: number;
  readonly twistDeg: number;
  /** Leading-edge position in the wing frame before twist. */
  readonly xLe: number;
  readonly zLe: number;
}

/**
 * Leading-edge stations of `sections` (root at span 0 of the wing frame origin): the line at chord fraction `sweepLocation` of each segment
 * is swept by `sweepDeg`, the panel rises z = dy tan(dihedral).
 */
export function wingStations(sections: ReadonlyArray<WingSection>, segments: ReadonlyArray<WingSegment>): WingStation[] {
  const stations: WingStation[] = [];
  sections.forEach((section, index) => {
    const previous = stations[index - 1];
    const before = sections[index - 1];
    const segment = segments[index - 1];
    if (previous === undefined || before === undefined || segment === undefined) {
      stations.push({ span: section.span, chord: section.chord, twistDeg: section.twistDeg, xLe: 0, zLe: 0 });
      return;
    }
    const dy = section.span - before.span;
    stations.push({
      span: section.span,
      chord: section.chord,
      twistDeg: section.twistDeg,
      xLe: previous.xLe + segment.sweepLocation * (before.chord - section.chord) + dy * Math.tan(segment.sweepDeg * RAD),
      zLe: previous.zLe + dy * Math.tan(segment.dihedralDeg * RAD),
    });
  });
  return stations;
}

/**
 * The unit-chord airfoil `curve` (chord along +x, thickness +y, leading edge at the origin) placed at `station`: scaled by the chord,
 * twisted nose-up by `twistDeg` about the chord fraction `twistLocation`, moved to the station (z of the section = thickness direction).
 * `mirror` reflects the section through the y = 0 plane (the left half wing).
 */
export function placeSection(curve: NurbsCurveData, station: WingStation, twistLocation: number, mirror: boolean): NurbsCurveData {
  const theta = station.twistDeg * RAD;
  const [cos, sin] = [Math.cos(theta), Math.sin(theta)];
  const placed = curve.poles.map(([x, y]): Vec3 => {
    const dx = station.chord * (x - twistLocation);
    const dz = station.chord * y;
    return [
      station.xLe + twistLocation * station.chord + dx * cos + dz * sin,
      mirror ? -station.span : station.span,
      station.zLe - dx * sin + dz * cos,
    ];
  });
  const moved: NurbsCurveData = { ...curve, poles: placed };
  // The loft convention wants each section wound counter-clockwise about the travel direction (+y right wing, -y left wing).
  return mirror ? moved : reverseCurve(moved);
}

