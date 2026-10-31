/**
 * fillet_edge `chain`: the selected edges are ONE tangent chain and radius -> radiusEnd (a straight law) or chain.law (an expression of t) runs over its total arc length (TECHNICAL_SPEC 13.27).
 * The chain layout and the cut into one sub-law per edge are those of fillet_faces (faceBlendChain.ts); the result is the `edges` form that filletEach builds.
 * @invariant the selection is the chain exactly (one path or one loop, every joint tangent within 0.01 rad); t = 0 is the end nearest chain.startNear, else the end of the lowest-numbered edge
 * @failure no selected edge, radius missing (without chain.law), chain.law together with radius / radiusEnd, edges that are not one chain -> BLD_CHAIN_UNSUPPORTED; a size <= 0 or an open law on a loop -> BLD_LAW_INVALID / BLD_LAW_NOT_PERIODIC
 */

import { DEFAULT_LAW_SAMPLES, MAX_LAW_SAMPLES, MIN_LAW_SAMPLES } from '../../geometry/blend/law';
import { vec3, z } from '../schema';
import { type ChainContext, chainLaws, planChain } from './faceBlendChain';
import type { EdgeLawInput } from './filletSpec';

export const chainSchema = z
  .object({
    startNear: vec3(
      'A point [x, y, z] in document units: t = 0 is the open end of the chain nearest to it (default: the end of the lowest-numbered selected edge). Not allowed on a closed loop (it has no end; t = 0 is the start of its lowest-numbered edge).',
    ).optional(),
    law: z
      .object({
        expression: z
          .string()
          .min(1)
          .describe(
            'Radius as an expression of t in [0, 1] along the TOTAL arc length of the chain (document units), e.g. "1 + 2*t". Only t, pi, tau and the built-in functions are allowed; it must be > 0 at every sample. On a closed loop r(0) must equal r(1).',
          ),
        samples: z
          .number()
          .int()
          .describe(
            `Stations of t in [0, 1] per edge (${MIN_LAW_SAMPLES}..${MAX_LAW_SAMPLES}), joined by straight pieces. Default ${DEFAULT_LAW_SAMPLES}.`,
          )
          .optional(),
      })
      .describe('Expression law over the chain instead of radius / radiusEnd.')
      .optional(),
  })
  .describe(
    'Treat the selected edges (edgeIndices / edgesNear / edgeNames) as ONE tangent chain (an open path or a closed loop, every joint tangent within 0.01 rad) and run ONE radius law over its total arc length: radius at the start of the chain to radiusEnd (a straight law), or law. Each edge is given the piece of the law on it, equal at the joints. Several separate chains, a branch or a bend are refused (BLD_CHAIN_UNSUPPORTED). Without chain, radiusEnd applies to EACH selected edge from its own start to its own end.',
  );

export type ChainInput = z.infer<typeof chainSchema>;

export type ChainEntries =
  | { readonly entries: EdgeLawInput[] }
  | { readonly problem: string }
  | {
      readonly refusal: {
        readonly code: 'BLD_CHAIN_UNSUPPORTED' | 'BLD_LAW_INVALID' | 'BLD_LAW_NOT_PERIODIC';
        readonly message: string;
        readonly path: string;
      };
    };

const worded = (text: string): string => text.replaceAll('the shared edges', 'the selected edges');

/** The `edges` entries (one sub-law per selected edge) for `chain` over `edges`, or why the selection is not one chain with this law. */
export function chainEntries(
  context: ChainContext,
  edges: readonly number[],
  chain: ChainInput,
  radius: number | undefined,
  radiusEnd: number | undefined,
): ChainEntries {
  if (edges.length === 0) return { problem: 'chain needs the edges of the chain: give edgeIndices, edgesNear or edgeNames' };
  if (chain.law !== undefined && (radius !== undefined || radiusEnd !== undefined))
    return { problem: 'chain.law replaces radius / radiusEnd: give one of them' };
  if (chain.law === undefined && radius === undefined)
    return { problem: 'chain needs radius (the size at the start of the chain) with radiusEnd for a straight law, or chain.law' };
  const plan = planChain(context, edges, chain.startNear, 'chain');
  if ('problem' in plan)
    return {
      refusal: {
        code: 'BLD_CHAIN_UNSUPPORTED',
        message: worded(plan.problem),
        path: plan.path === 'startNear' ? 'chain.startNear' : plan.path,
      },
    };
  const laws = chainLaws(plan, { start: radius ?? 0, end: radiusEnd, law: chain.law }, chain.law === undefined ? 'radiusEnd' : 'chain.law');
  if ('code' in laws)
    return {
      refusal: { code: laws.code, message: worded(laws.message), path: laws.path.startsWith('law') ? `chain.${laws.path}` : laws.path },
    };
  return { entries: laws };
}
