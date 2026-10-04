/**
 * @layer ui/hooks
 *
 * Single-key tool shortcuts — the one table read by the keyboard handler, the toolbar tooltips
 * and the shortcut sheet, so an advertised key is always a working key.
 * Keys are view-scoped: in the 3D view R/S drive the gizmo; in the 2D view they arm draw tools.
 */

import type { DrawToolKind, GizmoMode, ViewMode } from '@ui/store';

const IS_APPLE_PLATFORM =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.userAgent);

/** Label for the command-palette shortcut on this platform (⌘K on Apple, Ctrl K elsewhere). */
export const PALETTE_SHORTCUT_LABEL = IS_APPLE_PLATFORM ? '⌘K' : 'Ctrl K';

type ShortcutAction =
  | { kind: 'draw'; tool: DrawToolKind }
  | { kind: 'gizmo'; mode: GizmoMode }
  | { kind: 'view'; viewMode: ViewMode };

/** Draw-tool keys valid in both views (arming one switches to 2D). */
const DRAW_KEYS: Readonly<Record<string, DrawToolKind>> = {
  l: 'line',
  p: 'polyline',
  w: 'wall',
  c: 'circle',
  '.': 'point',
};

/** Keys whose meaning depends on the view. */
const KEYS_2D: Readonly<Record<string, DrawToolKind>> = {
  r: 'rectangle',
  s: 'spline',
  m: 'move',
  v: 'none',
};

const KEYS_3D: Readonly<Record<string, GizmoMode>> = {
  g: 'translate',
  m: 'translate',
  r: 'rotate',
  s: 'scale',
};

/** Display key for each draw tool, as shown in tooltips (undefined = no single-key shortcut). */
export const DRAW_TOOL_KEYS: Readonly<Partial<Record<DrawToolKind, string>>> = {
  none: 'V',
  move: 'M',
  line: 'L',
  polyline: 'P',
  wall: 'W',
  circle: 'C',
  rectangle: 'R',
  spline: 'S',
  point: '.',
};

/** Display key for each gizmo mode in the 3D view. */
export const GIZMO_KEYS: Readonly<Record<GizmoMode, string>> = {
  translate: 'M',
  rotate: 'R',
  scale: 'S',
};

/** Resolve an unmodified key press to a tool action, or null when the key is not a shortcut. */
export function resolveShortcut(viewMode: ViewMode, key: string): ShortcutAction | null {
  const lower = key.toLowerCase();
  if (lower === '2') return { kind: 'view', viewMode: '2d' };
  if (lower === '3') return { kind: 'view', viewMode: '3d' };
  const drawTool = DRAW_KEYS[lower];
  if (drawTool !== undefined) return { kind: 'draw', tool: drawTool };
  if (viewMode === '2d') {
    const tool2d = KEYS_2D[lower];
    return tool2d === undefined ? null : { kind: 'draw', tool: tool2d };
  }
  const gizmoMode = KEYS_3D[lower];
  return gizmoMode === undefined ? null : { kind: 'gizmo', mode: gizmoMode };
}

interface ShortcutGroup {
  title: string;
  entries: ReadonlyArray<{ keys: string; action: string }>;
}

/** Content of the shortcut sheet. */
export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: 'General',
    entries: [
      { keys: PALETTE_SHORTCUT_LABEL, action: 'Search & run any command' },
      { keys: 'Ctrl Z', action: 'Undo' },
      { keys: 'Ctrl Y', action: 'Redo (also Ctrl Shift Z)' },
      { keys: 'Ctrl D', action: 'Duplicate selection' },
      { keys: 'Del', action: 'Delete selection' },
      { keys: 'Esc', action: 'Cancel tool, then clear selection' },
      { keys: 'Arrows', action: 'Nudge selection by 1 (Shift: 10)' },
      { keys: '2 / 3', action: 'Switch to 2D / 3D view' },
      { keys: '?', action: 'Show this sheet' },
    ],
  },
  {
    title: '3D view',
    entries: [
      { keys: 'Click', action: 'Select an object (Shift-click adds)' },
      { keys: 'M / G', action: 'Move gizmo — drag an arrow' },
      { keys: 'R', action: 'Rotate gizmo — drag a ring' },
      { keys: 'S', action: 'Scale gizmo' },
      { keys: 'Drag', action: 'Orbit on empty space (right-drag pans, wheel zooms)' },
    ],
  },
  {
    title: '2D view',
    entries: [
      { keys: 'V', action: 'Select' },
      { keys: 'M', action: 'Move selection: base point, then destination' },
      { keys: 'L / P / W', action: 'Line / Polyline / Wall' },
      { keys: 'R / C / S / .', action: 'Rectangle / Circle / Spline / Point' },
      { keys: 'Enter', action: 'Finish polyline, wall or spline' },
      {
        keys: 'O F K T X E',
        action: 'Offset, Fillet, Chamfer, Trim, Extend, Explode (left palette)',
      },
    ],
  },
];
