/**
 * Pure UI helpers: shared visibility rule, animated-entity set, snap/pick visibility filters,
 * and command-result type guards.
 */

import { describe, it, expect } from 'vitest';
import { createEmptyDocument } from '@core/model/types';
import type { Animation, CadDocument, EntityGroup, LineEntity } from '@core/model/types';
import { isEntityVisible } from '../../src/ui/viewport/entityVisibility';
import { animatedEntityIds } from '../../src/ui/viewport/3d/animationClickHelpers';
import { collectSnapCandidates } from '../../src/ui/viewport/2d/snapping/candidates';
import { nearestEntityId } from '../../src/ui/viewport/2d/modifyHelpers';
import {
  isBoundsData,
  isClashData,
  isCodeExportData,
  isCsvData,
  isEstimateData,
  isNcFilesData,
  stringFields,
} from '../../src/ui/resultData';

function lineDoc(layerVisible = true): { doc: CadDocument; line: LineEntity } {
  const base = createEmptyDocument();
  const line: LineEntity = {
    id: 'l1',
    kind: 'line',
    start: [0, 0],
    end: [10, 0],
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    layerId: 'layer-default',
    color: '#ffffff',
  };
  const layer = base.layers['layer-default'];
  if (!layer) throw new Error('default layer missing');
  const doc: CadDocument = {
    ...base,
    layers: { ...base.layers, 'layer-default': { ...layer, visible: layerVisible } },
    entities: { l1: line },
    order: ['l1'],
  };
  return { doc, line };
}

describe('isEntityVisible', () => {
  it('is visible by default', () => {
    const { doc, line } = lineDoc();
    expect(isEntityVisible(line, doc.layers, new Set(), new Set())).toBe(true);
  });

  it('hides on document layer, viewport layer filter, or entity filter', () => {
    const hiddenLayerDoc = lineDoc(false);
    expect(
      isEntityVisible(hiddenLayerDoc.line, hiddenLayerDoc.doc.layers, new Set(), new Set()),
    ).toBe(false);
    const { doc, line } = lineDoc();
    expect(isEntityVisible(line, doc.layers, new Set(['layer-default']), new Set())).toBe(false);
    expect(isEntityVisible(line, doc.layers, new Set(), new Set(['l1']))).toBe(false);
  });
});

describe('hidden geometry is neither snapped nor picked', () => {
  const { doc } = lineDoc();
  const hidden = (): boolean => false;

  it('collectSnapCandidates skips entities rejected by isVisible', () => {
    expect(collectSnapCandidates(doc).length).toBeGreaterThan(0);
    expect(collectSnapCandidates(doc, { isVisible: hidden })).toEqual([]);
  });

  it('nearestEntityId honours a pixel-derived tolerance', () => {
    expect(nearestEntityId(doc, [5, 0.4], 0.5)).toBe('l1');
    expect(nearestEntityId(doc, [5, 0.4], 0.2)).toBeNull();
  });
});

describe('animatedEntityIds', () => {
  const animation = (id: string, targetKind: 'entity' | 'group', targetId: string): Animation =>
    ({ id, targetKind, targetId }) as Animation;
  const group: EntityGroup = { id: 'g1', name: 'G', memberIds: ['b2', 'b3'] } as EntityGroup;

  it('collects direct and group-member targets', () => {
    const ids = animatedEntityIds(
      { a1: animation('a1', 'entity', 'b1'), a2: animation('a2', 'group', 'g1') },
      { g1: group },
    );
    expect([...ids].sort()).toEqual(['b1', 'b2', 'b3']);
  });

  it('is empty without animations and tolerates a missing group', () => {
    expect(animatedEntityIds({}, {}).size).toBe(0);
    expect(animatedEntityIds({ a: animation('a', 'group', 'nope') }, {}).size).toBe(0);
  });
});

describe('result data guards', () => {
  it('accept the documented shapes and reject others', () => {
    expect(isCsvData({ csv: 'a' })).toBe(true);
    expect(isCsvData(undefined)).toBe(false);
    expect(isCsvData({ csv: 1 })).toBe(false);
    expect(isEstimateData({ csv: '', currency: 'EUR', total: 0, lines: [] })).toBe(true);
    expect(isEstimateData({ csv: '' })).toBe(false);
    expect(isClashData({ clashes: [{ a: 'x', b: 'y', kind: 'hard', depth: 1 }] })).toBe(true);
    expect(isClashData({ clashes: [{ a: 1 }] })).toBe(false);
    expect(isClashData(null)).toBe(false);
    expect(isNcFilesData({ files: [{ name: 'a', content: 'b' }] })).toBe(true);
    expect(isNcFilesData({ files: [{ name: 'a' }] })).toBe(false);
    expect(isCodeExportData({ text: 't', fileName: 'f' })).toBe(true);
    expect(isCodeExportData({ text: 't' })).toBe(false);
    expect(isBoundsData({ min: [0, 0, 0], max: [1, 1, 1] })).toBe(true);
    expect(isBoundsData({ min: [0, 0], max: [1, 1, 1] })).toBe(false);
    expect(stringFields({ a: 'x', b: 2 })).toEqual({ a: 'x' });
    expect(stringFields('nope')).toBeNull();
  });
});
