/** check_bonding (PHY-15 FR-EOP-06, FR-EOP-07, AF-20): series resistance of every bond path against its sourced limit. */

import { defineCommand, z } from '@core/commands/schema';
import { codedRejection, report } from '@core/commands/noop';
import type { CommandResult, ExecutionContext } from '@core/commands/types';
import type { CadDocument } from '@core/model/types';
import { bondContext } from './bondContext';
import { type BondRow, type BondStatus, bondRow } from './bondEval';
import { dispositionState } from './gate';
import { dispositionOf, electroOpticalOf } from './model';

const COMMAND = 'check_bonding';
const RANK: Readonly<Record<BondStatus, number>> = { pass: 0, unknown: 1, fail: 2 };

type DispositionView = 'none' | 'pending_human' | 'accepted' | 'rejected' | 'redesign' | 'stale' | 'unconfirmed';
export type CheckedRow = BondRow & { readonly disposition: DispositionView };

/** The disposition of a row: only a signature that re-verifies for this document, over the path as it is now, counts. */
function dispositionView(doc: CadDocument, row: BondRow, ctx: ExecutionContext | undefined): DispositionView {
  if (row.status === 'pass') return 'none';
  const stored = dispositionOf(doc, row.pathId);
  if (stored === undefined) return 'pending_human';
  if (dispositionState(doc, ctx?.humanSignature ?? null, stored) !== 'ok') return 'unconfirmed';
  return stored.inputsHash === row.inputsHash ? stored.decision : 'stale';
}

/** The checked rows of `pathIds` (all paths when omitted) or the refusal result. */
export function checkedRows(
  doc: CadDocument,
  pathIds: readonly string[] | undefined,
  ctx: ExecutionContext | undefined,
): CheckedRow[] | CommandResult {
  const { bondPaths } = electroOpticalOf(doc);
  const unknownId = pathIds?.find((id) => !Object.hasOwn(bondPaths, id));
  if (unknownId !== undefined)
    return codedRejection(
      doc,
      COMMAND,
      'EOP_PATH_NOT_FOUND',
      `no bond path '${unknownId}'`,
      'list the bond paths with check_bonding',
      [unknownId],
      ['pathIds'],
    );
  const paths = (pathIds === undefined ? Object.keys(bondPaths) : [...new Set(pathIds)]).flatMap((id) => {
    const path = bondPaths[id];
    return path === undefined ? [] : [path];
  });
  const context = bondContext(doc, paths, ctx);
  if ('refusal' in context) return { ...context.refusal, summary: `${COMMAND}: ${context.refusal.summary}` };
  return paths.map((path) => {
    const row = bondRow(doc, path, context, ctx);
    return { ...row, disposition: dispositionView(doc, row, ctx) };
  });
}

/**
 * @affects nothing; read-only, document returned unchanged, affected: []
 * @invariant data = { status, rows, counts, open, reviewRequired: true, notes }; row total = sum of its elements (joints as given, straps rho L / A with rho from evaluate_property at the path temperature); a path passes only when
 *   every element resolves, a sourced limit exists, the total is <= the limit, no bonded-interface coating (or surface system, list_surface_systems) is insulating or undeclared, and joined solids touch (find_contacts or a fastener stack) and were tested; overall status = worst row without a CONFIRMED human
 *   disposition 'accepted' (re-verified through the signing port for this document and the path as it is); every limit is unverified
 * @failure unknown pathIds entry -> EOP_PATH_NOT_FOUND; a find_contacts refusal is returned as is (document unchanged)
 */
export const checkBonding = defineCommand({
  name: COMMAND,
  annotations: { readOnly: true, idempotent: true, readsMeshTriangles: true },
  description:
    'Check electrical bond paths (define_bond_path): each path total is the series sum of its joints (as given, with their source) and straps (R = rho L / A, rho from the material electricalResistivity model at the path temperature), ' +
    'in ohm and mohm with each element share, compared with the path limit (a sourced rule entry; llull has NO default limit and every limit is reported unverified). Status per path: pass; fail ' +
    '(EOP_BOND_RESISTANCE_EXCEEDED, or EOP_COATING_INSULATES when a bonded_interface coating on a joint solid is declared insulating); unknown (never pass): no limit (EOP_BOND_LIMIT_MISSING), an unresolved strap resistivity ' +
    '(EOP_RESISTIVITY_UNAVAILABLE), a coating whose electrical effect is undeclared or a surface system without a declared one (EOP_COATING_UNKNOWN), joined solids that do not touch (EOP_JOINT_NO_CONTACT). ' +
    'Every row has reviewRequired true: a qualified engineer decides; a failed or unknown path is disposed only by a human (dispose_bond_check, disposition pending_human until then). ' +
    'A joint also counts as touching when its two solids are consecutive layers of a placed fastener stack (list_fastener_stacks); a solid find_contacts did not test (a broken instance) is unknown (EOP_CONTACT_NOT_TESTED), never a pass. A joint naming no solids is flagged in unverifiedReasons. A composite strap (record productForm / designation) adds the warning EOP_CFRP_IN_PATH (status unchanged: a metallic path is needed). Part-geometry paths are not evaluated. Returns data { status, rows: [{ pathId, name, totalOhm, totalMilliohm, elements: [{ kind, ohm, share, provenance }], limit?, status, code, findings, warnings, unverified, unverifiedReasons, reviewRequired, disposition, inputsHash }], counts, open }.',
  params: z.object({
    pathIds: z.array(z.string()).optional().describe('Only these bond paths (ids from define_bond_path). Omit for all.'),
  }),
  run: (doc, { pathIds }, ctx): CommandResult => {
    const rows = checkedRows(doc, pathIds, ctx);
    if (!Array.isArray(rows)) return rows;
    const open = rows.filter((row) => row.status !== 'pass' && row.disposition !== 'accepted');
    const status = open.reduce<BondStatus>((worst, row) => (RANK[row.status] > RANK[worst] ? row.status : worst), 'pass');
    const counts: Record<string, number> = {};
    for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
    const worst = rows
      .filter((row) => row.status !== 'pass')
      .slice(0, 8)
      .map((row) => `${row.pathId} ${row.status} ${row.code}`);
    const tally = Object.entries(counts)
      .map(([name, n]) => `${name} ${n}`)
      .join(', ');
    const summary =
      `${COMMAND}: ${status} - ${rows.length} path(s) (${tally || 'none defined'}); ` +
      `every limit is unverified and every path needs a qualified engineer${worst.length > 0 ? `; ${worst.join('; ')}` : ''}.`;
    return report(doc, summary, {
      status,
      rows,
      counts,
      open: open.map((row) => row.pathId),
      reviewRequired: true,
      notes: [
        'bond limits are programme rules supplied by the owner (no default); part-geometry paths are not evaluated; CFRP is detected from the strap material record text only',
      ],
    });
  },
});
