/**
 * @layer ui/components/commandPalette
 *
 * The palette catalog: app actions (tools, views, panels, edit) plus EVERY registry command
 * (architecture L5 — menus iterate `listCommands()`), so each command the MCP surface exposes is
 * reachable from the UI too. Actions only call store actions; commands go through `dispatch`.
 */

import type { CommandDefinition } from '@core/commands/types';
import { listCommands } from '@core/commands/registry';
import { useLayoutStore, useStore, useThemeStore, useToolStore } from '@ui/store';
import type { IconName } from '@ui/components/Icon';
import { deleteSelection, duplicateSelection } from '@ui/actions/selectionActions';
import { createSolid } from '@ui/actions/createSolid';
import { DRAW_TOOL_KEYS, GIZMO_KEYS } from '@ui/hooks/shortcuts';
import { SOLID_PRESETS } from '@ui/components/toolbar/solidPresets';
import { DRAW_TOOLS } from '@ui/components/toolbar/drawTools';
import { SIDEBAR_TAB_SPECS } from '@ui/components/sidebarTabs';
import { fuzzyScore } from './fuzzyMatch';
import { humanizeName } from './paramForm';

type PaletteGroup = 'Recent' | 'Create' | 'Draw' | 'View' | 'Edit' | 'Panels' | 'Commands';

interface PaletteItemBase {
  /** Stable id, used for recents (`action:…` / `command:<name>`). */
  id: string;
  label: string;
  group: PaletteGroup;
  /** Secondary line: what it does. */
  hint: string;
  /** Extra search text (command name, synonyms). */
  keywords: string;
  icon: IconName;
  shortcut?: string;
}

interface PaletteAction extends PaletteItemBase {
  kind: 'action';
  run(): void;
}

interface PaletteCommand extends PaletteItemBase {
  kind: 'command';
  command: CommandDefinition<unknown>;
}

export type PaletteItem = PaletteAction | PaletteCommand;

function action(
  id: string,
  group: PaletteGroup,
  label: string,
  hint: string,
  icon: IconName,
  run: () => void,
  extra: { keywords?: string; shortcut?: string | undefined } = {},
): PaletteAction {
  const item: PaletteAction = {
    kind: 'action',
    id: `action:${id}`,
    group,
    label,
    hint,
    icon,
    keywords: extra.keywords ?? '',
    run,
  };
  if (extra.shortcut !== undefined) item.shortcut = extra.shortcut;
  return item;
}

const tools = (): ReturnType<typeof useToolStore.getState> => useToolStore.getState();
const layout = (): ReturnType<typeof useLayoutStore.getState> => useLayoutStore.getState();
const store = (): ReturnType<typeof useStore.getState> => useStore.getState();

function appActions(): PaletteAction[] {
  return [
    ...SOLID_PRESETS.map((preset) =>
      action(
        `solid-${preset.command}`,
        'Create',
        `Add ${preset.label.toLowerCase()}`,
        'One click: default size, placed in view and selected',
        preset.icon,
        () => createSolid(preset),
        { keywords: `${preset.command} solid 3d primitive` },
      ),
    ),
    ...DRAW_TOOLS.map((spec) =>
      action(
        `draw-${spec.tool}`,
        'Draw',
        `Draw ${spec.label.toLowerCase()}`,
        `2D tool: ${spec.tip}`,
        spec.icon,
        () => tools().setDrawTool(spec.tool),
        { keywords: 'sketch 2d tool', shortcut: DRAW_TOOL_KEYS[spec.tool] },
      ),
    ),
    action(
      'view-3d',
      'View',
      'Switch to 3D view',
      'Perspective modeling view',
      'cube',
      () => tools().setViewMode('3d'),
      { shortcut: '3' },
    ),
    action(
      'view-2d',
      'View',
      'Switch to 2D view',
      'Top-down drafting view',
      'square',
      () => tools().setViewMode('2d'),
      { shortcut: '2' },
    ),
    action(
      'gizmo-translate',
      'View',
      'Move gizmo',
      'Drag selected solids along axes (3D)',
      'transformMove',
      () => tools().setGizmoMode('translate'),
      { keywords: 'translate transform', shortcut: GIZMO_KEYS.translate },
    ),
    action(
      'gizmo-rotate',
      'View',
      'Rotate gizmo',
      'Rotate selected solids (3D)',
      'transformRotate',
      () => tools().setGizmoMode('rotate'),
      { keywords: 'transform', shortcut: GIZMO_KEYS.rotate },
    ),
    action(
      'gizmo-scale',
      'View',
      'Scale gizmo',
      'Scale selected solids (3D)',
      'transformScale',
      () => tools().setGizmoMode('scale'),
      { keywords: 'transform resize', shortcut: GIZMO_KEYS.scale },
    ),
    action(
      'theme',
      'View',
      'Toggle light / dark theme',
      'Switch the color theme',
      'sun',
      () => useThemeStore.getState().toggleTheme(),
      { keywords: 'appearance mode color' },
    ),
    action('undo', 'Edit', 'Undo', 'Revert the last change', 'undo', () => store().undo(), {
      shortcut: 'Ctrl Z',
    }),
    action(
      'redo',
      'Edit',
      'Redo',
      'Re-apply the last undone change',
      'redo',
      () => store().redo(),
      {
        shortcut: 'Ctrl Y',
      },
    ),
    action(
      'duplicate',
      'Edit',
      'Duplicate selection',
      'Copy the selected entities',
      'copy',
      duplicateSelection,
      { shortcut: 'Ctrl D' },
    ),
    action(
      'delete',
      'Edit',
      'Delete selection',
      'Remove the selected entities',
      'trash',
      deleteSelection,
      { keywords: 'remove erase', shortcut: 'Del' },
    ),
    action(
      'clear-selection',
      'Edit',
      'Clear selection',
      'Deselect everything',
      'cursor',
      () => store().clearSelection(),
      { keywords: 'deselect', shortcut: 'Esc' },
    ),
    action(
      'toggle-sidebar',
      'Panels',
      'Toggle document browser',
      'Show or hide the left panel',
      'panelLeft',
      () => layout().toggleSidebar(),
      { keywords: 'sidebar' },
    ),
    action(
      'toggle-inspector',
      'Panels',
      'Toggle properties inspector',
      'Show or hide the right panel',
      'panelRight',
      () => layout().toggleInspector(),
      { keywords: 'properties' },
    ),
    ...SIDEBAR_TAB_SPECS.map((spec) =>
      action(
        `panel-${spec.tab}`,
        'Panels',
        `Open ${spec.label}`,
        `Show the ${spec.label} panel`,
        spec.icon,
        () => {
          if (!(layout().sidebarOpen && layout().sidebarTab === spec.tab)) {
            layout().selectSidebarTab(spec.tab);
          }
        },
      ),
    ),
    action(
      'shortcuts',
      'Panels',
      'Keyboard shortcuts',
      'Show every shortcut',
      'keyboard',
      () => tools().setShortcutsOpen(true),
      { keywords: 'help keys', shortcut: '?' },
    ),
  ];
}

/** Commands that need input get the conventional "…" (opens a form instead of running). */
function commandItem(command: CommandDefinition<unknown>): PaletteCommand {
  const needsInput = Object.keys(command.paramsSchema.properties).length > 0;
  return {
    kind: 'command',
    id: `command:${command.name}`,
    group: 'Commands',
    label: `${humanizeName(command.name)}${needsInput ? '…' : ''}`,
    hint: command.description,
    keywords: `${command.name} ${command.annotations?.readOnly === true ? 'query inspect ' : ''}${command.description}`,
    icon: command.annotations?.readOnly === true ? 'info' : 'zap',
    command,
  };
}

/** Every palette item: app actions first, then every registry command in registry order. */
export function allPaletteItems(): PaletteItem[] {
  return [...appActions(), ...listCommands().map(commandItem)];
}

/**
 * Filter + rank for a query. Empty query: recents (as group 'Recent') then everything else in
 * catalog order. Non-empty: best score first; ties keep catalog order (actions before commands).
 */
export function searchPaletteItems(
  items: readonly PaletteItem[],
  query: string,
  recentIds: readonly string[],
): PaletteItem[] {
  if (query.trim() === '') {
    const byId = new Map(items.map((item) => [item.id, item]));
    const recent = recentIds
      .map((id) => byId.get(id))
      .filter((item): item is PaletteItem => item !== undefined)
      .map((item): PaletteItem => ({ ...item, group: 'Recent' }));
    const recentSet = new Set(recent.map((item) => item.id));
    return [...recent, ...items.filter((item) => !recentSet.has(item.id))];
  }
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, item.label, item.keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
