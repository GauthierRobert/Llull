// The commands that fit the current selection, most likely first: the palette opens on them, so "select, then ask what can be done
// with this" needs no typing. Pure; names that are not registered are dropped by the caller's catalog lookup.

import type { CadDocument, Entity } from '@core/model/types';
import { is2D, is3D } from '@core/model/types';

const SOLID_COMMANDS = [
  'fillet_edge',
  'chamfer_edge',
  'shell_solid',
  'add_hole',
  'mirror_entity',
  'array_linear',
  'array_polar',
  'mass_properties',
  'measure_bounding_box',
] as const;

const SKETCH_COMMANDS = ['extrude_profile', 'revolve_profile', 'offset_2d', 'mirror_entity', 'array_linear', 'measure_area'] as const;

const SEVERAL_SOLIDS_COMMANDS = ['boolean', 'align', 'measure_distance', 'group_entities'] as const;

const SEVERAL_SKETCHES_COMMANDS = ['loft_sections', 'extrude_profile', 'align', 'measure_distance', 'group_entities'] as const;

const SEVERAL_COMMANDS = ['align', 'measure_distance', 'group_entities'] as const;

function selectedEntities(document: CadDocument): Entity[] {
  return document.selection.map((id) => document.entities[id]).filter((entity): entity is Entity => entity !== undefined);
}

/** Palette ids (`command:<name>`) suggested for the document's selection; empty without one. @pure */
export function suggestedPaletteIds(document: CadDocument): string[] {
  const selected = selectedEntities(document);
  const [first] = selected;
  if (first === undefined) return [];
  const names = ((): readonly string[] => {
    if (selected.length === 1) return is3D(first) ? SOLID_COMMANDS : is2D(first) ? SKETCH_COMMANDS : [];
    if (selected.every(is3D)) return SEVERAL_SOLIDS_COMMANDS;
    if (selected.every(is2D)) return SEVERAL_SKETCHES_COMMANDS;
    return SEVERAL_COMMANDS;
  })();
  return names.map((name) => `command:${name}`);
}
