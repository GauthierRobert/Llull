// Pure line geometry of the light / camera glyphs (flat xyz pairs for LineSegments) in the entity's local frame: it aims along -Z, a
// camera has +Y up. Glyphs are drawn at a unit size and scaled per frame to a constant screen size, except an area light's rectangle,
// which is its real size. Also the 2D top-view symbol.

import { cameraVerticalFov, type CameraFields, type LightFields } from '@core/model/sceneKinds';
import type { Vec3 } from '@core/model/types';

type Segments = number[];

const CIRCLE_STEPS = 24;

function pushLine(out: Segments, a: Vec3, b: Vec3): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/** A circle of `radius` in the plane normal to `axis` at depth `z` along -Z (axis 2), or about X / Y through the origin. */
function pushCircle(out: Segments, radius: number, axis: 0 | 1 | 2, z = 0): void {
  const point = (t: number): Vec3 => {
    const u = Math.cos(t) * radius;
    const v = Math.sin(t) * radius;
    return axis === 0 ? [0, u, v] : axis === 1 ? [u, 0, v] : [u, v, z];
  };
  for (let i = 0; i < CIRCLE_STEPS; i++) {
    pushLine(out, point((i / CIRCLE_STEPS) * Math.PI * 2), point(((i + 1) / CIRCLE_STEPS) * Math.PI * 2));
  }
}

function pushArrow(out: Segments, length: number, head: number): void {
  pushLine(out, [0, 0, 0], [0, 0, -length]);
  for (const [x, y] of [
    [head, 0],
    [-head, 0],
    [0, head],
    [0, -head],
  ] as const) {
    pushLine(out, [0, 0, -length], [x, y, -length + head * 1.6]);
  }
}

export interface Glyph {
  readonly positions: number[];
  /** True: drawn at a constant screen size; false: real document size (area light). */
  readonly screenScaled: boolean;
}

export function lightGlyph(light: Pick<LightFields, 'lightType' | 'coneAngle' | 'width' | 'height'>): Glyph {
  const positions: Segments = [];
  switch (light.lightType) {
    case 'sun': {
      pushCircle(positions, 0.28, 2);
      for (let i = 0; i < 8; i++) {
        const t = (i / 8) * Math.PI * 2;
        pushLine(positions, [Math.cos(t) * 0.38, Math.sin(t) * 0.38, 0], [Math.cos(t) * 0.58, Math.sin(t) * 0.58, 0]);
      }
      pushArrow(positions, 1.6, 0.16);
      return { positions, screenScaled: true };
    }
    case 'point': {
      pushCircle(positions, 0.26, 0);
      pushCircle(positions, 0.26, 1);
      pushCircle(positions, 0.26, 2);
      for (const [x, y, z] of [
        [1, 0, 0],
        [-1, 0, 0],
        [0, 1, 0],
        [0, -1, 0],
        [0, 0, 1],
        [0, 0, -1],
      ] as const) {
        pushLine(positions, [x * 0.36, y * 0.36, z * 0.36], [x * 0.55, y * 0.55, z * 0.55]);
      }
      return { positions, screenScaled: true };
    }
    case 'spot': {
      const half = Math.min((light.coneAngle ?? Math.PI / 4) / 2, Math.PI / 2 - 0.05);
      const depth = Math.min(1, 0.8 / Math.tan(half));
      const radius = depth * Math.tan(half);
      pushCircle(positions, radius, 2, -depth);
      for (const [x, y] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        pushLine(positions, [0, 0, 0], [x * radius, y * radius, -depth]);
      }
      return { positions, screenScaled: true };
    }
    case 'area': {
      const hw = (light.width ?? 1) / 2;
      const hh = (light.height ?? 1) / 2;
      const corners: Vec3[] = [
        [-hw, -hh, 0],
        [hw, -hh, 0],
        [hw, hh, 0],
        [-hw, hh, 0],
      ];
      corners.forEach((corner, i) => pushLine(positions, corner, corners[(i + 1) % 4] ?? corner));
      pushLine(positions, corners[0] ?? [0, 0, 0], corners[2] ?? [0, 0, 0]);
      pushLine(positions, corners[1] ?? [0, 0, 0], corners[3] ?? [0, 0, 0]);
      const arrow = Math.max(hw, hh);
      pushArrow(positions, arrow, arrow * 0.25);
      return { positions, screenScaled: false };
    }
  }
}

/** Frustum of a camera at unit scale: apex at the origin, far rectangle at the sensor's field of view, an "up" triangle on top. */
export function cameraGlyph(camera: Pick<CameraFields, 'focalLength' | 'sensorWidth' | 'sensorHeight'>): Glyph {
  const positions: Segments = [];
  const tan = Math.tan(cameraVerticalFov(camera) / 2);
  const aspect = camera.sensorWidth / camera.sensorHeight;
  // A wide lens would give a huge far rectangle: shorten the frustum so the glyph stays near unit size.
  const depth = Math.min(1, 0.7 / tan);
  const hh = depth * tan;
  const hw = hh * aspect;
  const far: Vec3[] = [
    [-hw, -hh, -depth],
    [hw, -hh, -depth],
    [hw, hh, -depth],
    [-hw, hh, -depth],
  ];
  far.forEach((corner, i) => {
    pushLine(positions, [0, 0, 0], corner);
    pushLine(positions, corner, far[(i + 1) % 4] ?? corner);
  });
  pushLine(positions, [-hw * 0.5, hh, -depth], [0, hh * 1.4, -depth]);
  pushLine(positions, [hw * 0.5, hh, -depth], [0, hh * 1.4, -depth]);
  return { positions, screenScaled: true };
}

/** Euler XYZ (applied Z first, then Y, then X) of the aim axis -Z, projected on the XY plane: [dx, dy] unit, null when it aims straight up / down. */
export function aimInPlan(rotation: Vec3): [number, number] | null {
  const [rx, ry] = rotation;
  // R = Rx Ry Rz: the image of (0, 0, -1) is minus the third column: (sin ry, -sin rx cos ry, cos rx cos ry) negated.
  const x = -Math.sin(ry);
  const y = Math.sin(rx) * Math.cos(ry);
  const length = Math.hypot(x, y);
  return length < 1e-6 ? null : [x / length, y / length];
}

/** Top-view symbol (unit size, XY only): a ring for a light, a wedge for a camera, plus a tick along the aim when it has one. */
export function planSymbol(
  entity: { readonly kind: 'light' | 'camera'; readonly rotation: Vec3 },
  lightType?: LightFields['lightType'],
): Segments {
  const out: Segments = [];
  const aim = aimInPlan(entity.rotation);
  if (entity.kind === 'camera') {
    const base: Vec3[] = [
      [-0.5, -0.5, 0],
      [0.5, -0.5, 0],
      [0.5, 0.5, 0],
      [-0.5, 0.5, 0],
    ];
    base.forEach((corner, i) => pushLine(out, corner, base[(i + 1) % 4] ?? corner));
  } else if (lightType === 'area') {
    pushLine(out, [-0.6, -0.3, 0], [0.6, -0.3, 0]);
    pushLine(out, [0.6, -0.3, 0], [0.6, 0.3, 0]);
    pushLine(out, [0.6, 0.3, 0], [-0.6, 0.3, 0]);
    pushLine(out, [-0.6, 0.3, 0], [-0.6, -0.3, 0]);
  } else {
    pushCircle(out, 0.45, 2);
    for (let i = 0; i < 4; i++) {
      const t = (i / 4) * Math.PI * 2 + Math.PI / 4;
      pushLine(out, [Math.cos(t) * 0.6, Math.sin(t) * 0.6, 0], [Math.cos(t) * 0.85, Math.sin(t) * 0.85, 0]);
    }
  }
  if (aim !== null && lightType !== 'point') pushLine(out, [0, 0, 0], [aim[0] * 1.6, aim[1] * 1.6, 0]);
  return out;
}
