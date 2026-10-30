/** displace_mesh — move the vertices of a mesh by a scalar field: an expression or a height map (07 MSH FR-MSH-39). */

import { expressionSyntaxError } from '../../lib/expression';
import { DISPLACE_PLANES } from '../../geometry/mesh/wrapDisplace';
import { defineCommand, vec3, z } from '../schema';
import type { CommandResult } from '../types';
import { keepSourceParam } from './levelSetCommands';
import { meshRejection } from './meshCommon';
import { runMeshOp } from './runMeshOp';

/** Largest height map (pixels): its base64 text is a parameter of the command, so it is bounded. */
const MAX_MAP_PIXELS = 4_000_000;

/**
 * @affects rewrites the mesh `id` with every vertex moved by strength x field along its normal or a fixed direction (and, with refineEdge, split edges), or adds one mesh with keepSource
 * @invariant without refineEdge connectivity is unchanged; displacedVolume of an open height field is the sum of triangle area x mean vertex displacement along the face normal (a constant d on a flat grid of area A gives d x A), of a closed mesh volume after - before
 * @failure unknown id / non-solid -> MESH_*; neither or both of expression and heightMap, a syntax error, a direction without length, a map over 4,000,000 pixels -> MESH_PARAM_INVALID; an expression that fails at a vertex, a pixel count that is not width x height -> MESH_DISPLACE_FIELD; refineEdge past 4,000,000 triangles -> MESH_DISPLACE_RESULT_TOO_LARGE
 */
export const displaceMesh = defineCommand({
  name: 'displace_mesh',
  description:
    'Displace the vertices of a mesh (or the triangles of any 3D solid) by a scalar field times `strength` (document units per unit of the field), along the vertex normal ' +
    '(default) or a fixed `direction`. The field is EITHER `expression` (a formula of the vertex position x, y, z and its unit normal nx, ny, nz in world document units, ' +
    'with the operators + - * / ^, parentheses and functions such as sin, cos, sqrt, abs; e.g. "0.2 * sin(x * 2)") OR `heightMap` (an 8-bit grey image: ' +
    '`pixels` base64 of width x height raw bytes, row by row from the lowest v; `plane` xy / yz / xz picks the two axes it is laid on; `origin` [u, v] and `size` [width, height] ' +
    'place it; bilinear between pixel centres; the field is grey / 255 - `midlevel` (default 0.5), 0 outside the rectangle). `refineEdge` first splits every edge longer than that ' +
    '(document units) so the surface can follow the field (the triangle count grows; 4,000,000 at most). Reports data.movedVertices, maxDisplacement (document units), displacedVolume ' +
    '(closed mesh: volume after - before; open height field: sum of triangle area x mean vertex displacement along the face normal) with volumeBasis, refinedEdges, and the symmetric ' +
    'deviation of the result from the source. Reads the full-resolution mesh. Refusals: MESH_ENTITY_NOT_FOUND, MESH_NOT_A_MESH, MESH_PARAM_INVALID, MESH_DISPLACE_FIELD (the expression fails at a vertex: divide by zero, unknown name; or a wrong pixel count), ' +
    'MESH_DISPLACE_RESULT_TOO_LARGE (use a longer refineEdge), MESH_ENGINE_CAP_EXCEEDED (200000 triangles in the TypeScript engine).',
  annotations: { readsMeshTriangles: true },
  params: z.object({
    id: z.string().describe('Id of the mesh (or other 3D solid) to displace.'),
    expression: z
      .string()
      .min(1)
      .optional()
      .describe('Scalar field of x, y, z, nx, ny, nz (world, document units), e.g. "0.5" or "0.2 * sin(x)". Not with `heightMap`.'),
    heightMap: z
      .object({
        pixels: z.string().min(1).describe('Base64 of width x height raw 8-bit grey values, row by row, the first row at the lowest v.'),
        width: z.number().int().min(1).describe('Pixels per row.'),
        height: z.number().int().min(1).describe('Number of rows.'),
        plane: z.enum(DISPLACE_PLANES).describe('Plane the map is laid on: xy (u = x, v = y), yz (u = y, v = z) or xz (u = x, v = z).'),
        origin: z.tuple([z.number(), z.number()]).describe('[u, v] of the lower corner of the map (document units).'),
        size: z
          .tuple([z.number().positive(), z.number().positive()])
          .describe('[width, height] of the rectangle the map covers (document units).'),
      })
      .optional()
      .describe('An 8-bit grey height map laid on `plane`. Not with `expression`.'),
    strength: z.number().optional().describe('Document units of displacement per unit of the field (default 1).'),
    midlevel: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe('Height map only: the grey level 0..1 that does not move a vertex (default 0.5).'),
    direction: z
      .union([z.literal('normal'), vec3('Fixed direction [x, y, z] (world, any length).')])
      .optional()
      .describe('"normal" (default): the vertex normal; or a fixed vector.'),
    refineEdge: z.number().positive().optional().describe('Split every edge longer than this (document units) before displacing.'),
    keepSource: keepSourceParam,
  }),
  run: (doc, params, ctx): CommandResult => {
    const { id, expression, heightMap, strength, midlevel, direction, refineEdge, keepSource } = params;
    const refuse = (message: string, path: string): CommandResult =>
      meshRejection(doc, 'displace_mesh', 'MESH_PARAM_INVALID', message, [id], [path]);
    if ((expression === undefined) === (heightMap === undefined))
      return refuse('give exactly one of expression or heightMap', 'expression');
    if (expression !== undefined) {
      const syntax = expressionSyntaxError(expression);
      if (syntax !== null) return refuse(`the expression is not valid: ${syntax}`, 'expression');
    }
    if (heightMap !== undefined && heightMap.width * heightMap.height > MAX_MAP_PIXELS)
      return refuse(`a height map has at most ${MAX_MAP_PIXELS} pixels`, 'heightMap');
    if (direction !== undefined && direction !== 'normal' && Math.hypot(direction[0], direction[1], direction[2]) === 0)
      return refuse('`direction` has no length', 'direction');
    return runMeshOp(doc, ctx, {
      command: 'displace_mesh',
      id,
      keepSource: keepSource ?? false,
      requireClosed: false,
      deviation: true,
      op: () => ({
        op: 'displace',
        strength: strength ?? 1,
        midlevel: midlevel ?? 0.5,
        direction: direction ?? 'normal',
        ...(expression !== undefined ? { expression } : {}),
        ...(heightMap !== undefined ? { heightMap } : {}),
        ...(refineEdge !== undefined ? { refineEdge } : {}),
      }),
      fields: (_before, _after, result) => ({
        field: expression !== undefined ? 'expression' : 'heightMap',
        strength: strength ?? 1,
        ...result.report,
      }),
      summary: (from, to, _before, _after, unit, result) =>
        `displace_mesh '${from}' -> '${to}': ${String(result.report['movedVertices'])} vertices moved, max displacement ${(result.report['maxDisplacement'] as number).toPrecision(5)} ${unit}, ` +
        `displaced volume ${(result.report['displacedVolume'] as number).toPrecision(10)} ${unit}^3 (${String(result.report['volumeBasis'])}).`,
    });
  },
});
