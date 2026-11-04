/** Types of the stress layout (07 PST §5.1): finite elements with the component and SIF data attached, and the layout result. */

import type { Vec3 } from '@core/model/vectors';

export interface FeElement {
  readonly id: string;
  readonly a: number;
  readonly b: number;
  readonly pipeId: string;
  readonly kind: 'straight' | 'bend';
  readonly odMm: number;
  readonly wallMm: number;
  /** Bend elements: flexibility and stress intensification of the bend, and the unit normal of the bend plane. */
  readonly bend?: { readonly radiusMm: number; readonly k: number; readonly ii: number; readonly io: number; readonly normal: Vec3 };
  /** Valve, flange, reducer or declared rigid body this element belongs to. */
  readonly component?: ElementComponent;
  /** SIFs that act at the end node named in each entry (tee junctions, user overrides): the stress there uses them, not the pipe's i = 1. */
  readonly endSifs?: readonly ElementEndSif[];
}

export interface ElementComponent {
  readonly key: string;
  readonly kind: 'valve' | 'reducer' | 'flange' | 'rigid';
  readonly rigid: boolean;
  readonly stiffnessFactor: number;
  /** Stated weight of the whole component, kg (null: not stated, the element carries the pipe weight). */
  readonly weightKg: number | null;
  /** Elements the component is split into (the weight is shared equally). */
  readonly elements: number;
}

export interface ElementEndSif {
  readonly node: number;
  readonly ii: number;
  readonly io: number;
  /** Unit normal of the plane of the bend / tee (in-plane bending is the moment along it). */
  readonly normal: Vec3;
  readonly source: string;
  /** Branch end of a tee: the wall of the header, for the effective section modulus. */
  readonly headerWallMm?: number;
}

export interface Attachment {
  readonly key: string;
  readonly pipeId: string;
  readonly point: Vec3;
}

export interface Junction {
  readonly node: number;
  readonly headerPipeId: string;
  readonly branchPipeId: string;
  readonly fitting: string;
  readonly h: number | null;
  readonly ii: number;
  readonly io: number;
}

export interface Layout {
  readonly nodes: readonly Vec3[];
  readonly elements: readonly FeElement[];
  /** Node index per attachment key, and the unit axis of the piece it sits on. */
  readonly attached: ReadonlyMap<string, { readonly node: number; readonly axis: Vec3 }>;
  /** Node indices of the pipe ends (merged across pipes within 1 mm). */
  readonly endNodes: ReadonlyMap<string, readonly [number, number]>;
  readonly sharpCorners: readonly string[];
  readonly junctions: readonly Junction[];
}

export interface LayoutFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly ids: readonly string[];
  readonly paths: readonly string[];
}
