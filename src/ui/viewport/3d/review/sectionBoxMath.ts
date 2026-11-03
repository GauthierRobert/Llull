// Section box geometry for the viewport (pure): its clip planes in render space and the face resize of the drag gizmo.
// Half-space convention of the model (`SectionPlane`): the points with `normal . p > offset` are removed.

import type { SectionBox, SectionPlane } from '@core/model/review';
import type { Vec3 } from '@core/model/vectors';

/** A three.js clipping plane: a point is kept while `normal . p + constant >= 0` (render space). */
export interface ClipPlaneSpec {
  readonly normal: Vec3;
  readonly constant: number;
}

export type FaceAxis = 0 | 1 | 2;
export type FaceSign = -1 | 1;

/** Smallest side a drag may leave (document units). */
const MIN_SECTION_SIZE = 1e-3;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Turn about +Z (the box rotates about its centre). */
function rotateZ(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c, v[2]];
}

const unitAxis = (axis: FaceAxis, sign: FaceSign): Vec3 => [axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0];

/** The box form (min and max both set) of a section box, else null. */
function boxForm(box: SectionBox): { min: Vec3; max: Vec3; rotation: number } | null {
  if (box.min === undefined || box.max === undefined) return null;
  return { min: box.min, max: box.max, rotation: box.rotationZ ?? 0 };
}

/** The six faces of a box-form section as half-spaces; the planes of a plane-form one; [] when it has neither. */
export function sectionHalfSpaces(box: SectionBox): readonly SectionPlane[] {
  const form = boxForm(box);
  if (form === null) return box.planes ?? [];
  const centre: Vec3 = [(form.min[0] + form.max[0]) / 2, (form.min[1] + form.max[1]) / 2, (form.min[2] + form.max[2]) / 2];
  const faces: SectionPlane[] = [];
  for (const axis of [0, 1, 2] as const) {
    const half = (form.max[axis] - form.min[axis]) / 2;
    for (const sign of [-1, 1] as const) {
      const normal = rotateZ(unitAxis(axis, sign), form.rotation);
      faces.push({ normal, offset: dot(normal, centre) + half });
    }
  }
  return faces;
}

/** Clip planes (render space = world - renderOrigin) that keep what the section box keeps. */
export function sectionClipPlanes(box: SectionBox, renderOrigin: Vec3): ClipPlaneSpec[] {
  return sectionHalfSpaces(box).map(({ normal, offset }) => ({
    normal: [-normal[0], -normal[1], -normal[2]],
    constant: offset - dot(normal, renderOrigin),
  }));
}

export interface SectionFace {
  readonly axis: FaceAxis;
  readonly sign: FaceSign;
  /** World centre of the face. */
  readonly centre: Vec3;
  /** Outward unit normal, world. */
  readonly normal: Vec3;
  /** Distance of the face from the box centre. */
  readonly distance: number;
  /** Face size along the two other box axes (for the handle's footprint). */
  readonly extent: readonly [number, number];
}

/** The six faces of a box-form section (empty for the plane form, which has no faces to drag). */
export function sectionFaces(box: SectionBox): readonly SectionFace[] {
  const form = boxForm(box);
  if (form === null) return [];
  const centre: Vec3 = [(form.min[0] + form.max[0]) / 2, (form.min[1] + form.max[1]) / 2, (form.min[2] + form.max[2]) / 2];
  const size: Vec3 = [form.max[0] - form.min[0], form.max[1] - form.min[1], form.max[2] - form.min[2]];
  const faces: SectionFace[] = [];
  for (const axis of [0, 1, 2] as const) {
    for (const sign of [-1, 1] as const) {
      const normal = rotateZ(unitAxis(axis, sign), form.rotation);
      const distance = size[axis] / 2;
      const others = ([0, 1, 2] as const).filter((other) => other !== axis);
      faces.push({
        axis,
        sign,
        centre: [centre[0] + normal[0] * distance, centre[1] + normal[1] * distance, centre[2] + normal[2] * distance],
        normal,
        distance,
        extent: [size[others[0] ?? 0], size[others[1] ?? 0]],
      });
    }
  }
  return faces;
}

/**
 * The box with one face moved so that it lies `distance` from the ORIGINAL centre (outward positive); the opposite face stays put.
 * Null when the box is not box-form or the result would be thinner than `MIN_SECTION_SIZE`.
 */
export function resizeSectionFace(box: SectionBox, axis: FaceAxis, sign: FaceSign, distance: number): { min: Vec3; max: Vec3 } | null {
  const form = boxForm(box);
  if (form === null || !Number.isFinite(distance)) return null;
  const half = (form.max[axis] - form.min[axis]) / 2;
  const newSize = distance + half;
  if (newSize < MIN_SECTION_SIZE) return null;
  const shift = (distance - half) / 2;
  const normal = rotateZ(unitAxis(axis, sign), form.rotation);
  const centre: Vec3 = [(form.min[0] + form.max[0]) / 2, (form.min[1] + form.max[1]) / 2, (form.min[2] + form.max[2]) / 2];
  const moved: Vec3 = [centre[0] + normal[0] * shift, centre[1] + normal[1] * shift, centre[2] + normal[2] * shift];
  // Half sizes in the box frame: only `axis` changes.
  const halves: [number, number, number] = [
    (form.max[0] - form.min[0]) / 2,
    (form.max[1] - form.min[1]) / 2,
    (form.max[2] - form.min[2]) / 2,
  ];
  halves[axis] = newSize / 2;
  return {
    min: [moved[0] - halves[0], moved[1] - halves[1], moved[2] - halves[2]],
    max: [moved[0] + halves[0], moved[1] + halves[1], moved[2] + halves[2]],
  };
}

/** `box` with new `min` / `max` (the draft shown while a face is dragged). */
export function withBounds(box: SectionBox, bounds: { min: Vec3; max: Vec3 }): SectionBox {
  return { ...box, min: bounds.min, max: bounds.max };
}
