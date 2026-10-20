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
interface AirfoilProvenance {
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
  /** Right half first (its id is the wing id), then the mirrored left half when `mirror`. */
  readonly entityIds: ReadonlyArray<string>;
}

/** One fuselage cross-section in the aircraft frame (FS along +x, BL along +y, WL along +z); see `loft_fuselage`. */
export interface FuselageSection {
  readonly type: 'point' | 'conic' | 'circle' | 'superellipse';
  readonly wl?: number | undefined;
  readonly bl?: number | undefined;
  readonly radius?: number | undefined;
  readonly halfBreadth?: number | undefined;
  readonly halfHeight?: number | undefined;
  readonly exponent?: number | undefined;
  readonly wlMaxBreadth?: number | undefined;
  readonly upper?: { readonly wlExtreme: number; readonly rho: number } | undefined;
  readonly lower?: { readonly wlExtreme: number; readonly rho: number } | undefined;
}

interface FuselageStation {
  readonly fs: number;
  readonly section: FuselageSection;
}

/** A fuselage defined by stations; its outer surface is the `nurbs_surface` entity `entityId` (the body id is that entity id). */
export interface BodyDef {
  readonly id: string;
  readonly stations: ReadonlyArray<FuselageStation>;
  readonly controlCurveIds: ReadonlyArray<string>;
  readonly degreeV: number;
  readonly entityId: string;
  /** Aircraft frame the stations were mapped through at loft time (absent = identity, older documents). */
  readonly frame?: AircraftFrame;
}

/** Aircraft coordinate frame: document position = datum + fs * fsAxis + bl * blAxis + wl * wlAxis (right-handed, orthonormal, in document units). */
export interface AircraftFrame {
  readonly datum: Vec3;
  readonly fsAxis: Vec3;
  readonly blAxis: Vec3;
  readonly wlAxis: Vec3;
}

export interface AeroModel {
  /** Set by set_aircraft_frame; absent = identity (FS along +x, BL along +y, WL along +z, datum at the origin). */
  readonly frame?: AircraftFrame;
  readonly airfoils: Readonly<Record<string, AirfoilDef>>;
  readonly wings: Readonly<Record<string, WingDef>>;
  /** Fuselage bodies (absent until the first `loft_fuselage`). */
  readonly bodies?: Readonly<Record<string, BodyDef>>;
}
