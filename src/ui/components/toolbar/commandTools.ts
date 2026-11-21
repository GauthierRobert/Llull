// The modelling and inspection commands the command bar offers by name: each opens the command's generated form (ids pre-filled from
// the selection, a live preview where the command has one). Presentation data only; the registry stays the catalog (L5).

import { getCommand } from '@core/commands/registry';
import type { CadDocument, EntityId } from '@core/model/types';
import { is3D } from '@core/model/types';
import type { IconName } from '@ui/components/Icon';
import { usePaletteStore, useStore } from '@ui/store';

type BooleanOp = 'union' | 'subtract' | 'intersect';

export interface CommandTool {
  id: string;
  label: string;
  icon: IconName;
  /** What it does and what to select first, in plain words. */
  hint: string;
  command: string;
  /** Form values this shortcut already knows (on top of the selection pre-fill). */
  preset?: (document: CadDocument) => Record<string, unknown>;
}

export interface CommandToolSection {
  id: string;
  label: string;
  tools: readonly CommandTool[];
}

/** The selected solids, in selection order. */
function selectedSolids(document: CadDocument): EntityId[] {
  return document.selection.filter((id) => {
    const entity = document.entities[id];
    return entity !== undefined && is3D(entity);
  });
}

/** `a` = the first selected solid (the one that is kept / cut), `b` = the others. */
export function booleanPreset(op: BooleanOp, document: CadDocument): Record<string, unknown> {
  const [a, ...rest] = selectedSolids(document);
  const b = rest.length === 1 ? rest[0] : rest;
  return { op, ...(a !== undefined && { a }), ...(rest.length > 0 && { b }) };
}

const combine = (op: BooleanOp, label: string, icon: IconName, hint: string): CommandTool => ({
  id: `boolean-${op}`,
  label,
  icon,
  hint,
  command: 'boolean',
  preset: (document) => booleanPreset(op, document),
});

const SHAPE_TOOLS: readonly CommandTool[] = [
  {
    id: 'extrude',
    label: 'Extrude',
    icon: 'featureExtrude',
    hint: 'pull a closed sketch into a solid — select the sketch first',
    command: 'extrude_profile',
  },
  {
    id: 'revolve',
    label: 'Revolve',
    icon: 'featureRevolve',
    hint: 'spin a sketch around an axis into a solid',
    command: 'revolve_profile',
  },
  { id: 'sweep', label: 'Sweep', icon: 'featureSweep', hint: 'run a sketch along a path', command: 'sweep_profile' },
  { id: 'loft', label: 'Loft', icon: 'featureLoft', hint: 'blend a solid through several sketches', command: 'loft_sections' },
];

const REFINE_TOOLS: readonly CommandTool[] = [
  { id: 'fillet', label: 'Fillet', icon: 'modifyFillet', hint: 'round the edges of a solid', command: 'fillet_edge' },
  { id: 'chamfer', label: 'Chamfer', icon: 'modifyChamfer', hint: 'bevel the edges of a solid', command: 'chamfer_edge' },
  { id: 'shell', label: 'Shell', icon: 'featureShell', hint: 'hollow a solid, keeping a wall thickness', command: 'shell_solid' },
  { id: 'hole', label: 'Hole', icon: 'featureHole', hint: 'drill a hole into a solid', command: 'add_hole' },
];

const COMBINE_TOOLS: readonly CommandTool[] = [
  combine('union', 'Union', 'boolUnion', 'merge the selected solids into one'),
  combine('subtract', 'Subtract', 'boolSubtract', 'cut the other selected solids out of the first one'),
  combine('intersect', 'Intersect', 'boolIntersect', 'keep only the volume the selected solids share'),
];

const ARRANGE_TOOLS: readonly CommandTool[] = [
  { id: 'mirror', label: 'Mirror', icon: 'arrangeMirror', hint: 'copy the selection across a plane', command: 'mirror_entity' },
  {
    id: 'array-linear',
    label: 'Linear pattern',
    icon: 'arrangeLinear',
    hint: 'repeat the selection along a direction',
    command: 'array_linear',
  },
  {
    id: 'array-polar',
    label: 'Circular pattern',
    icon: 'arrangePolar',
    hint: 'repeat the selection around an axis',
    command: 'array_polar',
  },
  { id: 'align', label: 'Align', icon: 'arrangeAlign', hint: 'line the selected objects up with each other', command: 'align' },
];

const MEASURE_TOOLS: readonly CommandTool[] = [
  { id: 'distance', label: 'Distance', icon: 'ruler', hint: 'distance between two objects or points', command: 'measure_distance' },
  { id: 'angle', label: 'Angle', icon: 'measureAngle', hint: 'angle between two lines or faces', command: 'measure_angle' },
  { id: 'area', label: 'Area', icon: 'drawHatch', hint: 'area of a closed shape or a solid surface', command: 'measure_area' },
  { id: 'bounding-box', label: 'Size', icon: 'fit', hint: 'overall length, width and height', command: 'measure_bounding_box' },
  { id: 'mass', label: 'Mass', icon: 'measureMass', hint: 'volume, mass and centre of gravity', command: 'mass_properties' },
];

const CHECK_TOOLS: readonly CommandTool[] = [
  { id: 'check', label: 'Check model', icon: 'review', hint: 'scan the model for geometry and parameter problems', command: 'check_model' },
];

const ANNOTATE_TOOLS: readonly CommandTool[] = [
  { id: 'dimension', label: 'Dimension', icon: 'dimension', hint: 'add a dimension between two points', command: 'add_dimension' },
  { id: 'text', label: 'Text', icon: 'text', hint: 'place a text note', command: 'add_text' },
];

/** Only the tools whose command is registered (a host without a plugin never shows a dead button). */
function registered(id: string, label: string, tools: readonly CommandTool[]): CommandToolSection[] {
  const available = tools.filter((tool) => getCommand(tool.command) !== undefined);
  return available.length === 0 ? [] : [{ id, label, tools: available }];
}

export function modifySections(): CommandToolSection[] {
  return [
    ...registered('shape', 'Sketch to solid', SHAPE_TOOLS),
    ...registered('refine', 'Refine', REFINE_TOOLS),
    ...registered('combine', 'Combine', COMBINE_TOOLS),
    ...registered('arrange', 'Copy & arrange', ARRANGE_TOOLS),
  ];
}

export function inspectSections(): CommandToolSection[] {
  return [...registered('measure', 'Measure', MEASURE_TOOLS), ...registered('check', 'Check', CHECK_TOOLS)];
}

export function annotateSections(): CommandToolSection[] {
  return registered('annotate', 'Annotate', ANNOTATE_TOOLS);
}

/** The three boolean shortcuts (selection bar, when several solids are selected). */
export function combineTools(): readonly CommandTool[] {
  return getCommand('boolean') === undefined ? [] : COMBINE_TOOLS;
}

/** Opens the command's form with the selection (and the tool's preset) filled in. */
export function openCommandTool(tool: CommandTool): void {
  usePaletteStore.getState().openCommand(tool.command, tool.preset?.(useStore.getState().document));
}
