/**
 * Aerodynamic surface definitions (aerospace 02 SRF §3), owned by the `surfacing` plugin of `@aero` (`CadDocument.aero`, validated by its
 * `DocumentExtension`). The definitions are the recipe; the entities they point at (airfoil curve, wing loft) are ordinary saved entities.
 * Lengths are document units; the airfoil frame is chord-normalised (chord 1, leading edge at the origin, chord along +x, thickness +y).
 * The wing frame is x aft, y to the right, z up.
 */

import type { Vec2, Vec3 } from './vectors';

export type AirfoilSource =
  | { readonly type: 'naca4' | 'naca5'; readonly designation: string; readonly closedTrailingEdge: boolean; readonly pointsPerSide: number }
  | {
      readonly type: 'points';
      readonly format: 'selig' | 'lednicer';
      readonly name: string;
      readonly sha256: string;
      /** Raw coordinates in Selig order (upper trailing edge -> leading edge -> lower), as given before any normalisation. */
      readonly points: ReadonlyArray<Vec2>;
    };

/** Whether an input comes from a pinned source (SRF AF-32): generated sections are verified, imported ones only when their hash was pinned. */
export interface AirfoilProvenance {
  readonly verified: boolean;
  readonly source: string;
}

export interface AirfoilDef {
  readonly id: string;
  readonly source: AirfoilSource;
  readonly normalize: 'none' | 'chord';
  /** The planar `nurbs_curve` entity (cubic interpolation through every point), chord 1. */
  readonly entityId: string;
  readonly provenance: AirfoilProvenance;
}

export interface WingSection {
  readonly airfoilId: string;
  /** Spanwise station along +y from the root, document units. */
  readonly span: number;
  readonly chord: number;
  /** Nose-up rotation about the span axis at `twistLocation`, degrees. */
  readonly twistDeg: number;
}

export interface WingSegment {
  /** Sweep of the line at chord fraction `sweepLocation`, degrees. */
  readonly sweepDeg: number;
  readonly sweepLocation: number;
  /** Rise z = dy tan(dihedral) per unit span (the panel is sheared, projected span unchanged), degrees. */
  readonly dihedralDeg: number;
}

export interface WingDef {
  readonly id: string;
  readonly origin: Vec3;
  readonly sections: ReadonlyArray<WingSection>;
  /** One per span interval (sections.length - 1). */
  readonly segments: ReadonlyArray<WingSegment>;
  readonly twistLocation: number;
  readonly loft: 'linear' | 'smooth';
  readonly mirror: boolean;
  /** Right half first, then the mirrored left half when `mirror`. */
  readonly entityIds: ReadonlyArray<string>;
}

export interface AeroModel {
  readonly airfoils: Readonly<Record<string, AirfoilDef>>;
  readonly wings: Readonly<Record<string, WingDef>>;
}
