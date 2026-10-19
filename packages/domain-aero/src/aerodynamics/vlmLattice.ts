/**
 * Lifting surfaces -> vortex lattice. A surface is an ordered list of sections (leading edge, chord, incidence) read from the params or from
 * a `loft` entity (each ring: leading edge = the point of least x, trailing edge = the point of largest x, in world coordinates). Spanwise
 * stations are placed along the leading-edge polyline by arc length (uniform or tip-clustered sine spacing), chordwise uniformly; LE,
 * chord and incidence are interpolated linearly between sections. `mirror` adds the image about y = 0 (bound vortices kept along +span).
 */

import type { CadDocument, Vec3 } from '@core/model/types';
import { entityLocalToWorld } from '@core/geometry/entityFrame';

export interface LatticeSection {
  readonly leadingEdge: Vec3;
  readonly chord: number;
  /** Incidence (rad), nose up positive, about the local spanwise axis; already includes −α_L0 of the camber. */
  readonly incidence: number;
}

export interface LatticeSurface {
  readonly name: string;
  readonly sections: readonly LatticeSection[];
  readonly mirror: boolean;
  readonly spanwisePanels: number;
  readonly chordwisePanels: number;
  readonly spacing: 'cosine' | 'uniform';
}

export interface Lattice {
  /** PANEL_STRIDE f64 per panel (vlmKernel PANEL_STRIDE layout). */
  readonly panels: Float64Array;
  /** Per panel: surface index, strip index (spanwise, per surface, mirror strips negative from −1), panel area. */
  readonly surfaceOf: Int32Array;
  readonly stripOf: Int32Array;
  readonly areaOf: Float64Array;
  /** Per surface and strip (positive side only): strip centre point, chord, width. */
  readonly strips: readonly (readonly { readonly centre: Vec3; readonly chord: number; readonly width: number }[])[];
  /** Planform area per surface (projected on the plane normal to its panels, both sides when mirrored). */
  readonly surfaceArea: readonly number[];
  /** Mean aerodynamic chord and span (tip to tip when mirrored) per surface. */
  readonly meanChord: readonly number[];
  readonly span: readonly number[];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => add(a, scale(sub(b, a), t));

interface Station {
  readonly le: Vec3;
  readonly chord: number;
  readonly incidence: number;
  /** Unit spanwise direction (LE polyline tangent projected normal to x) and chord direction (incidence applied). */
  readonly chordDir: Vec3;
}

/** Spanwise unit vector of a segment: the LE direction with its x component removed (chords stay streamwise). */
function spanDirection(a: Vec3, b: Vec3): Vec3 {
  const d: Vec3 = [0, b[1] - a[1], b[2] - a[2]];
  const n = length(d);
  return n === 0 ? [0, 1, 0] : scale(d, 1 / n);
}

function station(sections: readonly LatticeSection[], cumulative: readonly number[], s: number): Station {
  let k = 0;
  while (k < sections.length - 2 && s > (cumulative[k + 1] as number)) k += 1;
  const a = sections[k] as LatticeSection;
  const b = sections[k + 1] as LatticeSection;
  const s0 = cumulative[k] as number;
  const s1 = cumulative[k + 1] as number;
  const t = s1 > s0 ? Math.min(1, Math.max(0, (s - s0) / (s1 - s0))) : 0;
  const incidence = a.incidence + (b.incidence - a.incidence) * t;
  const span = spanDirection(a.leadingEdge, b.leadingEdge);
  const up = cross([1, 0, 0], span);
  return {
    le: lerp(a.leadingEdge, b.leadingEdge, t),
    chord: a.chord + (b.chord - a.chord) * t,
    incidence,
    chordDir: sub(scale([1, 0, 0], Math.cos(incidence)), scale(up, Math.sin(incidence))),
  };
}

const at = (st: Station, xi: number): Vec3 => add(st.le, scale(st.chordDir, st.chord * xi));

/** Spanwise station fractions 0..1: uniform, or sine spacing (cosine spacing of the full span, clustered at the tip). */
const fractions = (count: number, spacing: 'cosine' | 'uniform', mirror: boolean): number[] =>
  Array.from({ length: count + 1 }, (_, k) =>
    spacing === 'uniform' ? k / count : mirror ? Math.sin((Math.PI * k) / (2 * count)) : (1 - Math.cos((Math.PI * k) / count)) / 2,
  );

/** Builds the lattice of `surfaces` (each with ≥ 2 sections and a positive span). */
export function buildLattice(surfaces: readonly LatticeSurface[]): Lattice {
  const values: number[] = [];
  const surfaceOf: number[] = [];
  const stripOf: number[] = [];
  const areaOf: number[] = [];
  const strips: { centre: Vec3; chord: number; width: number }[][] = [];
  const surfaceArea: number[] = [];
  const meanChord: number[] = [];
  const span: number[] = [];
  surfaces.forEach((surface, si) => {
    const cumulative = [0];
    for (let k = 1; k < surface.sections.length; k += 1) {
      const a = (surface.sections[k - 1] as LatticeSection).leadingEdge;
      const b = (surface.sections[k] as LatticeSection).leadingEdge;
      cumulative.push((cumulative[k - 1] as number) + Math.hypot(b[1] - a[1], b[2] - a[2]));
    }
    const total = cumulative[cumulative.length - 1] as number;
    const spanFractions = fractions(surface.spanwisePanels, surface.spacing, surface.mirror);
    const stations = spanFractions.map((f) => station(surface.sections, cumulative, f * total));
    const own: { centre: Vec3; chord: number; width: number }[] = [];
    let area = 0;
    let chordArea = 0;
    const sides = surface.mirror ? [1, -1] : [1];
    for (let j = 0; j < surface.spanwisePanels; j += 1) {
      const left = stations[j] as Station;
      const right = stations[j + 1] as Station;
      const middle = station(surface.sections, cumulative, (((spanFractions[j] as number) + (spanFractions[j + 1] as number)) / 2) * total);
      const width = Math.hypot(right.le[1] - left.le[1], right.le[2] - left.le[2]);
      const stripArea = ((left.chord + right.chord) / 2) * width;
      area += stripArea;
      chordArea += ((left.chord * left.chord + left.chord * right.chord + right.chord * right.chord) / 3) * width;
      own.push({ centre: at(middle, 0.25), chord: middle.chord, width });
      for (let i = 0; i < surface.chordwisePanels; i += 1) {
        const x0 = i / surface.chordwisePanels;
        const x1 = (i + 1) / surface.chordwisePanels;
        const a = at(left, x0 + 0.25 * (x1 - x0));
        const b = at(right, x0 + 0.25 * (x1 - x0));
        const c = lerp(at(left, x0 + 0.75 * (x1 - x0)), at(right, x0 + 0.75 * (x1 - x0)), 0.5);
        const diagonal = cross(sub(at(right, x1), at(left, x0)), sub(at(left, x1), at(right, x0)));
        const normalLength = length(diagonal);
        const normal = scale(diagonal, -1 / normalLength);
        const panelArea = normalLength / 2;
        for (const side of sides) {
          const m = (p: Vec3): Vec3 => [p[0], side * p[1], p[2]];
          const [pa, pb] = side === 1 ? [a, b] : [m(b), m(a)];
          values.push(...pa, ...pb, ...m(c), normal[0], side * normal[1], normal[2]);
          surfaceOf.push(si);
          stripOf.push(side === 1 ? j : -1 - j);
          areaOf.push(panelArea);
        }
      }
    }
    strips.push(own);
    surfaceArea.push(area * sides.length);
    meanChord.push(chordArea / area);
    span.push(total * sides.length);
  });
  return {
    panels: Float64Array.from(values),
    surfaceOf: Int32Array.from(surfaceOf),
    stripOf: Int32Array.from(stripOf),
    areaOf: Float64Array.from(areaOf),
    strips,
    surfaceArea,
    meanChord,
    span,
  };
}

/**
 * Sections of a loft entity in world coordinates, ordered along the span (y, then z): one per ring, leading edge = least-x point,
 * trailing edge = largest-x point, incidence from their height difference.
 * @failure not a loft / fewer than 2 rings / a ring of zero chord -> message
 */
export function loftSections(doc: CadDocument, entityId: string): LatticeSection[] | string {
  const entity = doc.entities[entityId];
  if (entity === undefined) return `no entity ${entityId}`;
  if (entity.kind !== 'loft') return `${entityId} is a ${entity.kind}, not a loft`;
  const sections = entity.rings.map((ring): LatticeSection | null => {
    const world = ring.map((point) => entityLocalToWorld(entity, point));
    const le = world.reduce((best, p) => (p[0] < best[0] ? p : best), world[0] as Vec3);
    const te = world.reduce((best, p) => (p[0] > best[0] ? p : best), world[0] as Vec3);
    const chord = Math.hypot(te[0] - le[0], te[2] - le[2]);
    return chord > 0 ? { leadingEdge: le, chord, incidence: Math.atan2(le[2] - te[2], te[0] - le[0]) } : null;
  });
  if (sections.length < 2) return `${entityId} has fewer than 2 sections`;
  if (sections.some((s) => s === null)) return `${entityId} has a section of zero chord`;
  return (sections as LatticeSection[]).sort((a, b) => a.leadingEdge[1] - b.leadingEdge[1] || a.leadingEdge[2] - b.leadingEdge[2]);
}
