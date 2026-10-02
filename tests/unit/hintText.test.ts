import { describe, it, expect } from 'vitest';
import { hintText } from '@ui/components/hintText';
import type { HintContext } from '@ui/components/hintText';

const base: HintContext = {
  viewMode: '3d',
  drawTool: 'none',
  modifyTool: 'none',
  gizmoMode: 'translate',
  selectionCount: 0,
  entityCount: 3,
};

describe('hintText', () => {
  it('points an empty model at the toolbar', () => {
    expect(hintText({ ...base, entityCount: 0 })).toMatch(/toolbar/i);
  });

  it('explains selection when nothing is selected', () => {
    expect(hintText(base)).toMatch(/click an object/i);
    expect(hintText({ ...base, viewMode: '2d' })).toMatch(/click a shape/i);
  });

  it('explains the gizmo for a single 3D selection', () => {
    expect(hintText({ ...base, selectionCount: 1 })).toMatch(/drag an arrow/i);
    expect(hintText({ ...base, selectionCount: 1, gizmoMode: 'rotate' })).toMatch(/ring/i);
    expect(hintText({ ...base, selectionCount: 1, gizmoMode: 'scale' })).toMatch(/resize/i);
  });

  it('covers multi-selection in 3D and selection in 2D', () => {
    expect(hintText({ ...base, selectionCount: 2 })).toMatch(/2 selected/);
    expect(hintText({ ...base, viewMode: '2d', selectionCount: 1 })).toMatch(/M to move/);
  });

  it('describes the armed draw tool and the 2D move tool', () => {
    expect(hintText({ ...base, viewMode: '2d', drawTool: 'rectangle' })).toMatch(/two opposite/);
    expect(hintText({ ...base, viewMode: '2d', drawTool: 'move' })).toMatch(/select something/i);
    expect(hintText({ ...base, viewMode: '2d', drawTool: 'move', selectionCount: 2 })).toMatch(
      /base point/,
    );
  });

  it('defers to the modify palette prompt while a modify tool is armed', () => {
    expect(hintText({ ...base, viewMode: '2d', modifyTool: 'fillet' })).toMatch(/^Fillet: follow/);
  });
});
