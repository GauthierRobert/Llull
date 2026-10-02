import { describe, it, expect } from 'vitest';
import { resolveShortcut, DRAW_TOOL_KEYS, SHORTCUT_GROUPS } from '@ui/hooks/shortcuts';

describe('resolveShortcut', () => {
  it('draw keys arm 2D tools from either view', () => {
    expect(resolveShortcut('3d', 'l')).toEqual({ kind: 'draw', tool: 'line' });
    expect(resolveShortcut('2d', 'P')).toEqual({ kind: 'draw', tool: 'polyline' });
    expect(resolveShortcut('3d', '.')).toEqual({ kind: 'draw', tool: 'point' });
  });

  it('R / S / M depend on the view', () => {
    expect(resolveShortcut('2d', 'r')).toEqual({ kind: 'draw', tool: 'rectangle' });
    expect(resolveShortcut('3d', 'r')).toEqual({ kind: 'gizmo', mode: 'rotate' });
    expect(resolveShortcut('2d', 's')).toEqual({ kind: 'draw', tool: 'spline' });
    expect(resolveShortcut('3d', 's')).toEqual({ kind: 'gizmo', mode: 'scale' });
    expect(resolveShortcut('2d', 'm')).toEqual({ kind: 'draw', tool: 'move' });
    expect(resolveShortcut('3d', 'm')).toEqual({ kind: 'gizmo', mode: 'translate' });
    expect(resolveShortcut('3d', 'g')).toEqual({ kind: 'gizmo', mode: 'translate' });
    expect(resolveShortcut('2d', 'v')).toEqual({ kind: 'draw', tool: 'none' });
  });

  it('2 and 3 switch views', () => {
    expect(resolveShortcut('3d', '2')).toEqual({ kind: 'view', viewMode: '2d' });
    expect(resolveShortcut('2d', '3')).toEqual({ kind: 'view', viewMode: '3d' });
  });

  it('returns null for unmapped keys (incl. 2D modify keys owned by the modify palette)', () => {
    expect(resolveShortcut('3d', 'q')).toBeNull();
    expect(resolveShortcut('2d', 'o')).toBeNull();
    expect(resolveShortcut('3d', 'v')).toBeNull();
  });

  it('every advertised draw-tool key resolves to that tool in the 2D view', () => {
    for (const [tool, key] of Object.entries(DRAW_TOOL_KEYS)) {
      expect(resolveShortcut('2d', key)).toEqual({ kind: 'draw', tool });
    }
  });

  it('the shortcut sheet has non-empty groups', () => {
    expect(SHORTCUT_GROUPS.length).toBeGreaterThan(0);
    for (const group of SHORTCUT_GROUPS) expect(group.entries.length).toBeGreaterThan(0);
  });
});
