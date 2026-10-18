import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@lib/sha256';
import { analysisInputHash } from '@cae/hash/inputHash';
import { writeInp } from '@cae/decks/inpWriter';
import { keyedTargets } from '@cae/hash/targets';
import { caseOf } from '@cae/shared/access';
import { X0_NODES, barDocument, barMesh } from '../deckFixtures';

/** Literals captured BEFORE the nonlinear lane existed (ENG-1): a linear case must keep these byte for byte. */
const LINEAR_FULL_HASH = '3bc979c4702161d0a15176c99976424ceccb4a94b8cb24e8292f35aba59a377c';
const LINEAR_MESH_HASH = '5bc0dc612feca6b72ebe64be6d8b2d4cc2a24d0fda8bc9a6a559b8f0b86149d2';
const LINEAR_DECK_SHA256 = 'e3213ae0e00b0e37062769e0d3df95095e1be37974d8e4706950a9cf9eecec7e';

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
