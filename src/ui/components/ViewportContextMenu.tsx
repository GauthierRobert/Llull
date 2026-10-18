// Blender-style right-click menu over the viewport. Right-drag still pans, so it opens only on a right click that barely moved.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PALETTE_SHORTCUT_LABEL } from '@ui/hooks/shortcuts';
import { deleteSelection, duplicateSelection, hideSelection, isolateSelection } from '@ui/actions/selectionActions';
import { createSolid } from '@ui/actions/createSolid';
import { SOLID_PRESETS } from '@ui/components/toolbar/solidPresets';
import { useDismiss } from '@ui/hooks/useDismiss';
import { useLayoutStore, usePaletteStore, useStore, useToolStore, useViewportStore } from '@ui/store';
import type { GizmoMode } from '@ui/store';

/** Max pointer travel (px) between right-button down and up that still counts as a click. */
const CLICK_SLOP = 5;
const EDGE_MARGIN = 8;
const ESTIMATED_MENU_SIZE = { width: 232, height: 360 };

interface MenuItem {
  label: string;
  shortcut: string;
  enabled: boolean;
  run(): void;
}
type MenuEntry = MenuItem | 'separator';

function useMenuEntries(): MenuEntry[] {
  const hasSelection = useStore((s) => s.document.selection.length > 0);
  const viewMode = useToolStore((s) => s.viewMode);
  const anyHidden = useViewportStore((s) => s.hiddenEntityIds.size > 0);
  return useMemo(() => {
    const showAll: MenuItem = {
      label: 'Show all',
      shortcut: 'Alt H',
      enabled: anyHidden,
      run: () => useViewportStore.getState().showAllEntities(),
    };
    if (!hasSelection) {
      return [
        ...SOLID_PRESETS.slice(0, 3).map(
          (preset): MenuItem => ({
            label: `Add ${preset.label.toLowerCase()}`,
            shortcut: '',
            enabled: true,
            run: () => createSolid(preset),
          }),
        ),
        'separator',
        showAll,
        { label: 'Search commands…', shortcut: PALETTE_SHORTCUT_LABEL, enabled: true, run: () => usePaletteStore.getState().setOpen(true) },
      ];
    }
    const gizmo = (label: string, shortcut: string, mode: GizmoMode): MenuItem => ({
      label,
      shortcut,
      enabled: true,
      run: () => useToolStore.getState().setGizmoMode(mode),
    });
    const transforms: MenuItem[] =
      viewMode === '3d'
        ? [gizmo('Move', 'G', 'translate'), gizmo('Rotate', 'R', 'rotate'), gizmo('Scale', 'S', 'scale')]
        : [{ label: 'Move', shortcut: 'M', enabled: true, run: () => useToolStore.getState().setDrawTool('move') }];
    return [
      ...transforms,
      { label: 'Duplicate', shortcut: 'Ctrl D', enabled: true, run: duplicateSelection },
      { label: 'Delete', shortcut: 'Del', enabled: true, run: deleteSelection },
      'separator',
      { label: 'Hide', shortcut: 'H', enabled: true, run: hideSelection },
      { label: 'Isolate', shortcut: 'Shift H', enabled: true, run: isolateSelection },
      showAll,
      'separator',
      { label: 'Properties', shortcut: 'N', enabled: true, run: () => useLayoutStore.getState().toggleInspector() },
    ];
  }, [hasSelection, viewMode, anyHidden]);
}

interface MenuPosition {
  left: number;
  top: number;
}

/** Pointer position kept inside the viewport rectangle once the menu size is known. */
function clampToBounds(point: MenuPosition, bounds: DOMRect, size: { width: number; height: number }): MenuPosition {
  const maxLeft = bounds.right - size.width - EDGE_MARGIN;
  const maxTop = bounds.bottom - size.height - EDGE_MARGIN;
  return {
    left: Math.max(bounds.left + EDGE_MARGIN, Math.min(point.left, maxLeft)),
    top: Math.max(bounds.top + EDGE_MARGIN, Math.min(point.top, maxTop)),
  };
}

export function ViewportContextMenu(): React.ReactElement | null {
  const [anchor, setAnchor] = useState<MenuPosition | null>(null);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const entries = useMenuEntries();
  const close = useCallback(() => setAnchor(null), []);

  useEffect(() => {
    const host = document.querySelector<HTMLElement>('.app-viewport');
    if (host === null) return undefined;
    let down: MenuPosition | null = null;
    const onContextMenu = (e: MouseEvent): void => e.preventDefault();
    const onPointerDown = (e: PointerEvent): void => {
      if (e.button === 2) down = { left: e.clientX, top: e.clientY };
    };
    const onPointerUp = (e: PointerEvent): void => {
      if (e.button !== 2 || down === null) return;
      const moved = Math.hypot(e.clientX - down.left, e.clientY - down.top);
      down = null;
      if (moved >= CLICK_SLOP) return;
      if (e.target instanceof Node && menuRef.current?.contains(e.target) === true) return;
      setAnchor({ left: e.clientX, top: e.clientY });
    };
    host.addEventListener('contextmenu', onContextMenu);
    host.addEventListener('pointerdown', onPointerDown);
    host.addEventListener('pointerup', onPointerUp);
    return () => {
      host.removeEventListener('contextmenu', onContextMenu);
      host.removeEventListener('pointerdown', onPointerDown);
      host.removeEventListener('pointerup', onPointerUp);
    };
  }, []);

  useDismiss(menuRef, anchor !== null, close);

  // Measured placement + initial focus: external DOM synchronization.
  useEffect(() => {
    const menu = menuRef.current;
    if (anchor === null || menu === null) return;
    const bounds =
      document.querySelector('.app-viewport')?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    const rect = menu.getBoundingClientRect();
    const size = rect.width > 0 ? { width: rect.width, height: rect.height } : ESTIMATED_MENU_SIZE;
    setPosition(clampToBounds(anchor, bounds, size));
    menu.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus();
  }, [anchor]);

  if (anchor === null) return null;

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') {
      // Marks the event handled so the global Escape (clear selection) stays out of it; useDismiss closes the menu.
      e.preventDefault();
      return;
    }
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
    const index = items.indexOf(document.activeElement as HTMLElement);
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (step !== 0) items[(index + step + items.length) % items.length]?.focus();
    else if (e.key === 'Home') items[0]?.focus();
    else if (e.key === 'End') items[items.length - 1]?.focus();
    else if (e.key === 'Tab') close();
    else return;
    e.preventDefault();
  };

  const shown = position ?? anchor;
  return (
    <div
      ref={menuRef}
      className="ctx-menu"
      role="menu"
      aria-label="Viewport actions"
      style={{ left: shown.left, top: shown.top, visibility: position === null ? 'hidden' : 'visible' }}
      onKeyDown={onKeyDown}
    >
      {entries.map((entry, index) =>
        entry === 'separator' ? (
          <div key={`sep-${index}`} className="ctx-menu__separator" role="separator" />
        ) : (
          <button
            key={entry.label}
            type="button"
            role="menuitem"
            className="ctx-menu__item"
            disabled={!entry.enabled}
            onClick={() => {
              close();
              entry.run();
            }}
          >
            <span>{entry.label}</span>
            {entry.shortcut !== '' && <kbd className="ctx-menu__kbd">{entry.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}
