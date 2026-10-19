import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import { apply, ok } from '../../../helpers/commandAssertions';

const validation = join(import.meta.dirname, '..', '..', '..', '..', 'docs', 'aerospace', '06-composites', 'validation');

/** A JSON file of the CMP validation pack. */
export const pack = <T>(name: string): T => JSON.parse(readFileSync(join(validation, name), 'utf8')) as T;

export const T300 = {
  name: 'T300_5208',
  form: 'ud_tape',
  E1: 181000,
  E2: 10300,
  G12: 7170,
  nu12: 0.28,
  Xt: 1500,
  Xc: 1500,
  Yt: 40,
  Yc: 246,
  S: 68,
  plyThickness: 0.125,
  density: 0.0016,
  basis: 'b_basis',
  source: 'Tsai & Hahn 1980 via Kaw Table 2.1 (density illustrative)',
} as const;

export const AS4 = {
  name: 'AS4_3501_6',
  form: 'ud_tape',
  E1: 126000,
  E2: 11000,
  G12: 6600,
  nu12: 0.28,
  Xt: 1950,
  Xc: 1480,
  Yt: 48,
  Yc: 200,
  S: 79,
  plyThickness: 0.125,
  density: 0.0016,
  basis: 'mean',
  source: 'Soden, Hinton & Kaddour 1998 (WWFE lamina data)',
} as const;

export const ROSETTE = { name: 'R0', origin: [0, 0, 0], axis0: [1, 0, 0], normal: [0, 0, 1], method: 'translational' } as const;

/** Both validation materials in an empty mm document. */
export function withMaterials(): CadDocument {
  let doc = apply(createEmptyDocument(), 'set_units', { units: 'mm' });
  doc = apply(doc, 'create_lamina_material', T300);
  return apply(doc, 'create_lamina_material', AS4);
}

export interface Panel {
  readonly doc: CadDocument;
  readonly tool: string;
  readonly part: string;
}

/** The draft plan `cmp-flat-panel-zones` up to the zones: a 600 x 400 x 10 tool block, rosette R0 and the part on its top face. */
export function panelPart(): Panel {
  let doc = withMaterials();
  const tool = ok(doc, 'add_box', { size: [600, 400, 10], anchor: 'min', position: [0, 0, -10] });
  doc = tool.document;
  doc = apply(doc, 'define_rosette', ROSETTE);
  const part = ok(doc, 'create_composite_part', {
    name: 'Skin panel',
    toolSurface: { entityId: tool.affected[0], faceNear: [300, 200, 0] },
    rosette: 'R0',
  });
  return { doc: part.document, tool: tool.affected[0] as string, part: part.affected[0] as string };
}

export const BASE = {
  name: 'Z-base',
  boundary: [
    [0, 0],
    [600, 0],
    [600, 400],
    [0, 400],
  ],
  laminate: '[45/-45/0/90]s',
  priority: 0,
} as const;
export const PAD = {
  name: 'Z-pad',
  boundary: [
    [200, 100],
    [400, 100],
    [400, 300],
    [200, 300],
  ],
  laminate: '[45/-45/0/90/0/-45/45/0]s',
  priority: 1,
} as const;
export const HOLE = {
  name: 'Z-hole',
  boundary: [
    [260, 160],
    [340, 160],
    [340, 240],
    [260, 240],
  ],
  laminate: '[45/-45/0/90/0/-45/45/0/45/-45/0/90]s',
  priority: 2,
} as const;

/** The flat panel with its three zones and plies generated (8 / 16 / 24 plies, ramp 20:1). */
export function panel(): Panel {
  const base = panelPart();
  let doc = base.doc;
  for (const zone of [BASE, PAD, HOLE]) doc = apply(doc, 'define_zone', { part: base.part, ...zone });
  doc = apply(doc, 'set_ply_drop_rules', {
    part: base.part,
    rampRatio: 20,
    minStagger: 3,
    staggerUnit: 'dropped_thickness',
    dropOrder: 'inner_first',
    coverPlies: 2,
  });
  doc = apply(doc, 'generate_plies_from_zones', { part: base.part, material: 'T300_5208', sequencePrefix: 'S' });
  return { doc, tool: base.tool, part: base.part };
}
