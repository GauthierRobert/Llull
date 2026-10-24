/** Beam-lattice description a plugin hands to the 3MF writer (3MF Beam Lattice Extension 1.2): nodes, frusta between them, optional clipping mesh and balls. */

import type { MeshData } from './types';
import type { Vec3 } from './vectors';

export type BeamCap = 'sphere' | 'butt';

export interface LatticeBeam {
  /** Indices into `nodes`. */
  readonly a: number;
  readonly b: number;
  /** Radius at each end, document units. */
  readonly r1: number;
  readonly r2: number;
  readonly cap1: BeamCap;
  readonly cap2: BeamCap;
}

/** A lattice in document units and world coordinates. */
export interface BeamLatticeExport {
  readonly nodes: readonly Vec3[];
  readonly beams: readonly LatticeBeam[];
  /** Radius written as the lattice default, document units. */
  readonly radius: number;
  /** Ball radius at every node (the balls extension) or null. */
  readonly nodeRadius: number | null;
  /** Mesh that trims the beams (clipping mode inside), or null when the beams already end inside the region. */
  readonly clip: MeshData | null;
  /** The realised mesh of the lattice (what consumers without beam support print). */
  readonly representation: MeshData | null;
  /** Beams dropped (zero length, outside the region). */
  readonly dropped: number;
}

/** What a provider answers for an entity: a lattice, a reason it has none (the entity then exports as a mesh), or null when it is not a lattice body at all. */
export type BeamLatticeAnswer = BeamLatticeExport | string | null;
