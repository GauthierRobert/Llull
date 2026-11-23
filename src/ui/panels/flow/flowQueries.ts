// Params of the result-query transports the panel gathers from a case: where the slice plane goes and which seeds the streamlines start from.
// World metres, as the transports take them. Plain vector arithmetic on case fields; the flow itself is never computed here.

import type { Vec3 } from '@core/model/types';
import type { FlowCase } from './flowData';

export const SLICE_AXES = ['x', 'y', 'z'] as const;
export type SliceAxis = (typeof SLICE_AXES)[number];
export const SLICE_FIELDS = ['speed', 'p', 'cp', 'ux', 'uy', 'uz'] as const;
export type SliceField = (typeof SLICE_FIELDS)[number];

const AXIS_INDEX: Readonly<Record<SliceAxis, 0 | 1 | 2>> = { x: 0, y: 1, z: 2 };
const NORMALS: Readonly<Record<SliceAxis, Vec3>> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/** Streamline seeds start this many reference lengths upstream of the moment point and span this many (half-width). */
const RAKE_UPSTREAM = 1;
const RAKE_HALF_WIDTH = 0.6;

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scaled = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: Vec3): Vec3 => scaled(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

/** Coordinate of the case's moment point along `axis`: the plane the slice starts at. */
export const defaultSlicePosition = (cfdCase: FlowCase, axis: SliceAxis): number => cfdCase.reference.momentPointM[AXIS_INDEX[axis]];

/** `cfd_slice` params: a plane normal to a world axis through the moment point, moved to `positionM` along that axis when given. */
export function sliceParams(
  cfdCase: FlowCase,
  choice: { readonly axis: SliceAxis; readonly field: SliceField; readonly positionM: number | null },
): Record<string, unknown> {
  const origin: [number, number, number] = [...cfdCase.reference.momentPointM];
  origin[AXIS_INDEX[choice.axis]] = choice.positionM ?? defaultSlicePosition(cfdCase, choice.axis);
  return { caseId: cfdCase.id, origin, normal: NORMALS[choice.axis], field: choice.field };
}

/** `cfd_streamlines` params: a `count` x `count` grid of seeds across the flow, upstream of the body. */
export function rakeParams(cfdCase: FlowCase, count: number): Record<string, unknown> {
  const flow = unit(cfdCase.flowAxis);
  const upRaw = cfdCase.upAxis;
  const up = unit([upRaw[0] - dot(upRaw, flow) * flow[0], upRaw[1] - dot(upRaw, flow) * flow[1], upRaw[2] - dot(upRaw, flow) * flow[2]]);
  const lateral: Vec3 = [flow[1] * up[2] - flow[2] * up[1], flow[2] * up[0] - flow[0] * up[2], flow[0] * up[1] - flow[1] * up[0]];
  const length = cfdCase.reference.lengthM;
  const centre = cfdCase.reference.momentPointM;
  return {
    caseId: cfdCase.id,
    rake: {
      kind: 'plane',
      centre: [0, 1, 2].map((k) => (centre[k] ?? 0) - RAKE_UPSTREAM * length * (flow[k] ?? 0)),
      uAxis: scaled(lateral, RAKE_HALF_WIDTH * length),
      vAxis: scaled(up, RAKE_HALF_WIDTH * length),
      nu: count,
      nv: count,
    },
  };
}
