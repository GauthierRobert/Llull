/**
 * The guard of a second fillet step (BLD_FILLET_NOT_TANGENT, TECHNICAL_SPEC 13.26): the read-back is only made for a source that already has a fillet, only a G1 failure refuses, the worst angle is reported, the document is unchanged.
 * The native proof is server/tests/nativeFilletKink.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkBlends } from '@core/commands/brep/checkBlends';
import { refuseKinkedFillet } from '@core/commands/brep/filletTangency';
import type { CommandResult } from '@core/commands/types';
import { createEmptyDocument, type ShapeRecipe } from '@core/model/types';

const doc = createEmptyDocument();
const next = { ...doc, order: ['mesh-1'] };
const committed: CommandResult = { document: next, summary: 'ok', affected: ['mesh-1'] };
const filleted = { op: 'fillet', source: { op: 'brep' }, edges: [0], size: 1 } as unknown as ShapeRecipe;
const plain = { op: 'brep' } as unknown as ShapeRecipe;

const answer = (findings: unknown[]): CommandResult => ({ document: next, summary: 'check', affected: [], data: { findings } });

afterEach(() => vi.restoreAllMocks());

describe('refuseKinkedFillet', () => {
  it('a source without a fillet is not read back; a failed step (same document) neither', () => {
    const run = vi.spyOn(checkBlends, 'run');
    expect(refuseKinkedFillet(doc, 'fillet_edge', 'a', committed, plain, undefined)).toBeNull();
    expect(refuseKinkedFillet(doc, 'fillet_edge', 'a', { ...committed, document: doc }, filleted, undefined)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('a G1 failure refuses by name with the worst measured angle; other findings and warnings do not', () => {
    const kink = { code: 'BLD_CHECK_G1_ANGLE', severity: 'fail', value: 0.03, limit: 0.01, edge: 4 };
    vi.spyOn(checkBlends, 'run').mockReturnValue(answer([kink, { ...kink, value: 0.044 }]));
    const refused = refuseKinkedFillet(doc, 'fillet_edge', 'a', committed, filleted, undefined);
    expect(refused?.error?.code).toBe('BLD_FILLET_NOT_TANGENT');
    expect(refused?.error?.paths).toEqual(['radius']);
    expect(refused?.summary).toContain('0.044');
    expect(refused?.document).toBe(doc);
    vi.spyOn(checkBlends, 'run').mockReturnValue(
      answer([
        { code: 'BLD_CHECK_G2_JUMP', severity: 'info', value: 1 },
        { ...kink, severity: 'warn' },
      ]),
    );
    expect(refuseKinkedFillet(doc, 'fillet_edge', 'a', committed, filleted, undefined)).toBeNull();
    vi.spyOn(checkBlends, 'run').mockReturnValue({ document: next, summary: 'not_run', affected: [] });
    expect(refuseKinkedFillet(doc, 'fillet_edge', 'a', committed, filleted, undefined)).toBeNull();
  });
});
