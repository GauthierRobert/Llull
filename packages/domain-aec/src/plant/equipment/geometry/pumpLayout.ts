/**
 * Envelope layout of a centrifugal pump (plant 03 EQP §5.8). Frame: shaft along +X, centred on the middle of the bounding box in plan, floor at z = 0.
 * ISO 2858 meaning of the envelope: shaft axis `h1` above the foot plane (the baseplate top), discharge nozzle vertical on the shaft axis plane with its
 * face `h2` above the shaft, suction nozzle axial with its face `a` before the discharge centre, bearing frame to `f` after it. The body is an
 * ENVELOPE box (width = h2, top = shaft + h2 / 2), not a casing model; the driver sits after the coupling gap, the baseplate is centred under both.
 */

import type { Vec3 } from '@core/model/types';
import type { PumpTemplate } from '../plantData';

export interface LayoutBox {
  readonly part: string;
  readonly label: string;
  readonly center: Vec3;
  readonly size: Vec3;
}

export interface PumpPort {
  /** Flange-face centre. */
  readonly position: Vec3;
  readonly direction: Vec3;
  /** Neck length behind the face (face to the point on the shaft axis / discharge centre line). */
  readonly projection: number;
}

export interface PumpLayout {
  readonly boxes: readonly LayoutBox[];
  readonly suction: PumpPort;
  readonly discharge: PumpPort;
  /** Bounding box [length, width, height]. */
  readonly size: Vec3;
}

interface Span {
  readonly part: string;
  readonly label: string;
  readonly x: readonly [number, number];
  readonly width: number;
  readonly z: readonly [number, number];
}

export function pumpLayout(template: PumpTemplate): PumpLayout {
  const { envelope, baseplate, driver } = template;
  const plateTop = baseplate.height;
  const shaft = plateTop + envelope.h1;
  const spans: Span[] = [
    { part: 'pump-body', label: 'Pump envelope', x: [-envelope.a, envelope.f], width: envelope.h2, z: [plateTop, shaft + envelope.h2 / 2] },
  ];
  if (driver !== undefined) {
    const start = envelope.f + driver.gap;
    spans.push({
      part: 'driver',
      label: 'Driver',
      x: [start, start + driver.length],
      width: driver.width,
      z: [plateTop, plateTop + driver.height],
    });
  }
  const machineFrom = -envelope.a;
  const machineTo = Math.max(...spans.map((span) => span.x[1]));
  const plateCentre = (machineFrom + machineTo) / 2;
  spans.push({
    part: 'baseplate',
    label: 'Baseplate',
    x: [plateCentre - baseplate.length / 2, plateCentre + baseplate.length / 2],
    width: baseplate.width,
    z: [0, plateTop],
  });
  const xMin = Math.min(...spans.map((span) => span.x[0]));
  const xMax = Math.max(...spans.map((span) => span.x[1]));
  const shift = (xMin + xMax) / 2;
  const width = Math.max(...spans.map((span) => span.width));
  const top = Math.max(...spans.map((span) => span.z[1]), shaft + envelope.h2);
  return {
    boxes: spans.map(
      (span): LayoutBox => ({
        part: span.part,
        label: span.label,
        center: [(span.x[0] + span.x[1]) / 2 - shift, 0, (span.z[0] + span.z[1]) / 2],
        size: [span.x[1] - span.x[0], span.width, span.z[1] - span.z[0]],
      }),
    ),
    suction: { position: [-envelope.a - shift, 0, shaft], direction: [-1, 0, 0], projection: envelope.a },
    discharge: { position: [-shift, 0, shaft + envelope.h2], direction: [0, 0, 1], projection: envelope.h2 },
    size: [xMax - xMin, width, top],
  };
}
