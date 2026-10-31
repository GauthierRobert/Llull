/**
 * Joint picks of blend_union (BLD M5, 13.14 and 13.29): the parameter schema of one pick (a joint by persistent name or by point, with a constant radius or a radius law
 * along the joint) and its resolution to the `JointRadius` of the recipe. The laws are those of fillet_edge (`resolveLaw`), so a joint law reads back through the same
 * record as an edge law.
 */

import type { JointRadius } from '../../model/blendTypes';
import { DEFAULT_LAW_SAMPLES, MAX_LAW_SAMPLES, MIN_LAW_SAMPLES, isLawProblem, resolveLaw } from '../../geometry/blend/law';
import { vec3, z } from '../schema';

const INTERPOLATIONS = ['smooth', 'linear', 'monotone'] as const;

export const jointSchema = z.object({
  near: vec3(
    'A point [x, y, z] in document units on or near the joint (the intersection curve the union creates) to pick; the joint nearest to it is taken. Give near, name, or both (the name wins).',
  ).optional(),
  name: z
    .string()
    .min(1)
    .describe(
      'Persistent name of the joint (an edge of the union, "e(<face>|<face>)", "#k" when the same two faces meet more than once). Recorded automatically from a pick by near and used on regeneration, so the same joint keeps its radius after an upstream edit; a name that no joint has now is REF_LOST, one that several have is REF_SPLIT (re-pick: remove name, or give a current one from data.joints[].name / check_blends sourceEdges). Wins over near.',
    )
    .optional(),
  nameMid: vec3(
    'Set by the command, not by you: the midpoint of the joint edge when its name with a #k suffix was recorded. A regeneration refuses (REF_LOST) the joint of that name when its midpoint moved more than 10 x its radius, because #k numbers the joints of two faces by position and an upstream edit can hand the number to another joint.',
  ).optional(),
  radius: z
    .number()
    .describe(
      'Fillet radius of that joint and its tangent chain in document units (> 0); with radiusEnd / sizes the radius at the START of the joint edge (its start point is data.joints[i].start). Give it unless law is given.',
    )
    .optional(),
  radiusEnd: z
    .number()
    .describe(
      'Optional radius at the END of the joint edge (> 0, document units): the radius runs from radius to radiusEnd (kernel smooth transition flattened at both ends; interpolation "linear" makes it straight). Needs a joint alone in its tangent chain (a joint chained with others is refused) and, on a closed joint, radiusEnd = radius.',
    )
    .optional(),
  sizes: z
    .array(
      z.object({
        t: z.number().describe('Relative position along the joint edge (0 = its start, 1 = its end), strictly inside (0, 1), increasing.'),
        size: z.number().describe('Radius at t (> 0), document units.'),
      }),
    )
    .describe('Optional interior control points the radius passes through along the joint (as in fillet_edge edges[].sizes).')
    .optional(),
  interpolation: z
    .enum(INTERPOLATIONS)
    .describe(
      'How the radius runs between radius, sizes and radiusEnd: "smooth" (default, the kernel transition), "linear" (straight pieces) or "monotone" (C1 cubic that never overshoots a station).',
    )
    .optional(),
  law: z
    .object({
      expression: z
        .string()
        .min(1)
        .describe(
          'Radius as an expression of t in [0, 1] along the joint (document units), e.g. "1 + 0.5*t". Must be > 0 at every sample.',
        ),
      samples: z
        .number()
        .int()
        .describe(
          `Number of uniform samples of t in [0, 1] the kernel receives (${MIN_LAW_SAMPLES}..${MAX_LAW_SAMPLES}). Default ${DEFAULT_LAW_SAMPLES}.`,
        )
        .optional(),
    })
    .describe('Expression law r(t) instead of radius / radiusEnd / sizes.')
    .optional(),
});

export type JointInput = z.infer<typeof jointSchema>;

export interface JointRefusal {
  readonly code: string;
  readonly message: string;
  /** Param path below the command (`joints[1].radiusEnd`). */
  readonly path: string;
}

const LAW_PATHS: Readonly<Record<string, string>> = { size: 'radius', sizeEnd: 'radiusEnd' };

/** The recipe joints of `joints`, or the first refusal (a pick without near / name, a radius <= 0, a law the fillet laws refuse). */
export function planJoints(joints: readonly JointInput[]): { readonly joints: JointRadius[] } | { readonly refusal: JointRefusal } {
  const planned: JointRadius[] = [];
  for (const [at, joint] of joints.entries()) {
    const label = `joints[${at}]`;
    if (joint.near === undefined && joint.name === undefined)
      return {
        refusal: {
          code: 'BLD_JOINT_PARAMS',
          message: `${label} needs near (a point on the joint) or name (its persistent name)`,
          path: `${label}.near`,
        },
      };
    if (joint.radius === undefined && joint.law === undefined)
      return { refusal: { code: 'BLD_JOINT_PARAMS', message: `${label} needs radius, or law`, path: `${label}.radius` } };
    if (joint.radius !== undefined && !(joint.radius > 0))
      return {
        refusal: { code: 'BLD_JOINT_PARAMS', message: `${label}.radius must be > 0 (got ${joint.radius})`, path: `${label}.radius` },
      };
    const law = resolveLaw({
      size: joint.radius,
      sizeEnd: joint.radiusEnd,
      sizes: joint.sizes,
      interpolation: joint.interpolation,
      law: joint.law,
    });
    if (isLawProblem(law))
      return {
        refusal: {
          code: law.code,
          message: `${label}.${LAW_PATHS[law.path] ?? law.path}: ${law.message.replace(/^sizeEnd/, 'radiusEnd').replace(/^size /, 'radius ')}`,
          path: `${label}.${LAW_PATHS[law.path] ?? law.path}`,
        },
      };
    planned.push({
      ...(joint.near === undefined ? {} : { near: joint.near }),
      ...(joint.name === undefined ? {} : { name: joint.name }),
      ...(joint.name === undefined || joint.nameMid === undefined ? {} : { nameMid: joint.nameMid }),
      radius: law.size,
      ...(law.sizeEnd === undefined ? {} : { radiusEnd: law.sizeEnd }),
      ...(law.sizes === undefined || law.sizes.length === 0 ? {} : { sizes: law.sizes }),
      ...(law.interpolation === undefined ? {} : { interpolation: law.interpolation }),
    });
  }
  return { joints: planned };
}
