/**
 * The equation solver of a CalculiX static step, as an option of one solve (PERF1): the default direct factorization, or the
 * preconditioned iterative solver (`SOLVER=ITERATIVE CHOLESKY`), which solves a bulky solid model several times faster on one thread and
 * stays reproducible run to run. Its results agree with the direct solve to about three digits (the iteration tolerance; 1.7e-4 relative on the validation bar), so it is never
 * a default: the caller asks for it and the results record it.
 */

import type { CadDocument } from '@core/model/types';
import { caseOf } from '../shared/access';

const STATIC_CARD = '*STATIC';
const ITERATIVE_CARD = '*STATIC, SOLVER=ITERATIVE CHOLESKY';

type Refusal = { readonly code: string; readonly message: string };

/** Why the iterative solver does not suit the case, or null: it converges poorly on thin (shell / plane) parts and is not set up for contact. */
function unsuitable(doc: CadDocument, analysisId: string): string | null {
  const analysis = caseOf(doc, analysisId);
  if (analysis === undefined) return `no analysis '${analysisId}'`;
  if (analysis.type !== 'static') return `analysis type '${analysis.type}' (linear static only)`;
  const thin = Object.entries(analysis.parts).find(([, part]) => part.kind !== 'solid');
  if (thin !== undefined) return `part '${thin[0]}' is idealized as ${thin[1].kind} (solid parts only)`;
  if (analysis.contact !== undefined && analysis.contact.pairOrder.length > 0) return 'the case has contact pairs';
  if (analysis.pretension !== undefined && analysis.pretension.order.length > 0) return 'the case has bolt pretension';
  return null;
}

/**
 * `deckText` of a linear static analysis with every `*STATIC` step solved by the iterative solver.
 * @invariant only the `*STATIC` card lines change
 * @failure not a solid-only linear static case without contact or pretension, or a deck without a plain `*STATIC` card ->
 *   FEA_SOLVER_OPTION_UNSUPPORTED (use the direct solver)
 */
export function iterativeSolverDeck(doc: CadDocument, analysisId: string, deckText: string): { readonly text: string } | Refusal {
  const refusal = (why: string): Refusal => ({
    code: 'FEA_SOLVER_OPTION_UNSUPPORTED',
    message: `the iterative solver is not available for this case: ${why}; solve it with solver "direct"`,
  });
  const reason = unsuitable(doc, analysisId);
  if (reason !== null) return refusal(reason);
  let steps = 0;
  const lines = deckText.split('\n').map((line) => {
    if (line !== STATIC_CARD) return line;
    steps += 1;
    return ITERATIVE_CARD;
  });
  return steps === 0 ? refusal('its deck has no plain *STATIC step') : { text: lines.join('\n') };
}
