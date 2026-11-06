/** The overlays of one frame (FR-MOV-07, TR-MOV-07) as raster primitives: time label, readout panel, traces with their dot, in front of the scene. */

import type { ParsedFont } from '../../../lib/font/font';
import { clamp } from '../../../lib/clamp';
import type { Vec2 } from '../../../model/vectors';
import type { Projector } from '../camera';
import { OVERLAY_Z, type OverlayFill, type OverlayPrimitives, type OverlayStroke, type Rgb } from './rasterOverlay';
import { placeText } from './overlayText';
import { readoutLabel } from './readouts';
import type { AnimationTimelineEntry, TraceTrack } from './types';

const PANEL: Rgb = [16, 16, 28];
const INK: Rgb = [232, 232, 244];
const RING: Rgb = [16, 16, 32];
const TRACE_COLORS: readonly Rgb[] = [
  [255, 210, 74],
  [74, 216, 255],
  [255, 111, 168],
  [141, 255, 111],
];
const CIRCLE_SIDES = 20;

const traceColor = (index: number): Rgb => TRACE_COLORS[index % TRACE_COLORS.length] ?? [255, 255, 255];

const rectangle = (left: number, top: number, right: number, bottom: number): Vec2[] => [
  [left, top],
  [right, top],
  [right, bottom],
  [left, bottom],
];

const circle = (centre: Vec2, radius: number): Vec2[] =>
  Array.from(
    { length: CIRCLE_SIDES },
    (_, i): Vec2 => [
      centre[0] + radius * Math.cos((2 * Math.PI * i) / CIRCLE_SIDES),
      centre[1] + radius * Math.sin((2 * Math.PI * i) / CIRCLE_SIDES),
    ],
  );

export interface OverlayRequest {
  readonly width: number;
  readonly height: number;
  readonly project: Projector;
  readonly font: ParsedFont | null;
  readonly traces: readonly TraceTrack[];
  readonly time: boolean;
}

/** The overlay of frame `frame` (its timeline entry gives the time and the readouts). */
export type FrameOverlay = (frame: number, entry: AnimationTimelineEntry) => OverlayPrimitives;

/** Overlay builder for a render: trace paths projected once (the camera is fixed), text laid out per frame. */
export function frameOverlayOf(request: OverlayRequest): FrameOverlay {
  const { width, height, font } = request;
  const cap = clamp(Math.round(height / 36), 8, 30);
  const margin = Math.round(cap * 0.9);
  const pitch = Math.round(cap * 1.7);
  const screenPaths = request.traces.map((trace) => trace.path.map((point) => request.project(point)));
  return (frame, entry) => {
    const fills: OverlayFill[] = [];
    const strokes: OverlayStroke[] = [];
    screenPaths.forEach((path, i) => {
      if (path.length >= 2) strokes.push({ color: traceColor(i), z: OVERLAY_Z.trace, halfWidth: 1.1, points: path });
    });
    request.traces.forEach((trace, i) => {
      const here = trace.at[frame];
      if (here === undefined) return;
      const centre = request.project(here);
      fills.push({ color: RING, z: OVERLAY_Z.ring, loops: [circle(centre, 6)] });
      fills.push({ color: traceColor(i), z: OVERLAY_Z.dot, loops: [circle(centre, 4.2)] });
    });
    if (font !== null) {
      const block = (
        lines: readonly string[],
        left: number,
        firstBaseline: number,
        align: 'left' | 'right',
        colors: readonly Rgb[],
      ): void => {
        const placed = lines.map((line, i) =>
          placeText(font, line, cap, left, firstBaseline + i * pitch, align, colors[i] ?? INK, OVERLAY_Z.text),
        );
        const widest = Math.max(0, ...placed.map((text) => text.width));
        const x0 = align === 'left' ? left - margin / 2 : left - widest - margin / 2;
        const rect = rectangle(
          x0,
          firstBaseline - cap - margin / 2,
          x0 + widest + margin,
          firstBaseline + (lines.length - 1) * pitch + margin / 2,
        );
        fills.push({ color: PANEL, z: OVERLAY_Z.panel, loops: [rect] });
        for (const text of placed) {
          fills.push(...text.fills);
          strokes.push(...text.strokes);
        }
      };
      if (request.time) block([`t = ${+entry.tS.toFixed(5)} s`], margin, margin + cap, 'left', [INK]);
      if (request.traces.length > 0)
        block(
          request.traces.map((trace) => `trace: ${trace.id}`),
          width - margin,
          margin + cap,
          'right',
          request.traces.map((_, i) => traceColor(i)),
        );
      const lines = Object.entries(entry.readouts).map(([id, readout]) => readoutLabel(id, readout));
      if (lines.length > 0) block(lines, margin, height - margin - (lines.length - 1) * pitch, 'left', []);
    }
    return { fills, strokes };
  };
}
