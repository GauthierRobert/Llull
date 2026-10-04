import type { GoldenAction } from '../golden/plans';

/**
 * @layer tests/quality
 *
 * Complex native documents for the display gate: scale extremes (micro / site-plan), positions
 * far from the origin (floating-origin precision), dense and many-instance scenes, extreme aspect
 * ratios and rotated solids. Built from commands only (`build_project` actions).
 */

const FAR: readonly [number, number, number] = [1.0e6, 2.0e6, 0];

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function zigzag(points: number, width: number, height: number): [number, number][] {
  return range(points).map((index) => [
    (index / (points - 1)) * width,
    index % 2 === 0 ? 0 : height,
  ]);
}

export const COMPLEX_2D: Record<string, GoldenAction[]> = {
  /** ~1100 entities: a 30 x 30 circle grid, its grid lines and a 200-vertex zigzag. */
  dense_drawing: [
    ...range(30).flatMap((i) =>
      range(30).map((j) => ({
        command: 'draw_circle',
        params: { center: [i * 2 + 1, j * 2 + 1], radius: 0.8 },
      })),
    ),
    ...range(31).map((i) => ({
      command: 'draw_line',
      params: { start: [i * 2, 0], end: [i * 2, 60] },
    })),
    ...range(31).map((j) => ({
      command: 'draw_line',
      params: { start: [0, j * 2], end: [60, j * 2] },
    })),
    { command: 'draw_polyline', params: { points: zigzag(200, 60, -6), closed: false } },
  ],
  /** A small drawing 2 000 km from the origin. */
  far_from_origin: [
    { command: 'draw_rectangle', params: { width: 40, height: 10, position: FAR } },
    { command: 'draw_circle', params: { center: [FAR[0] + 50, FAR[1] + 5], radius: 5 } },
    {
      command: 'draw_spline',
      params: {
        points: [
          [FAR[0], FAR[1] - 10],
          [FAR[0] + 20, FAR[1] - 4],
          [FAR[0] + 40, FAR[1] - 10],
        ],
      },
    },
  ],
  /** A 10 µm part: grid adaptivity and zoom limits. */
  micro_part: [
    { command: 'draw_rectangle', params: { width: 0.01, height: 0.004 } },
    { command: 'draw_circle', params: { center: [0.005, 0.002], radius: 0.001 } },
  ],
  /** A 100 m x 25 m site plan with 50 pile markers. */
  site_plan: [
    { command: 'draw_rectangle', params: { width: 100000, height: 25000 } },
    ...range(50).map((index) => ({
      command: 'draw_circle',
      params: { center: [2000 * index + 1000, 12500], radius: 400 },
    })),
  ],
  /** 20:1 aspect ratio. */
  extreme_aspect: [
    { command: 'draw_rectangle', params: { width: 1000, height: 50 } },
    { command: 'draw_line', params: { start: [0, 25], end: [1000, 25] } },
  ],
};

export const COMPLEX_3D: Record<string, GoldenAction[]> = {
  /** Solids 2 000 km from the origin. */
  far_from_origin: [
    { command: 'add_box', params: { size: [20, 10, 5], position: FAR } },
    {
      command: 'add_cylinder',
      params: { radius: 4, height: 12, position: [FAR[0] + 30, FAR[1], 0] },
    },
    { command: 'add_sphere', params: { radius: 5, position: [FAR[0] - 20, FAR[1] + 5, 0] } },
  ],
  /** 900 instanced boxes + 60 non-instanced cones. */
  many_instances: [
    ...range(30).flatMap((i) =>
      range(30).map((j) => ({
        command: 'add_box',
        params: { size: [1, 1, 1 + ((i + j) % 5)], position: [i * 2, j * 2, 0] },
      })),
    ),
    ...range(60).map((index) => ({
      command: 'add_cone',
      params: { radius: 0.5, height: 2, position: [index, -4, 0] },
    })),
  ],
  /** A 10 µm part. */
  micro_part: [
    { command: 'add_box', params: { size: [0.01, 0.02, 0.005] } },
    { command: 'add_sphere', params: { radius: 0.004, position: [0.02, 0, 0] } },
  ],
  /** A 100 m x 50 m x 3 m slab and a 20 m tower. */
  site_scale: [
    { command: 'add_box', params: { size: [100000, 50000, 3000] } },
    { command: 'add_cylinder', params: { radius: 5000, height: 20000, position: [60000, 0, 0] } },
  ],
  /** A 40 x 4 x 4 beam rotated 45° about Z: its footprint is square-ish, not 10:1. */
  rotated_beam: [
    { command: 'add_box', params: { size: [40, 4, 4], rotation: [0, 0, Math.PI / 4] } },
  ],
};
