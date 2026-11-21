// What each tool group of the command bar offers: sections of tools, built from the draw tools, the solid presets and the
// command tools. Picking one arms a tool, drops a solid, starts a drag-handle session or opens a command form.

import { type ModifyToolKind, useToolStore } from '@ui/store';
import type { IconName } from '@ui/components/Icon';
import { createSolid } from '@ui/actions/createSolid';
import { DRAW_TOOL_KEYS, MODIFY_TOOL_KEYS } from '@ui/hooks/shortcuts';
import { startFeatureOnSelection } from '@ui/viewport/3d/manipulators/FeatureStartBar';
import {
  type CommandTool,
  type CommandToolSection,
  annotateSections,
  inspectSections,
  modifySections,
  openCommandTool,
} from './commandTools';
import { DRAW_TOOLS } from './drawTools';
import { SOLID_PRESETS } from './solidPresets';
import type { DockTrayItem } from './DockTray';

export type ToolGroupId = 'sketch' | 'solid' | 'modify' | 'inspect';

interface FlyoutSection {
  id: string;
  label: string;
  items: DockTrayItem[];
}

interface ToolGroupSpec {
  id: ToolGroupId;
  label: string;
  icon: IconName;
  tip: string;
}

export const TOOL_GROUPS: readonly ToolGroupSpec[] = [
  { id: 'sketch', label: 'Sketch', icon: 'pencil', tip: 'Draw 2D shapes: lines, rectangles, circles…' },
  { id: 'solid', label: 'Solid', icon: 'cube', tip: 'Add a 3D solid: box, cylinder, sphere…' },
  { id: 'modify', label: 'Modify', icon: 'featureExtrude', tip: 'Extrude, fillet, combine, mirror, pattern…' },
  { id: 'inspect', label: 'Inspect', icon: 'ruler', tip: 'Measure distances, sizes and mass; check the model' },
];

/** Commands with a drag handle on the selection: the handle when the selection offers it, else the form. */
const HANDLE_FEATURES: Readonly<Record<string, 'extrude' | 'fillet' | 'shell'>> = { extrude: 'extrude', fillet: 'fillet', shell: 'shell' };

function pickCommandTool(tool: CommandTool): void {
  const feature = HANDLE_FEATURES[tool.id];
  if (feature !== undefined && startFeatureOnSelection(feature)) return;
  openCommandTool(tool);
}

function commandSections(sections: readonly CommandToolSection[], close: () => void): FlyoutSection[] {
  return sections.map((section) => ({
    id: section.id,
    label: section.label,
    items: section.tools.map((tool) => ({
      id: tool.id,
      label: tool.label,
      icon: tool.icon,
      hint: tool.hint,
      onPick: () => {
        close();
        pickCommandTool(tool);
      },
    })),
  }));
}

const SKETCH_EDIT_TOOLS: ReadonlyArray<{ tool: Exclude<ModifyToolKind, 'none'>; label: string; icon: IconName; hint: string }> = [
  { tool: 'offset', label: 'Offset', icon: 'modifyOffset', hint: 'copy a shape at a distance from itself' },
  { tool: 'fillet', label: 'Round corner', icon: 'modifyFillet', hint: 'round a corner of a polyline' },
  { tool: 'chamfer', label: 'Cut corner', icon: 'modifyChamfer', hint: 'bevel a corner of a polyline' },
  { tool: 'trim', label: 'Trim', icon: 'modifyTrim', hint: 'cut a line back to another line' },
  { tool: 'extend', label: 'Extend', icon: 'modifyExtend', hint: 'lengthen a line up to another line' },
  { tool: 'explode', label: 'Explode', icon: 'modifyExplode', hint: 'split a polyline into separate lines' },
];

function sketchEditSection(close: () => void): FlyoutSection {
  const { modifyTool, setModifyTool } = useToolStore.getState();
  return {
    id: 'sketch-edit',
    label: 'Edit a sketch',
    items: SKETCH_EDIT_TOOLS.map((spec) => ({
      id: `sketch-${spec.tool}`,
      label: spec.label,
      icon: spec.icon,
      hint: spec.hint,
      shortcut: MODIFY_TOOL_KEYS[spec.tool],
      active: modifyTool === spec.tool,
      onPick: () => {
        setModifyTool(modifyTool === spec.tool ? 'none' : spec.tool);
        close();
      },
    })),
  };
}

function drawSection(close: () => void): FlyoutSection {
  const { drawTool, viewMode, setDrawTool } = useToolStore.getState();
  return {
    id: 'draw',
    label: 'Draw',
    items: DRAW_TOOLS.map((spec) => {
      const active = viewMode === '2d' && drawTool === spec.tool;
      return {
        id: spec.tool,
        label: spec.label,
        icon: spec.icon,
        hint: spec.tip,
        shortcut: DRAW_TOOL_KEYS[spec.tool],
        active,
        onPick: () => {
          setDrawTool(active ? 'none' : spec.tool);
          close();
        },
      };
    }),
  };
}

function solidSection(close: () => void): FlyoutSection {
  return {
    id: 'primitives',
    label: 'Add a solid',
    items: SOLID_PRESETS.map((preset) => ({
      id: preset.command,
      label: preset.label,
      icon: preset.icon,
      hint: 'adds one at a free spot near the origin and selects it so you can drag it',
      onPick: () => {
        createSolid(preset);
        close();
      },
    })),
  };
}

/** The sections of a tool group, read from the stores at call time (the flyout re-renders with the tool store). */
export function flyoutSections(group: ToolGroupId, close: () => void): FlyoutSection[] {
  switch (group) {
    case 'sketch':
      return [drawSection(close), ...commandSections(annotateSections(), close)];
    case 'solid':
      return [solidSection(close)];
    case 'modify': {
      const solids = commandSections(modifySections(), close);
      // The sketch edits come first while drafting, last while modelling.
      return useToolStore.getState().viewMode === '2d' ? [sketchEditSection(close), ...solids] : [...solids, sketchEditSection(close)];
    }
    case 'inspect':
      return commandSections(inspectSections(), close);
  }
}
