/**
 * add_instance_array (plant 09 VIS-M8j, VIS1): place a Component on a 3-D grid as ONE packed instance array, no Entity per placement.
 * @affects doc.instanceArrays[arrayId] (affected: [], the array is not an entity); a feature step (params are the small grid spec)
 * @invariant deterministic: the same params give the same bytes (replay); the table is row-major, x fastest, then y, then z
 * @failure unknown component / empty component / unknown layer / bad colour / count > MAX_ARRAY_INSTANCES / non-finite position or bounds -> rejected, unchanged document
 */

import { DEFAULT_LAYER_ID } from '../../model/types';
import { INSTANCE_STRIDE, MAX_ARRAY_INSTANCES, type InstanceArray } from '../../model/instanceArray';
import { float64ToBase64 } from '../../lib/float64Base64';
import { nextId } from '../../lib/id';
import { boundsOfPlacedCorners, instanceLocalCorners } from '../../geometry/bounds';
import { defineCommand, vec3, z } from '../schema';
import { EXTRUSION_COLOR } from '../solids/shared';
import { noop, report } from '../noop';
import type { CommandResult } from '../types';

export const addInstanceArray = defineCommand({
  name: 'add_instance_array',
  description:
    'Place a Component (create_component) on a 3-D grid as one instance array: nx x ny x nz members at origin + i*step, each with the same ' +
    'rotation and scale, stored as a packed table (48 bytes per member, no Entity per member: up to 4,000,000). Members are not entities; ' +
    'planScene / render_stats see them with ids "<arrayId>#<index>". Returns data.arrayId, count and bounds. Refused: unknown or empty ' +
    'component, unknown layer, more than 4,000,000 members.',
  params: z.object({
    componentId: z.string().describe('Id of the Component to place (create_component returns it in data).'),
    counts: z
      .tuple([z.number().int().min(1), z.number().int().min(1), z.number().int().min(1)])
      .describe('Members along x, y, z: [nx, ny, nz], each >= 1. The product is at most 4,000,000.'),
    step: vec3('Spacing along x, y, z in document units, between member origins.'),
    origin: vec3('Position of member [0, 0, 0] (document units). Default [0, 0, 0].').optional(),
    rotation: vec3('Euler XYZ rotation in radians of every member about its own origin. Default [0, 0, 0].').optional(),
    scale: vec3('Per-axis scale of every member. Default [1, 1, 1].').optional(),
    name: z.string().optional().describe('Display name. Default: the component id with "_array".'),
    layerId: z.string().optional().describe('Layer of the array. Default: the default layer.'),
    color: z.string().optional().describe('Display colour #rrggbb. Default: the instance colour.'),
    materialId: z.string().optional().describe('Material id of the members.'),
  }),
  run: (doc, params): CommandResult => {
    const reject = (reason: string): CommandResult => noop(doc, `add_instance_array rejected: ${reason}`);
    if (!Object.hasOwn(doc.components, params.componentId)) return reject(`component '${params.componentId}' does not exist`);
    if (instanceLocalCorners(doc, params.componentId).length === 0) return reject(`component '${params.componentId}' has no entities`);
    const layerId = params.layerId ?? DEFAULT_LAYER_ID;
    if (!Object.hasOwn(doc.layers, layerId)) return reject(`layer '${layerId}' does not exist`);
    const color = params.color ?? EXTRUSION_COLOR;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return reject(`color '${color}' is not #rrggbb`);
    const [nx, ny, nz] = params.counts;
    const count = nx * ny * nz;
    if (count > MAX_ARRAY_INSTANCES) return reject(`${count} members exceed the limit of ${MAX_ARRAY_INSTANCES} per array`);
    const [ox, oy, oz] = params.origin ?? [0, 0, 0];
    const [rx, ry, rz] = params.rotation ?? [0, 0, 0];
    const [dx, dy, dz] = params.step;
    const table = new Float64Array(count * INSTANCE_STRIDE);
    let at = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++)
        for (let i = 0; i < nx; i++) {
          table[at] = ox + i * dx;
          table[at + 1] = oy + j * dy;
          table[at + 2] = oz + k * dz;
          table[at + 3] = rx;
          table[at + 4] = ry;
          table[at + 5] = rz;
          at += INSTANCE_STRIDE;
        }
    // an overflowing step (1e308 x 4000) would store Infinity: the file would be refused on load
    if (!table.every(Number.isFinite))
      return reject('a member position is not finite (origin + index x step overflows); reduce the step or the counts');
    const id = nextId('arr');
    const array: InstanceArray = {
      id,
      name: params.name ?? `${params.componentId}_array`,
      componentId: params.componentId,
      layerId,
      color,
      ...(params.materialId !== undefined ? { materialId: params.materialId } : {}),
      ...(params.scale !== undefined ? { scale: params.scale } : {}),
      count,
      encoding: 'f64le-base64',
      transforms: float64ToBase64(table),
    };
    const next = { ...doc, instanceArrays: { ...doc.instanceArrays, [id]: array } };
    // every member is the first one translated (one shared rotation and scale): the union box is one box plus the grid extent
    const base = boundsOfPlacedCorners(instanceLocalCorners(doc, params.componentId), params.scale ?? [1, 1, 1], [rx, ry, rz], [0, 0, 0]);
    const reach = [(nx - 1) * dx, (ny - 1) * dy, (nz - 1) * dz];
    const origin = [ox, oy, oz];
    const axes = [0, 1, 2] as const;
    const lo = axes.map((axis) => (base.min[axis] ?? 0) + (origin[axis] ?? 0) + Math.min(0, reach[axis] ?? 0));
    const hi = axes.map((axis) => (base.max[axis] ?? 0) + (origin[axis] ?? 0) + Math.max(0, reach[axis] ?? 0));
    if (![...lo, ...hi].every(Number.isFinite))
      return reject('the bounds of the array are not finite (scale or component extent overflows)');
    return {
      ...report(next, `Added instance array '${id}': ${count} x '${params.componentId}' (${nx} x ${ny} x ${nz}).`, {
        arrayId: id,
        count,
        bounds: { min: lo, max: hi },
      }),
      affected: [],
    };
  },
});
