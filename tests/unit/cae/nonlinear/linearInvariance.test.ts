import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@lib/sha256';
import { analysisInputHash } from '@cae/hash/inputHash';
import { writeInp } from '@cae/decks/inpWriter';
import { keyedTargets } from '@cae/hash/targets';
import { caseOf } from '@cae/shared/access';
import { X0_NODES, barDocument, barMesh } from '../deckFixtures';

/**
 * Literals captured BEFORE the nonlinear lane existed (ENG-1): a linear case must keep these byte for byte. Recaptured once (NG1,
 * 2026-10-22) when new analyses started recording `mesh.mesher: 'netgen'` instead of 'gmsh': the input hashes changed, and in the deck only
 * the header lines that print them (with 'gmsh' the deck still hashes to the ENG-1 value fdac79a9…4a5dbc).
 */
const LINEAR_FULL_HASH = 'e6f0f99dacb47011829b1de50de24ae7ebe75c0dbe476a36e285b5e3f0e09d1e';
const LINEAR_MESH_HASH = '0b1fe5b054fd3325a3cbc04f988f441a0be1e4fb379ce1c7ff17cb611b7ab0d3';
const LINEAR_DECK_SHA256 = 'a508b48b8cd2f83ba8ca2e05662636d282ef1df5cc2f2a1b88dd52274b1d205b';

describe('linear cases are untouched by the nonlinear lane', () => {
  it('keeps the input hashes and the deck bytes of a static case', () => {
    const bar = barDocument();
    const sets = {
      [`C_${bar.constraints['x0']}`]: X0_NODES,
      [`C_${bar.constraints['nodeA']}`]: [1],
      [`C_${bar.constraints['nodeB']}`]: [3],
    };
    expect(analysisInputHash(bar.doc, bar.analysisId, 'full')).toBe(LINEAR_FULL_HASH);
    expect(analysisInputHash(bar.doc, bar.analysisId, 'mesh')).toBe(LINEAR_MESH_HASH);
    const written = writeInp(bar.doc, bar.analysisId, barMesh(bar.doc, bar.analysisId, bar.boxId, sets));
    expect('text' in written && sha256Hex(written.text)).toBe(LINEAR_DECK_SHA256);
    const analysis = caseOf(bar.doc, bar.analysisId);
    expect(analysis?.nonlinear).toBeUndefined();
    expect(keyedTargets(analysis!).every((target) => !target.key.startsWith('N_') && !target.key.startsWith('S_'))).toBe(true);
  });
});
