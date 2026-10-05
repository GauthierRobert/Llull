import { execute } from '@core/commands/registry';
import { createEmptyDocument, type CadDocument } from '@core/model/types';
import type { SteelMemberElement } from '@core/model/building';
import { checkSteelMembers } from '@aec/industrial/steelMembersCheck';
import type { MemberRow } from '@aec/industrial/steelMemberRows';

/** Gravity used by the model, m/s². */
export const G = 9.80665;

export function step(doc: CadDocument, tool: string, args: Record<string, unknown>): CadDocument {
  const result = execute(doc, tool, args);
  if (result.document === doc) throw new Error(`${tool}: ${result.summary}`);
  return result.document;
}

/** Ground (level-1, +0) and floor (level-2, +3000) levels. */
export function twoLevels(): CadDocument {
  let doc = createEmptyDocument();
  doc = step(doc, 'add_level', { name: 'Ground', elevation: 0, height: 3000, makeActive: false });
  return step(doc, 'add_level', {
    name: 'Floor',
    elevation: 3000,
    height: 3000,
    makeActive: false,
  });
}

export const column = (
  doc: CadDocument,
  x: number,
  y: number,
  profile = 'HEB200',
  top = 3000,
): CadDocument =>
  step(doc, 'add_steel_member', {
    role: 'column',
    profile,
    start: [x, y, 0],
    end: [x, y, top],
    levelId: 'level-1',
  });

/** Beam on level-2 whose top of steel sits 30 mm under the floor (grating). */
export const beam = (
  doc: CadDocument,
  from: [number, number],
  to: [number, number],
  profile = 'IPE300',
  depth = 300,
): CadDocument =>
  step(doc, 'add_steel_member', {
    role: 'beam',
    profile,
    start: [...from, -30 - depth / 2],
    end: [...to, -30 - depth / 2],
    levelId: 'level-2',
  });

export const brace = (
  doc: CadDocument,
  from: [number, number, number],
  to: [number, number, number],
  profile = 'CHS139.7x5',
): CadDocument =>
  step(doc, 'add_steel_member', {
    role: 'brace',
    profile,
    start: from,
    end: to,
    levelId: 'level-1',
  });

/** Square bay 6 m × 6 m: four HEB200 columns, four IPE300 beams, optional grating slab. */
export function squareBay(options: { slab?: boolean; equipmentKg?: number } = {}): CadDocument {
  const corners: Array<[number, number]> = [
    [0, 0],
    [6000, 0],
    [6000, 6000],
    [0, 6000],
  ];
  let doc = twoLevels();
  for (const [x, y] of corners) doc = column(doc, x, y);
  corners.forEach((corner, index) => {
    doc = beam(doc, corner, corners[(index + 1) % 4] as [number, number]);
  });
  if (options.slab !== false) {
    doc = step(doc, 'add_slab', {
      levelId: 'level-2',
      boundary: corners,
      thickness: 30,
      material: 'grating',
    });
  }
  if (options.equipmentKg !== undefined) {
    doc = step(doc, 'add_equipment', {
      name: 'Pump skid',
      mark: 'E-1',
      levelId: 'level-2',
      location: [3000, 3000],
      size: [2000, 2000, 1000],
      weight: options.equipmentKg,
    });
  }
  return doc;
}

export interface CheckData {
  ok: boolean;
  members: MemberRow[];
  totals: { members: number; analysed: number; notAnalysed: number; failing: number };
  warnings: string[];
  loads: {
    floors: Array<{ areaM2: number; deadKn: number; imposedKn: number; supportingBeams: number }>;
    equipment: Array<{ mark: string; carriedKn: number; support: string }>;
    lines: Array<{ mark: string; supports: number; carriedKn: number; weightPerMetre: number }>;
  };
  storeys: Array<{ shear: number; verticalLoad: number }>;
}

export function check(doc: CadDocument, params: Record<string, unknown> = {}): CheckData {
  return checkSteelMembers.run(doc, params).data as CheckData;
}

export function rowOf(data: CheckData, mark: string): MemberRow {
  const row = data.members.find((member) => member.mark === mark);
  if (!row) throw new Error(`no row for ${mark}`);
  return row;
}

export function rowsByRole(data: CheckData, role: string): MemberRow[] {
  return data.members.filter((member) => member.role === role);
}

/** Replace a member's profile name without the catalogue check of the command. */
export function withMember(
  doc: CadDocument,
  mark: string,
  patch: Partial<SteelMemberElement>,
): CadDocument {
  const building = doc.building;
  if (!building) throw new Error('no building');
  const entry = Object.values(building.elements).find(
    (element): element is SteelMemberElement =>
      element.category === 'member' && element.mark === mark,
  );
  if (!entry) throw new Error(`no member ${mark}`);
  return {
    ...doc,
    building: {
      ...building,
      elements: { ...building.elements, [entry.id]: { ...entry, ...patch } },
    },
  };
}
