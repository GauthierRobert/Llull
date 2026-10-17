/** The FE deck leaves the machine like any export: a document that uses ITAR / EAR material records gets no deck (TR-MAT-51). */
import { describe, expect, it } from 'vitest';
import { writeInp } from '@cae/decks/inpWriter';
import type { ExportMarking } from '@core/model/materialLibrary';
import type { CadDocument, Material } from '@core/model/types';
import { X0_NODES, barDocument, barMesh } from './deckFixtures';

function deckOf(marking: ExportMarking): { result: ReturnType<typeof writeInp>; materialName: string } {
  const bar = barDocument();
  const material = Object.values(bar.doc.materials)[0];
  if (material === undefined) throw new Error('the bar has no material');
  const record: NonNullable<Material['record']> = {
    id: material.name,
    designation: 'X',
    specs: [],
    licence: 'company-proprietary',
    exportMarking: marking,
  };
  const doc: CadDocument = { ...bar.doc, materials: { ...bar.doc.materials, [material.name]: { ...material, record } } };
  const sets = { [`C_${bar.constraints['x0']}`]: X0_NODES, [`C_${bar.constraints['nodeA']}`]: [1], [`C_${bar.constraints['nodeB']}`]: [3] };
  return { result: writeInp(doc, bar.analysisId, barMesh(doc, bar.analysisId, bar.boxId, sets)), materialName: material.name };
}

describe('writeInp export gate', () => {
  it('refuses a deck for an ITAR-marked material with MAT_EXPORT_CONTROLLED naming the record', () => {
    const { result, materialName } = deckOf({ regime: 'ITAR' });
    expect(result).toMatchObject({ code: 'MAT_EXPORT_CONTROLLED', ids: [materialName] });
    expect('text' in result).toBe(false);
  });

  it('writes the deck for an EAR99-marked material', () => {
    expect('text' in deckOf({ regime: 'EAR99' }).result).toBe(true);
  });
});
