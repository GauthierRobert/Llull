/** Review fixes 2 and 3: the input hash follows the material assignment, the physical material and the document unit - not presentation. */
import { describe, expect, it } from 'vitest';
import { execute } from '@core/commands/registry';
import { analysisInputHash } from '@cae/index';
import type { CadDocument } from '@core/model/types';
import { modelWithAnalysis } from './helpers';

const hashes = (doc: CadDocument, id: string): { mesh: string; full: string } => ({
  mesh: analysisInputHash(doc, id, 'mesh'),
  full: analysisInputHash(doc, id, 'full'),
});

function twoMaterialsTwoParts(): { doc: CadDocument; first: string; second: string; analysisId: string } {
  const { doc: base, boxId: first, analysisId } = modelWithAnalysis();
  const box = execute(base, 'add_box', { size: [5, 5, 5] });
  const second = box.affected[0] ?? '';
  let doc = execute(box.document, 'set_part_idealization', { analysisId, entityId: second }).document;
  for (const [name, density] of [
    ['steel', 0.00785],
    ['alu', 0.0027],
  ] as const)
    doc = execute(doc, 'create_material', { name, density, color: '#999999', metalness: 1, roughness: 0.5 }).document;
  doc = execute(doc, 'assign_material', { materialName: 'steel', entityIds: [first] }).document;
  doc = execute(doc, 'assign_material', { materialName: 'alu', entityIds: [second] }).document;
  return { doc, first, second, analysisId };
}

describe('input hash and materials (review finding 2)', () => {
  it('swapping the materials of two parts changes both hashes', () => {
    const { doc, first, second, analysisId } = twoMaterialsTwoParts();
    const swapped = execute(execute(doc, 'assign_material', { materialName: 'alu', entityIds: [first] }).document, 'assign_material', {
      materialName: 'steel',
      entityIds: [second],
    }).document;
    expect(hashes(swapped, analysisId).full).not.toBe(hashes(doc, analysisId).full);
    expect(hashes(swapped, analysisId).mesh).not.toBe(hashes(doc, analysisId).mesh);
  });

  it('recolouring or renaming a material (presentation) leaves both hashes unchanged', () => {
    const { doc, analysisId } = twoMaterialsTwoParts();
    const steel = doc.materials['steel']!;
    const recoloured: CadDocument = {
      ...doc,
      materials: {
        ...doc.materials,
        steel: { ...steel, name: 'renamed', color: '#ff0000', metalness: 0.1, roughness: 0.9, finish: { pattern: 'brushed', scale: 5 } },
      },
    };
    expect(hashes(recoloured, analysisId)).toEqual(hashes(doc, analysisId));
  });

  it('a change of density still changes the full hash only', () => {
    const { doc, analysisId } = twoMaterialsTwoParts();
    const heavier: CadDocument = { ...doc, materials: { ...doc.materials, steel: { ...doc.materials['steel']!, density: 0.009 } } };
    expect(hashes(heavier, analysisId).full).not.toBe(hashes(doc, analysisId).full);
    expect(hashes(heavier, analysisId).mesh).toBe(hashes(doc, analysisId).mesh);
  });
});

describe('input hash and the document unit (review finding 3)', () => {
  it('set_units changes both hashes', () => {
    const { doc, analysisId } = modelWithAnalysis();
    const inches = execute(doc, 'set_units', { units: 'in' });
    expect(inches.document.units).toBe('in');
    expect(hashes(inches.document, analysisId).mesh).not.toBe(hashes(doc, analysisId).mesh);
    expect(hashes(inches.document, analysisId).full).not.toBe(hashes(doc, analysisId).full);
  });
});
