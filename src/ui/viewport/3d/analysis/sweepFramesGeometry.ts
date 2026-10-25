// Pure data-to-geometry mapping of the "show frames" overlay: the `inspect_sweep` samples (entity-local) as T/N/B axis segments and
// closed section outlines, and the rings of a loft as outlines. Flat xyz arrays of line-segment pairs, ready for a LineSegments geometry.

import type { Vec3 } from '@core/model/types';

/** One inspected station: the frame and, when asked for, the section outline placed on it. */
export interface FrameStation {
  readonly point: Vec3;
  readonly tangent: Vec3;
  readonly normal: Vec3;
  readonly binormal: Vec3;
  readonly outline: ReadonlyArray<Vec3> | null;
}

export interface FrameSegments {
  readonly tangent: Float32Array;
  readonly normal: Float32Array;
  readonly binormal: Float32Array;
  readonly outlines: Float32Array;
}

const isVec3 = (value: unknown): value is Vec3 =>
  Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === 'number' && Number.isFinite(v));

function parseStation(raw: unknown): FrameStation | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { point, tangent, normal, binormal, outline } = raw as Record<string, unknown>;
  if (!isVec3(point) || !isVec3(tangent) || !isVec3(normal) || !isVec3(binormal)) return null;
  const loop = Array.isArray(outline) && outline.length >= 3 && outline.every(isVec3) ? (outline as Vec3[]) : null;
  return { point, tangent, normal, binormal, outline: loop };
}

/** The stations of an `inspect_sweep` answer; null when the data is not that shape. */
export function parseFrameStations(data: unknown): FrameStation[] | null {
  if (typeof data !== 'object' || data === null) return null;
  const samples = (data as { samples?: unknown }).samples;
  if (!Array.isArray(samples) || samples.length === 0) return null;
  const stations = samples.map(parseStation);
  return stations.every((s): s is FrameStation => s !== null) ? stations : null;
}

/** Axis glyph length: 90 % of the largest section reach, else a twelfth of the span the stations cover. */
export function axisLength(stations: ReadonlyArray<FrameStation>): number {
  let reach = 0;
  for (const { point, outline } of stations)
    for (const p of outline ?? []) reach = Math.max(reach, Math.hypot(p[0] - point[0], p[1] - point[1], p[2] - point[2]));
  if (reach > 0) return reach * 0.9;
  const first = stations[0]?.point ?? [0, 0, 0];
  const last = stations[stations.length - 1]?.point ?? first;
  const span = Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]);
  return span > 0 ? span / 12 : 1;
}

function axisSegments(stations: ReadonlyArray<FrameStation>, axis: 'tangent' | 'normal' | 'binormal', length: number): Float32Array {
  const out = new Float32Array(stations.length * 6);
  stations.forEach((station, k) => {
    const [x, y, z] = station.point;
    const d = station[axis];
    out.set([x, y, z, x + d[0] * length, y + d[1] * length, z + d[2] * length], k * 6);
  });
  return out;
}

/** Segment pairs tracing each loop as a closed chain. */
export function closedLoopSegments(loops: ReadonlyArray<ReadonlyArray<Vec3>>): Float32Array {
  const out = new Float32Array(loops.reduce((n, loop) => n + (loop.length >= 2 ? loop.length * 6 : 0), 0));
  let at = 0;
  for (const loop of loops) {
    if (loop.length < 2) continue;
    loop.forEach((a, i) => {
      const b = loop[(i + 1) % loop.length] as Vec3;
      out.set([a[0], a[1], a[2], b[0], b[1], b[2]], at);
      at += 6;
    });
  }
  return out;
}

/** Axis segments and section outlines of the inspected stations. */
export function frameSegments(stations: ReadonlyArray<FrameStation>): FrameSegments {
  const length = axisLength(stations);
  return {
    tangent: axisSegments(stations, 'tangent', length),
    normal: axisSegments(stations, 'normal', length),
    binormal: axisSegments(stations, 'binormal', length),
    outlines: closedLoopSegments(stations.flatMap((s) => (s.outline === null ? [] : [s.outline]))),
  };
}

/** Most sweeps and lofts the overlay draws at once (the first selected ones). */
export const MAX_FRAME_ENTITIES = 8;
