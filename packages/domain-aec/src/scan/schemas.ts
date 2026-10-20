/** Shared zod pieces of the scan commands (one inline `z.object` per command; these are its fields). */

import { z } from '@core/commands/schema';

export const cloudIdParam = z.string().min(1).describe('Id of an attached cloud (affected[0] of attach_point_cloud, e.g. "cloud-1.1").');

export const mat4Param = z
  .array(z.number())
  .length(16)
  .describe(
    'Row-major 4 x 4 transform, asset frame -> document frame, translation in METRES (column 4); [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1] = identity.',
  );

const point = z.array(z.number()).length(3);

/** RegionSpec in document units and frame (TECHNICAL_SPEC §4). */
export const regionParam = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('all').describe('Every point of the cloud.') }),
    z.object({
      kind: z.literal('box').describe('Axis-aligned box in document units.'),
      min: point.describe('[x, y, z] low corner.'),
      max: point.describe('[x, y, z] high corner.'),
    }),
    z.object({
      kind: z.literal('seed').describe('Sphere around a seed point.'),
      point: point.describe('[x, y, z] seed point.'),
      radius: z.number().describe('Radius in document units, > 0.'),
    }),
    z.object({
      kind: z.literal('crop').describe('A crop box from set_scan_crop (keep "inside").'),
      cropId: z.string().describe('Crop id.'),
    }),
  ])
  .describe(
    'Region of the cloud: {kind:"all"} | {kind:"box",min,max} | {kind:"seed",point,radius} | {kind:"crop",cropId} (document units).',
  );

export const seedParam = z.number().int().min(0).optional().describe('RANSAC seed (default 1); same seed = same result (AF-13).');

export const deviceParam = z
  .enum(['cpu', 'gpu'])
  .optional()
  .describe('cpu (default): the recorded Rust-CPU path. gpu: the wgpu fast path (RS-4); see the command for what it changes.');
